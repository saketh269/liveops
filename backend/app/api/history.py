"""Asset history API: ``GET /api/sites/{site_id}/assets/{asset_id}/history``.

Turns the rows written by ``app.core.history`` into a timeline people can read:
each step says where the record was (zone, bed, floor), its status, how long it
stayed, and one plain sentence ("Moved from ED Waiting Room to ED-02").
Changes from records attached through a match key (a cleaning task on a bed, a
transport request on a patient) appear in the parent's history, named after
their dataset.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import re
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select

from app.api.deps import state_store
from app.config import get_settings
from app.core.history import context_of
from app.core.state import StateStore
from app.db import AssetHistory, Mapping, Site, Source, new_session

router = APIRouter(tags=["history"])

DEFAULT_LIMIT = 500
MAX_LIMIT = 5000

# Plain labels for source timestamps (anything else: the key, humanized).
MILESTONE_LABELS = {
    "admit_time": "Admitted",
    "arrival_time": "Arrived",
    "arrived_at": "Arrived",
    "triage_time": "Triaged",
    "status_since": "Status set",
    "state_since": "Status set",
    "created_at": "Created",
    "started_at": "Started",
    "completed_at": "Completed",
    "assigned_at": "Assigned",
    "discharge_time": "Discharged",
    "discharged_at": "Discharged",
    "expected_discharge": "Expected discharge",
    "badge_last_seen": "Badge last seen",
}


def humanize(value: Any) -> str:
    """'waiting_for_provider' -> 'Waiting for provider'; 'AT_HOSPITAL_OFFLOADING' -> 'At hospital offloading'.
    Ids and names ('ED-02', 'Radiology – MRI') stay as they are."""
    if value is None or value == "":
        return "—"
    text = str(value)
    if re.fullmatch(r"[a-z]+([_\-][a-z]+)*", text) or re.fullmatch(r"[A-Z]+(_[A-Z]+)+", text):
        out = " ".join(w.lower() for w in re.split(r"[_\-]+", text))
        return out[:1].upper() + out[1:]
    return text


def dataset_label(dataset: str) -> str:
    """'/api/cleaning-tasks' or 'cleaning_tasks' -> 'Cleaning task'."""
    tail = dataset.rstrip("/").rsplit("/", 1)[-1].rsplit(".", 1)[-1] or dataset
    words = re.split(r"[_\-\s]+", tail.strip())
    if words and len(words[-1]) > 3 and words[-1].endswith("s") and not words[-1].endswith("ss"):
        words[-1] = words[-1][:-1]
    text = " ".join(w.lower() for w in words if w)
    return text[:1].upper() + text[1:] if text else "Linked record"


def fmt_minutes(seconds: float) -> str:
    """2520 -> '42 min'; 3900 -> '1 h 05 min'; 200000 -> '2 d 7 h'."""
    m = int(seconds // 60)
    if m < 1:
        return "under a minute"
    if m < 60:
        return f"{m} min"
    h = m // 60
    if h < 48:
        return f"{h} h {m % 60:02d} min"
    return f"{h // 24} d {h % 24} h"


def parse_ts(v: Any) -> float | None:
    """Epoch seconds from ISO text, epoch seconds or epoch milliseconds."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, int | float):
        return float(v) / 1000 if v > 1e12 else float(v) if v > 0 else None
    text = str(v).strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return parse_ts(float(text))
    try:
        d = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.UTC)
    return d.timestamp()


class Places:
    """Zone and floor names from the site layout."""

    def __init__(self, layout: dict[str, Any]) -> None:
        zones = [z for z in layout.get("zones") or [] if isinstance(z, dict) and z.get("id")]
        self.by_id = {str(z["id"]): z for z in zones}
        self.by_name = {str(z.get("name", "")).lower(): z for z in zones if z.get("name")}
        floors = [f for f in layout.get("floors") or [] if isinstance(f, dict) and f.get("id") is not None]
        self.floors = {str(f["id"]): str(f.get("name") or f["id"]) for f in floors}
        self.floor_by_name = {v.lower(): k for k, v in self.floors.items()}

    def zone(self, value: Any) -> dict[str, Any] | None:
        if value is None:
            return None
        text = str(value).strip()
        return self.by_id.get(text) or self.by_name.get(text.lower())

    def floor_id(self, value: Any) -> str | None:
        if value is None or value == "":
            return None
        text = str(value).strip()
        if text in self.floors:
            return text
        if text.lower() in self.floor_by_name:
            return self.floor_by_name[text.lower()]
        n = _number(text)  # "Floor 3", "3", 3.0
        if n is None:
            return None
        for fid, name in self.floors.items():
            if _number(fid) == n or _number(name) == n:
                return fid
        return None

    def place(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """Where a context puts the record: zone id/name, bed, floor."""
        raw_zone = ctx.get("zone")
        z = self.zone(raw_zone)
        floor_id = str(z["floor_id"]) if z and z.get("floor_id") is not None else self.floor_id(ctx.get("floor"))
        anchor = ctx.get("anchor")
        if floor_id is None and anchor is not None:
            az = self.zone(anchor)
            if az and az.get("floor_id") is not None:
                floor_id = str(az["floor_id"])
        return {
            "zone_id": str(z["id"]) if z else None,
            "zone": (str(z.get("name") or z["id"]) if z else (str(raw_zone) if raw_zone not in (None, "") else None)),
            "bed": str(anchor) if anchor not in (None, "") else None,
            "floor_id": floor_id,
            "floor": self.floors.get(floor_id, floor_id) if floor_id else None,
        }


def _number(text: str) -> int | None:
    m = re.search(r"-?\d+", text)
    return int(m.group()) if m else None


def _apply(ctx: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    out = dict(ctx)
    for k, (_, new) in changes.items():
        key = "status" if k == "attributes.status" else k
        if k.startswith("attributes.") and key != "status":
            continue
        if new is None:
            out.pop(key, None)
        else:
            out[key] = new
    return out


def _where(p: dict[str, Any]) -> str:
    return p["zone"] or (f"bed {p['bed']}" if p["bed"] else "an unknown place")


def build_history(
    rows: list[dict[str, Any]],
    *,
    places: Places,
    attached: dict[str, str],
    source_names: dict[str, str],
    present: bool,
    now: float,
    started_ts: float | None,
) -> list[dict[str, Any]]:
    """Readable timeline from stored rows (oldest first). ``attached`` maps the
    ids of match-key mappings (records attached to this one) to their label."""
    out: list[dict[str, Any]] = []
    ctx: dict[str, Any] = {}
    status: Any = None
    gone = True  # no earlier row = not on the map yet
    tasks: dict[str, Any] = {}  # attached mapping -> its last status, while its record is open
    for row in rows:
        changes: dict[str, list[Any]] = row.get("changes") or {}
        mapping = row.get("mapping_id") or ""
        source = source_names.get(row.get("source_id") or "", "")
        prev_place, prev_status = places.place(ctx), status
        is_attached = mapping in attached
        if not is_attached:
            ctx = dict(row["ctx"]) if row.get("ctx") is not None else _apply(ctx, changes)
            if "attributes.status" in changes:
                status = changes["attributes.status"][1]
            elif status is None:
                status = ctx.get("status") or ctx.get("state")
            ctx["status"] = status
        place = places.place(ctx)
        item: dict[str, Any] = {
            "ts": row["ts"],
            "source": source or None,
            "status": humanize(status) if status is not None else None,
            "status_raw": status,
            **place,
            "changes": changes,
        }
        if row.get("removed"):
            item["kind"] = "left"
            item["text"] = (
                f"Left the map: {source} no longer lists it (discharged, finished or moved off site)"
                if source
                else "Left the map: no source lists it any more"
            )
            gone = True
        elif is_attached:
            label = attached[mapping]
            st = changes.get("attributes.status")
            last = tasks.get(mapping)  # this attached record's own last status (the merged field may show another)
            item["kind"] = "task"
            item["task"] = label
            if row.get("op") == "remove" or all(b is None for _, b in changes.values()):
                was = last if last is not None else (st[0] if st else None)
                item["text"] = f"{label} closed" + (f" (was {humanize(was)})" if was is not None else "")
                tasks.pop(mapping, None)
                item["task_status"] = None
            else:
                if mapping not in tasks:
                    bits = [humanize(st[1])] if st and st[1] is not None else []
                    frm, to = changes.get("attributes.from"), changes.get("attributes.to")
                    if frm and to and frm[1] and to[1]:
                        bits.append(f"{frm[1]} → {to[1]}")
                    who = changes.get("attributes.assigned_to")
                    if who and who[1]:
                        bits.append(f"assigned to {who[1]}")
                    item["text"] = f"{label} opened" + (f": {', '.join(bits)}" if bits else "")
                elif st:
                    item["text"] = f"{label}: {humanize(last)} → {humanize(st[1])}"
                else:
                    parts = [
                        f"{k.removeprefix('attributes.').replace('_', ' ')} {b if b is not None else '—'}"
                        for k, (_, b) in sorted(changes.items())
                    ]
                    item["text"] = f"{label}: " + ", ".join(parts)
                if st:
                    tasks[mapping] = st[1]
                else:
                    tasks.setdefault(mapping, last)
                item["task_status"] = humanize(tasks[mapping]) if tasks.get(mapping) is not None else None
        elif gone:
            item["kind"] = "arrived"
            first = not out
            if first and started_ts is not None and row["ts"] - started_ts < 300:
                item["text"] = f"In {_where(place)} when Live Ops started watching"
            elif first:
                item["text"] = f"First seen in {_where(place)}"
            else:
                item["text"] = f"Back on the map in {_where(place)}"
            if item["status"]:
                item["text"] += f" · {item['status']}"
            gone = False
        else:
            moved = (place["zone"], place["bed"]) != (prev_place["zone"], prev_place["bed"])
            floor_changed = bool(
                place["floor_id"] and prev_place["floor_id"] and place["floor_id"] != prev_place["floor_id"]
            )
            status_changed = status != prev_status
            if moved and (place["zone"] != prev_place["zone"]):
                item["kind"] = "move"
                item["text"] = f"Moved from {_where(prev_place)} to {_where(place)}"
                if floor_changed:
                    item["text"] += f" ({prev_place['floor']} → {place['floor']})"
                    item["floor_change"] = {"from": prev_place["floor_id"], "to": place["floor_id"]}
                if status_changed:
                    item["text"] += f" · now {humanize(status)}"
            elif moved:
                item["kind"] = "move"
                item["text"] = f"Assigned to bed {place['bed']}" if place["bed"] else f"Left bed {prev_place['bed']}"
                if status_changed:
                    item["text"] += f" · now {humanize(status)}"
            elif status_changed:
                item["kind"] = "status"
                item["text"] = f"{humanize(prev_status)} → {humanize(status)}"
            else:
                other = {k: v for k, v in changes.items() if k in ("label", "role", "kind")}
                if not other:
                    continue  # nothing a person would notice (e.g. Live Ops restarted)
                item["kind"] = "update"
                item["text"] = ", ".join(f"{k} now {humanize(b)}" for k, (_, b) in sorted(other.items())).capitalize()
        out.append(item)
    _durations(out, present, now)
    return out


def _close(item: dict[str, Any], end: float, ongoing: bool, what: str) -> None:
    item["duration_s"] = max(0.0, end - item["ts"])
    item["ongoing"] = ongoing
    item["duration_text"] = f"{what} for {fmt_minutes(item['duration_s'])}" + (" so far" if ongoing else "")


def _durations(items: list[dict[str, Any]], present: bool, now: float) -> None:
    """How long each place and each status lasted; the current ones run until now."""
    place: dict[str, Any] | None = None  # the step that put the record where it is
    status: dict[str, Any] | None = None  # the status step still open
    for item in items:
        kind = item["kind"]
        if kind in ("arrived", "move", "left"):
            if place is not None:
                _close(place, item["ts"], False, f"in {_where(place)}")
            place = item if kind != "left" else None
        if status is not None and (kind == "left" or (kind != "task" and item["status_raw"] != status["status_raw"])):
            _close(status, item["ts"], False, str(status["status"]))
            status = None
        if kind == "status":
            status = item
    if present and place is not None:
        _close(place, now, True, f"in {_where(place)}")
    if present and status is not None:
        _close(status, now, True, str(status["status"]))


def milestones(rows: list[dict[str, Any]], source_names: dict[str, str]) -> list[dict[str, Any]]:
    """Timestamps the sources themselves report (admit_time, status_since, created_at…), each value once."""
    seen: dict[tuple[str, float], dict[str, Any]] = {}
    for row in rows:
        times = (row.get("ctx") or {}).get("times") or {}
        for key, value in times.items():
            ts = parse_ts(value)
            if ts is None:
                continue
            k = (str(key), round(ts, 3))
            if k not in seen:
                seen[k] = {
                    "key": key,
                    "label": MILESTONE_LABELS.get(key) or humanize(key),
                    "ts": ts,
                    "value": value,
                    "status": (row.get("ctx") or {}).get("status") if key in ("status_since", "state_since") else None,
                    "seen_ts": row["ts"],
                }
    return sorted(seen.values(), key=lambda m: m["ts"])


def _load(site_id: str, asset_id: str, since: float | None, until: float | None, limit: int) -> dict[str, Any] | None:
    with new_session() as s:
        site = s.get(Site, site_id)
        if site is None:
            return None
        q = select(AssetHistory).where(AssetHistory.site_id == site_id, AssetHistory.asset_id == asset_id)
        if since is not None:
            q = q.where(AssetHistory.ts > since)
        if until is not None:
            q = q.where(AssetHistory.ts <= until)
        got = list(s.scalars(q.order_by(AssetHistory.ts.desc(), AssetHistory.id.desc()).limit(limit + 1)))
        truncated = len(got) > limit
        got = list(reversed(got[:limit]))
        rows = [
            {
                "ts": r.ts,
                "op": r.op,
                "removed": r.removed,
                "source_id": r.source_id,
                "mapping_id": r.mapping_id,
                "changes": r.changes or {},
                "ctx": r.ctx,
            }
            for r in got
        ]
        # The context just before the window, so the first step knows where it came from.
        before = None
        if rows and (since is not None or truncated):
            prev = s.scalars(
                select(AssetHistory)
                .where(
                    AssetHistory.site_id == site_id, AssetHistory.asset_id == asset_id, AssetHistory.ts < rows[0]["ts"]
                )
                .order_by(AssetHistory.ts.desc())
                .limit(1)
            ).first()
            if prev is not None:
                before = {"ts": prev.ts, "removed": prev.removed, "ctx": prev.ctx}
        ever = (
            bool(rows)
            or s.scalar(
                select(AssetHistory.id)
                .where(AssetHistory.site_id == site_id, AssetHistory.asset_id == asset_id)
                .limit(1)
            )
            is not None
        )
        started = s.scalar(select(func.min(AssetHistory.ts)).where(AssetHistory.site_id == site_id))
        attached: dict[str, str] = {}
        for m in s.scalars(select(Mapping).where(Mapping.site_id == site_id)):
            cfg = m.config or {}
            if cfg.get("match_key") and cfg.get("match_key") != cfg.get("id_field"):
                attached[m.id] = dataset_label(m.dataset)
        source_names = {src.id: src.name for src in s.scalars(select(Source))}
        return {
            "layout": site.layout or {},
            "rows": rows,
            "before": before,
            "ever": ever,
            "truncated": truncated,
            "started": started,
            "attached": attached,
            "sources": source_names,
        }


@router.get("/api/sites/{site_id}/assets/{asset_id}/history")
async def asset_history(
    site_id: str,
    asset_id: str,
    since: float | None = Query(default=None, description="Only changes after this time (epoch seconds)"),
    until: float | None = Query(default=None, description="Only changes up to this time (epoch seconds)"),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT, description="Most steps to return (the latest ones)"),
    store: StateStore = Depends(state_store),
) -> dict[str, Any]:
    """Where the asset was, in which status, and for how long, oldest first.

    History starts when Live Ops started watching the site's sources
    (``history_since``); sources' own timestamps are in ``milestones``."""
    data = await asyncio.to_thread(_load, site_id, asset_id, since, until, limit)
    if data is None:
        raise HTTPException(404, detail={"message": "Site not found"})
    live = next((a for a in await store.site_assets(site_id) if a.asset_id == asset_id), None)
    if live is None and not data["ever"]:
        raise HTTPException(
            404,
            detail={
                "message": f"No record {asset_id!r} on this site",
                "hint": "It is not on the map now and Live Ops has no history for it.",
            },
        )
    rows = data["rows"]
    if data["before"] is not None:
        b = data["before"]
        # Seeds the context only; it is not part of the answer.
        rows = [{"ts": b["ts"], "removed": b["removed"], "mapping_id": "", "changes": {}, "ctx": b["ctx"] or {}}, *rows]
    now = time.time()
    places = Places(data["layout"])
    items = build_history(
        rows,
        places=places,
        attached=data["attached"],
        source_names=data["sources"],
        present=live is not None,
        now=now,
        started_ts=data["started"],
    )
    if data["before"] is not None and items and items[0]["ts"] == data["before"]["ts"]:
        items = items[1:]
    current = places.place(context_of(live.flat())) if live is not None else None
    return {
        "site_id": site_id,
        "asset_id": asset_id,
        "present": live is not None,
        "current": current,
        "history_since": data["started"],
        "retention_days": get_settings().history_days,
        "truncated": data["truncated"],
        "entries": items,
        "milestones": milestones(rows, data["sources"]),
        "now": now,
    }
