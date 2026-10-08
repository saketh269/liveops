"""Redis state store: same semantics as ``InMemoryStateStore``, shared by
every backend process that points at the same Redis.

Layout (``P`` = key prefix, ``{S}`` = site id as a cluster hash tag, so all of
a site's keys live in one slot)::

    P:{S}:a:<asset_id>   hash   f:<field> -> visible value as JSON
                                s:<field> -> its source id
                                m:<field> -> its mapping id
                                t:<field> -> its received ts (float as text)
                                c:<mapping>\x1f<field> -> that mapping's own
                                    contribution "ts\x1fseq\x1fsource\x1fvalue"
                                #seq -> apply counter (tie-break for equal ts)

    Visible = newest contribution (ties: applied last). When a mapping leaves,
    each field falls back to the next newest contribution (LIVEOPS-92).
    P:{S}:idx            zset   asset_id -> asset updated_ts
    P:{S}:log            stream event log, field "e" = entry JSON, MAXLEN ~
    P:{S}:ch             pub/sub channel for the site

One Lua script does the whole merge for one event (read current fields,
latest-wins compare, write, update index, append to the event log, PUBLISH),
so concurrent applies from any number of processes never lose fields and
every subscriber sees changes in the order Redis applied them. Values stay
opaque JSON strings inside Lua, so numbers are never rounded by cjson.

Each process holds one pub/sub connection, subscribed only to the sites that
have local WebSocket viewers, and fans messages out to them (see ``Fanout``).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.core.eventlog import DEFAULT_MAXLEN, EventEntry, RedisEventLog
from app.core.events import Asset, AssetEvent, AssetOp, FieldValue, StreamMessage, expand_attributes, fold_attributes
from app.core.state import StateStore, event_messages

log = logging.getLogger("liveops.state.redis")

# Shared by the apply and reconcile scripts. Values stay opaque JSON text.
_LUA_LIB = r"""
local enc = cjson.encode

local US = '\31'

-- "ts\31seq\31source\31value" -> ts (number), seq, ts text, source, value JSON
local function parse_c(v)
  local a = string.find(v, US, 1, true)
  local b = string.find(v, US, a + 1, true)
  local c = string.find(v, US, b + 1, true)
  local ts_s = string.sub(v, 1, a - 1)
  return tonumber(ts_s), tonumber(string.sub(v, a + 1, b - 1)), ts_s, string.sub(v, b + 1, c - 1), string.sub(v, c + 1)
end

-- Drop one mapping's contributions to one asset; fields it was showing fall
-- back to the newest remaining contribution. Returns (changes, empty,
-- visible_changed) or nil when the mapping contributed nothing.
local function remove_mapping(akey, mapping)
  local all = redis.call('HGETALL', akey)
  if #all == 0 then return nil end
  local h = {}
  for i = 1, #all, 2 do h[all[i]] = all[i + 1] end
  local pre = 'c:' .. mapping .. US
  local affected, best, any = {}, {}, false
  for k, v in pairs(h) do
    local p = string.sub(k, 1, 2)
    if p == 'c:' then
      if string.sub(k, 1, #pre) == pre then
        affected[string.sub(k, #pre + 1)] = true
        redis.call('HDEL', akey, k)
      else
        local sep = string.find(k, US, 3, true)
        local m, name = string.sub(k, 3, sep - 1), string.sub(k, sep + 1)
        local ts, seq, ts_s, src, val = parse_c(v)
        local b = best[name]
        if (not b) or ts > b[1] or (ts == b[1] and seq > b[2]) then best[name] = {ts, seq, ts_s, src, m, val} end
      end
    elseif p == 'm:' and v == mapping then
      affected[string.sub(k, 3)] = true  -- value written before contributions were kept
    end
  end
  if next(affected) == nil then return nil end
  local changes, visible = {}, false
  for name, _ in pairs(affected) do
    if h['m:' .. name] == mapping then
      local old, b = h['f:' .. name], best[name]
      if b then
        redis.call('HSET', akey, 'f:' .. name, b[6], 's:' .. name, b[4], 'm:' .. name, b[5], 't:' .. name, b[3])
        if b[6] ~= old then table.insert(changes, enc(name) .. ':[' .. old .. ',' .. b[6] .. ']') end
        if b[6] ~= old or b[4] ~= h['s:' .. name] then visible = true end
      else
        redis.call('HDEL', akey, 'f:' .. name, 's:' .. name, 'm:' .. name, 't:' .. name)
        table.insert(changes, enc(name) .. ':[' .. old .. ',null]')
        visible = true
      end
    end
  end
  for k, _ in pairs(h) do
    if string.sub(k, 1, 2) == 'f:' and redis.call('HEXISTS', akey, k) == 1 then any = true break end
  end
  if not any then
    for k, _ in pairs(best) do any = true break end
  end
  if not any then redis.call('DEL', akey) end
  return changes, not any, visible
end

-- After a visible change: update the site index, append to the event log,
-- PUBLISH the message for every process, and return it.
local function emit(akey, ikey, lkey, chan, site, asset, op, src, mapping, ts_s, maxlen, changes, removed)
  local asset_json, kind
  if removed then
    kind = 'remove'
    redis.call('ZREM', ikey, asset)
    asset_json = '{"asset_id":' .. enc(asset) .. '}'
  else
    kind = 'upsert'
    redis.call('ZADD', ikey, tonumber(ts_s), asset)
    local all = redis.call('HGETALL', akey)
    local vals, srcs = {}, {}
    for i = 1, #all, 2 do
      local p, name = string.sub(all[i], 1, 2), string.sub(all[i], 3)
      if p == 'f:' then
        table.insert(vals, enc(name) .. ':' .. all[i + 1])
      elseif p == 's:' then
        table.insert(srcs, enc(name) .. ':' .. enc(all[i + 1]))
      end
    end
    local body = '"site_id":' .. enc(site) .. ',"asset_id":' .. enc(asset) .. ',"updated_ts":' .. ts_s
    if #vals > 0 then body = body .. ',' .. table.concat(vals, ',') end
    asset_json = '{' .. body .. ',"_sources":{' .. table.concat(srcs, ',') .. '}}'
  end
  local entry = 'null'
  if #changes > 0 then
    local t = redis.call('TIME')
    local now = string.format('%d.%06d', tonumber(t[1]), tonumber(t[2]))
    entry = '{"ts":' .. now .. ',"site_id":' .. enc(site) .. ',"asset_id":' .. enc(asset)
      .. ',"op":' .. enc(op) .. ',"removed":' .. tostring(removed)
      .. ',"source_id":' .. enc(src) .. ',"mapping_id":' .. enc(mapping)
      .. ',"changes":{' .. table.concat(changes, ',') .. '}}'
    redis.call('XADD', lkey, 'MAXLEN', '~', maxlen, '*', 'e', entry)
  end
  local payload = '{"kind":"' .. kind .. '","asset":' .. asset_json .. ',"event":' .. entry .. '}'
  redis.call('PUBLISH', chan, payload)
  return payload
end
"""

# KEYS: 1 asset hash, 2 site index, 3 event stream, 4 channel
# ARGV: 1 op, 2 site_id, 3 asset_id, 4 source_id, 5 mapping_id, 6 received_ts,
#       7 log maxlen, then pairs of (field name, value JSON) for upserts.
# Returns the published payload (JSON text) or false when nothing visible changed.
_APPLY_LUA = (
    _LUA_LIB
    + r"""
local akey, ikey, lkey, chan = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local op, site, asset, src, mapping, ts_s, maxlen = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7]
local ts = tonumber(ts_s)

if op == 'remove' then
  local changes, empty, visible = remove_mapping(akey, mapping)
  if not changes or not (empty or visible) then return false end
  return emit(akey, ikey, lkey, chan, site, asset, op, src, mapping, ts_s, maxlen, changes, empty)
end

local changes = {}
local changed = false
local seq = nil
for i = 8, #ARGV, 2 do
  local name, val = ARGV[i], ARGV[i + 1]
  local ck = 'c:' .. mapping .. US .. name
  local own = redis.call('HGET', akey, ck)
  if not (own and parse_c(own) > ts) then
    if not seq then seq = redis.call('HINCRBY', akey, '#seq', 1) end
    redis.call('HSET', akey, ck, ts_s .. US .. seq .. US .. src .. US .. val)
    -- The new contribution has the highest seq: it is visible unless a newer ts is.
    local cur = redis.call('HMGET', akey, 'f:' .. name, 's:' .. name, 't:' .. name)
    if not (cur[3] and tonumber(cur[3]) > ts) then
      if (not cur[1]) or cur[1] ~= val then
        table.insert(changes, enc(name) .. ':[' .. (cur[1] or 'null') .. ',' .. val .. ']')
      end
      if (not cur[1]) or cur[1] ~= val or cur[2] ~= src then changed = true end
      redis.call('HSET', akey, 'f:' .. name, val, 's:' .. name, src, 'm:' .. name, mapping, 't:' .. name, ts_s)
    end
  end
end
if not changed then return false end
return emit(akey, ikey, lkey, chan, site, asset, op, src, mapping, ts_s, maxlen, changes, false)
"""
)

# Drop one mapping's fields from every asset of a site not in the keep list,
# in one call (LIVEOPS-40). Asset keys are built from ARGV[1]; they share the
# site's hash tag, so they live in the same cluster slot as KEYS.
# KEYS: 1 site index, 2 event stream, 3 channel
# ARGV: 1 asset key prefix, 2 site_id, 3 mapping_id, 4 ts, 5 log maxlen, 6.. asset ids to keep
# Returns the published payloads as one JSON array (one per touched asset).
_RECONCILE_LUA = (
    _LUA_LIB
    + r"""
local ikey, lkey, chan = KEYS[1], KEYS[2], KEYS[3]
local prefix, site, mapping, ts_s, maxlen = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5]
local keep = {}
for i = 6, #ARGV do keep[ARGV[i]] = true end
local out = {}
for _, asset in ipairs(redis.call('ZRANGE', ikey, 0, -1)) do
  if not keep[asset] then
    local akey = prefix .. asset
    local changes, empty, visible = remove_mapping(akey, mapping)
    if changes and (empty or visible) then
      table.insert(out, emit(akey, ikey, lkey, chan, site, asset, 'remove', '', mapping, ts_s, maxlen, changes, empty))
    end
  end
end
return '[' .. table.concat(out, ',') .. ']'
"""
)


# One consistent read of a whole site, returned as a single JSON document
# ([[asset_id, updated_ts, {field: [value, source, mapping, ts]}], ...]) so a
# 2,000-asset snapshot is one reply instead of 2,000.
# KEYS: 1 site index. ARGV: 1 asset key prefix.
_SNAPSHOT_LUA = r"""
local enc = cjson.encode
local ids = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
local out = {}
for i = 1, #ids, 2 do
  local all = redis.call('HGETALL', ARGV[1] .. ids[i])
  if #all > 0 then
    local h = {}
    for j = 1, #all, 2 do h[all[j]] = all[j + 1] end
    local fields = {}
    for k, v in pairs(h) do
      if string.sub(k, 1, 2) == 'f:' then
        local name = string.sub(k, 3)
        table.insert(fields, enc(name) .. ':[' .. v .. ',' .. enc(h['s:' .. name] or '') .. ','
          .. enc(h['m:' .. name] or '') .. ',' .. (h['t:' .. name] or '0') .. ']')
      end
    end
    table.insert(out, '[' .. enc(ids[i]) .. ',' .. ids[i + 1] .. ',{' .. table.concat(fields, ',') .. '}]')
  end
end
return '[' .. table.concat(out, ',') .. ']'
"""


def _dumps(value: Any) -> str:
    # Canonical form, so "same value" compares equal as text inside Lua.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False, default=str)


def _messages(site_id: str, payload: dict[str, Any]) -> list[StreamMessage]:
    asset = payload["asset"]
    if payload["kind"] == "upsert":
        asset = fold_attributes(asset)
    first = StreamMessage(type=payload["kind"], site_id=site_id, assets=[asset])
    return [first, *event_messages(site_id, payload["event"])]


class RedisStateStore(StateStore):
    def __init__(
        self,
        redis: aioredis.Redis,
        *,
        prefix: str = "liveops",
        queue_size: int = 1000,
        eventlog_maxlen: int = DEFAULT_MAXLEN,
    ) -> None:
        super().__init__(queue_size)
        if "{" in prefix or "}" in prefix:
            raise ValueError("Redis key prefix can't contain { or }; they are used as cluster hash tags")
        self._redis = redis
        self._prefix = prefix
        self._maxlen = eventlog_maxlen
        self._apply_script = redis.register_script(_APPLY_LUA)
        self._snapshot_script = redis.register_script(_SNAPSHOT_LUA)
        self._reconcile_script = redis.register_script(_RECONCILE_LUA)
        self._log = RedisEventLog(redis, self._log_key)
        # pub/sub, owned by one reader task per process
        self._listening: dict[str, asyncio.Event] = {}  # site -> confirmed subscribed
        self._wake = asyncio.Event()
        self._subscribed: set[str] = set()  # sites the reader has SUBSCRIBEd on its connection
        self._resync_after_reconnect: set[str] = set()
        self._reader: asyncio.Task[None] | None = None
        self._closed = False

    @classmethod
    def from_url(cls, url: str, *, max_connections: int = 200, **kwargs: Any) -> RedisStateStore:
        # A blocking pool: when every connection is busy, callers wait (up to
        # 5 s) for a free one instead of failing at once (LIVEOPS-53).
        pool = aioredis.BlockingConnectionPool.from_url(
            url,
            max_connections=max_connections,
            timeout=5,
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=5,
        )
        return cls(aioredis.Redis.from_pool(pool), **kwargs)

    # keys
    def _site(self, site_id: str) -> str:
        return f"{self._prefix}:{{{site_id}}}"

    def _asset_key(self, site_id: str, asset_id: str) -> str:
        return f"{self._site(site_id)}:a:{asset_id}"

    def _index_key(self, site_id: str) -> str:
        return f"{self._site(site_id)}:idx"

    def _log_key(self, site_id: str) -> str:
        return f"{self._site(site_id)}:log"

    def _channel(self, site_id: str) -> str:
        return f"{self._site(site_id)}:ch"

    # StateStore
    async def apply(self, event: AssetEvent) -> StreamMessage | None:
        s, a = event.site_id, event.asset_id
        args: list[str] = [
            event.op.value,
            s,
            a,
            event.source_id,
            event.mapping_id,
            repr(float(event.received_ts)),
            str(self._maxlen),
        ]
        if event.op == AssetOp.UPSERT:
            if not event.fields:
                return None
            fields = expand_attributes(event.fields)
            if not fields:
                return None
            for name, value in fields.items():
                args += [name, _dumps(value)]
        keys = [self._asset_key(s, a), self._index_key(s), self._log_key(s), self._channel(s)]
        raw = await self._apply_script(keys=keys, args=args)
        if not raw:
            return None
        payload = json.loads(raw)
        self._record_payload(payload)
        # Subscribers in every process (this one included) get it via pub/sub.
        return _messages(s, payload)[0]

    def _record_payload(self, payload: dict[str, Any]) -> None:
        """Hand the change to the durable history (the process that applied it records it)."""
        if payload.get("event") is not None:
            asset = fold_attributes(dict(payload["asset"])) if payload["kind"] == "upsert" else None
            self._record(payload["event"], asset)

    async def site_assets(self, site_id: str) -> list[Asset]:
        raw = await self._snapshot_script(keys=[self._index_key(site_id)], args=[f"{self._site(site_id)}:a:"])
        out = []
        for asset_id, updated_ts, fields in json.loads(raw):
            values = {
                name: FieldValue(value=value, source_id=src, mapping_id=mapping, updated_ts=float(ts))
                for name, (value, src, mapping, ts) in fields.items()
            }
            out.append(Asset(site_id=site_id, asset_id=asset_id, fields=values, updated_ts=float(updated_ts)))
        return out

    async def clear_mapping(self, site_id: str, mapping_id: str) -> None:
        await self.reconcile(site_id, mapping_id, set())

    async def reconcile(self, site_id: str, mapping_id: str, keep: set[str]) -> int:
        keys = [self._index_key(site_id), self._log_key(site_id), self._channel(site_id)]
        args = [f"{self._site(site_id)}:a:", site_id, mapping_id, repr(time.time()), str(self._maxlen), *keep]
        payloads = json.loads(await self._reconcile_script(keys=keys, args=args))
        for payload in payloads:
            self._record_payload(payload)
        return len(payloads)

    @property
    def redis(self) -> aioredis.Redis:
        return self._redis

    @property
    def prefix(self) -> str:
        return self._prefix

    async def events(self, site_id: str, since: float | None = None, limit: int = 100) -> list[EventEntry]:
        return await self._log.query(site_id, since, limit)

    async def close(self) -> None:
        self._closed = True
        if self._reader is not None:
            self._reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader
            self._reader = None
        await self._redis.aclose()

    # pub/sub
    async def _listen(self, site_id: str) -> None:
        confirmed = self._listening.setdefault(site_id, asyncio.Event())
        if site_id in self._subscribed:
            confirmed.set()  # still subscribed (an unsubscribe was pending, now cancelled)
        if self._reader is None or self._reader.done():
            self._reader = asyncio.create_task(self._read_loop(), name="redis-state-pubsub")
        self._wake.set()
        try:
            await asyncio.wait_for(confirmed.wait(), timeout=10)
        except TimeoutError as e:
            raise RuntimeError(
                "Couldn't subscribe to live updates in Redis within 10 s. Check that Redis is reachable "
                "(LIVEOPS_REDIS_URL) and not overloaded."
            ) from e

    async def _unlisten(self, site_id: str) -> None:
        if self._fanout.count(site_id) == 0:
            self._listening.pop(site_id, None)
            self._wake.set()

    async def _read_loop(self) -> None:
        """Owns the pub/sub connection: keeps its subscriptions equal to the
        sites with local viewers and fans messages out. Reconnects on errors
        and resyncs viewers, because messages may have been missed."""
        backoff = 0.5
        while not self._closed:
            pubsub = self._redis.pubsub()
            subscribed = self._subscribed
            subscribed.clear()
            had_error = False
            try:
                while not self._closed:
                    wanted = set(self._listening)
                    for site in wanted - subscribed:
                        await pubsub.subscribe(self._channel(site))
                        subscribed.add(site)
                    for site in subscribed - wanted:
                        subscribed.discard(site)
                        await pubsub.unsubscribe(self._channel(site))
                    if not subscribed:
                        self._wake.clear()
                        if not self._listening:
                            with contextlib.suppress(TimeoutError):
                                await asyncio.wait_for(self._wake.wait(), timeout=5)
                        continue
                    msg = await pubsub.get_message(timeout=0.1)
                    backoff = 0.5
                    if msg is not None:
                        self._handle(msg)
            except asyncio.CancelledError:
                raise
            except (RedisError, OSError) as e:
                had_error = True
                log.warning("Redis pub/sub connection failed (%s); reconnecting in %.1fs", e, backoff)
            finally:
                with contextlib.suppress(Exception):
                    await pubsub.aclose()
            if had_error:
                for ev in self._listening.values():
                    ev.clear()
                self._resync_after_reconnect = set(self._listening)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10.0)

    def _site_of(self, channel: str) -> str:
        # P:{site}:ch
        return channel[len(self._prefix) + 2 : -4]

    def _handle(self, msg: dict[str, Any]) -> None:
        kind, channel = msg.get("type"), str(msg.get("channel", ""))
        site = self._site_of(channel)
        if kind == "subscribe":
            ev = self._listening.get(site)
            if ev is not None:
                ev.set()
            if site in self._resync_after_reconnect:
                self._resync_after_reconnect.discard(site)
                self._fanout.resync(site)
        elif kind == "message":
            try:
                payload = json.loads(msg["data"])
            except (TypeError, ValueError):
                log.warning("Ignoring malformed state message on %s", channel)
                return
            for m in _messages(site, payload):
                self._fanout.publish(m)
