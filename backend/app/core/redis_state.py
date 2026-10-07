"""Redis state store: same semantics as ``InMemoryStateStore``, shared by
every backend process that points at the same Redis.

Layout (``P`` = key prefix, ``{S}`` = site id as a cluster hash tag, so all of
a site's keys live in one slot)::

    P:{S}:a:<asset_id>   hash   f:<field> -> value as JSON
                                s:<field> -> source id
                                m:<field> -> mapping id
                                t:<field> -> received ts (float as text)
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
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.core.eventlog import DEFAULT_MAXLEN, EventEntry, RedisEventLog
from app.core.events import Asset, AssetEvent, AssetOp, FieldValue, StreamMessage
from app.core.state import StateStore, event_messages

log = logging.getLogger("liveops.state.redis")

# KEYS: 1 asset hash, 2 site index, 3 event stream, 4 channel
# ARGV: 1 op, 2 site_id, 3 asset_id, 4 source_id, 5 mapping_id, 6 received_ts,
#       7 log maxlen, then pairs of (field name, value JSON) for upserts.
# Returns the published payload (JSON text) or false when nothing visible changed.
_APPLY_LUA = r"""
local akey, ikey, lkey, chan = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local op, site, asset, src, mapping, ts_s = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6]
local ts = tonumber(ts_s)
local enc = cjson.encode
local changes = {}
local removed = false

if op == 'remove' then
  local all = redis.call('HGETALL', akey)
  if #all == 0 then return false end
  local h = {}
  for i = 1, #all, 2 do h[all[i]] = all[i + 1] end
  for k, v in pairs(h) do
    if string.sub(k, 1, 2) == 'm:' and v == mapping then
      local name = string.sub(k, 3)
      table.insert(changes, enc(name) .. ':[' .. h['f:' .. name] .. ',null]')
      redis.call('HDEL', akey, 'f:' .. name, 's:' .. name, 'm:' .. name, 't:' .. name)
    end
  end
  if #changes == 0 then return false end
  if redis.call('HLEN', akey) == 0 then
    redis.call('DEL', akey)
    redis.call('ZREM', ikey, asset)
    removed = true
  end
else
  local changed = false
  for i = 7 + 1, #ARGV, 2 do
    local name, val = ARGV[i], ARGV[i + 1]
    local cur = redis.call('HMGET', akey, 'f:' .. name, 's:' .. name, 't:' .. name)
    if not (cur[3] and tonumber(cur[3]) > ts) then
      if (not cur[1]) or cur[1] ~= val then
        table.insert(changes, enc(name) .. ':[' .. (cur[1] or 'null') .. ',' .. val .. ']')
      end
      if (not cur[1]) or cur[1] ~= val or cur[2] ~= src then changed = true end
      redis.call('HSET', akey, 'f:' .. name, val, 's:' .. name, src, 'm:' .. name, mapping, 't:' .. name, ts_s)
    end
  end
  if not changed then return false end
end

local asset_json
local kind
if removed then
  kind = 'remove'
  asset_json = '{"asset_id":' .. enc(asset) .. '}'
else
  kind = 'upsert'
  redis.call('ZADD', ikey, ts, asset)
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
  redis.call('XADD', lkey, 'MAXLEN', '~', ARGV[7], '*', 'e', entry)
end

local payload = '{"kind":"' .. kind .. '","asset":' .. asset_json .. ',"event":' .. entry .. '}'
redis.call('PUBLISH', chan, payload)
return payload
"""


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
    first = StreamMessage(type=payload["kind"], site_id=site_id, assets=[payload["asset"]])
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
        self._log = RedisEventLog(redis, self._log_key)
        # pub/sub, owned by one reader task per process
        self._listening: dict[str, asyncio.Event] = {}  # site -> confirmed subscribed
        self._wake = asyncio.Event()
        self._subscribed: set[str] = set()  # sites the reader has SUBSCRIBEd on its connection
        self._resync_after_reconnect: set[str] = set()
        self._reader: asyncio.Task[None] | None = None
        self._closed = False

    @classmethod
    def from_url(cls, url: str, **kwargs: Any) -> RedisStateStore:
        client = aioredis.Redis.from_url(url, decode_responses=True, socket_connect_timeout=5, socket_timeout=10)
        return cls(client, **kwargs)

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
            for name, value in event.fields.items():
                args += [name, _dumps(value)]
        keys = [self._asset_key(s, a), self._index_key(s), self._log_key(s), self._channel(s)]
        raw = await self._apply_script(keys=keys, args=args)
        if not raw:
            return None
        # Subscribers in every process (this one included) get it via pub/sub.
        return _messages(s, json.loads(raw))[0]

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
        # The script is a no-op for assets this mapping contributed nothing to.
        for asset in await self.site_assets(site_id):
            if any(v.mapping_id == mapping_id for v in asset.fields.values()):
                await self.apply(
                    AssetEvent(
                        site_id=site_id,
                        asset_id=asset.asset_id,
                        op=AssetOp.REMOVE,
                        source_id="",
                        mapping_id=mapping_id,
                        dataset="",
                    )
                )

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
