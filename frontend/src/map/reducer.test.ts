import type { Asset, StreamMessage } from "../api/types";
import { FEED_CAP, diffAsset, initialMapState, reduce, reduceAll } from "./reducer";

const asset = (id: string, extra: Partial<Asset> = {}): Asset => ({
  site_id: "s1", asset_id: id, updated_ts: 1, state: "free", zone: "ICU", kind: "bed", label: `Bed ${id}`,
  _sources: { state: "ehr", zone: "ehr", label: "ehr", kind: "ehr" }, ...extra,
});
const msg = (type: StreamMessage["type"], assets: Asset[], ts = 10, event: Record<string, unknown> | null = null): StreamMessage =>
  ({ type, site_id: "s1", assets, event, ts });

describe("reducer", () => {
  test("snapshot replaces all assets and creates no feed entries", () => {
    let s = reduce(initialMapState(), msg("snapshot", [asset("A"), asset("B")]));
    expect([...s.assets.keys()]).toEqual(["A", "B"]);
    s = reduce(s, msg("snapshot", [asset("C")]));
    expect([...s.assets.keys()]).toEqual(["C"]);
    expect(s.feed).toEqual([]);
    expect(s.snapshotReceived).toBe(true);
  });

  test("upsert adds or replaces and derives field-change entries tagged by source", () => {
    let s = reduce(initialMapState(), msg("snapshot", [asset("A")]));
    const before = s;
    s = reduce(s, msg("upsert", [asset("A", { state: "in_use", _sources: { state: "housekeeping" } })], 11));
    expect(before.assets.get("A")!.state).toBe("free"); // previous state untouched (pure)
    expect(s.assets.get("A")!.state).toBe("in_use");
    expect(s.feed).toHaveLength(1);
    expect(s.feed[0]).toMatchObject({ kind: "change", source: "housekeeping", assetId: "A", ts: 11 });
    expect(s.feed[0].text).toBe("Bed A: state free → in_use");

    s = reduce(s, msg("upsert", [asset("N")], 12));
    expect(s.feed[0]).toMatchObject({ kind: "added", assetId: "N" });
    expect(s.feed[1].kind).toBe("change"); // newest first
  });

  test("unchanged upsert produces no entry; attribute changes are reported per key", () => {
    let s = reduce(initialMapState(), msg("snapshot", [asset("A", { attributes: { patients: 1 } })]));
    s = reduce(s, msg("upsert", [asset("A", { attributes: { patients: 1 } })]));
    expect(s.feed).toEqual([]);
    s = reduce(s, msg("upsert", [asset("A", { attributes: { patients: 2 }, _sources: { attributes: "ehr" } })]));
    expect(s.feed[0].text).toBe("Bed A: attributes.patients 1 → 2");
    expect(s.feed[0].source).toBe("ehr");
  });

  test("remove deletes the asset and ignores unknown ids", () => {
    let s = reduce(initialMapState(), msg("snapshot", [asset("A"), asset("B")]));
    s = reduce(s, msg("remove", [{ asset_id: "A" } as Asset, { asset_id: "Z" } as Asset]));
    expect([...s.assets.keys()]).toEqual(["B"]);
    expect(s.feed).toHaveLength(1);
    expect(s.feed[0]).toMatchObject({ kind: "removed", text: "Bed A removed" });
  });

  test("server events are used once present, and upserts stop producing derived entries", () => {
    let s = reduce(initialMapState(), msg("snapshot", [asset("A")]));
    s = reduce(s, msg("event", [], 20, { message: "Bed 06 now in_use", source: "ehr", asset_id: "A" }));
    expect(s.serverEvents).toBe(true);
    expect(s.feed[0]).toMatchObject({ kind: "event", text: "Bed 06 now in_use", source: "ehr", assetId: "A", ts: 20 });
    s = reduce(s, msg("upsert", [asset("A", { state: "alert" })]));
    expect(s.assets.get("A")!.state).toBe("alert");
    expect(s.feed).toHaveLength(1);
  });

  test("feed is capped at 200, newest first", () => {
    let s = reduce(initialMapState(), msg("snapshot", [asset("A")]));
    const msgs: StreamMessage[] = [];
    for (let i = 0; i < 250; i++) msgs.push(msg("upsert", [asset("A", { state: i % 2 ? "free" : "busy" })], 100 + i));
    s = reduceAll(s, msgs.slice(0, 120));
    s = reduceAll(s, msgs.slice(120));
    expect(s.feed).toHaveLength(FEED_CAP);
    expect(s.feed[0].ts).toBe(349);
    expect(s.feed[FEED_CAP - 1].ts).toBe(150);
    expect(s.lastTs).toBe(349);
  });

  test("batch copies once and tolerates junk", () => {
    const s0 = initialMapState();
    const s = reduceAll(s0, [
      msg("snapshot", [asset("A")]),
      { type: "nope" } as unknown as StreamMessage,
      msg("upsert", [{} as Asset]),
    ]);
    expect(s.assets.size).toBe(1);
    expect(s0.assets.size).toBe(0);
    expect(reduceAll(s, [])).toBe(s);
  });

  test("diffAsset ignores metadata fields", () => {
    expect(diffAsset(asset("A"), asset("A", { updated_ts: 99, _sources: { state: "x" } }))).toEqual([]);
  });
});

test("pings do not move the last-update time (LIVEOPS-38)", () => {
  let s = reduce(initialMapState(), msg("snapshot", [], 10));
  s = reduce(s, { type: "ping", site_id: "s", assets: [], event: null, ts: 99 } as StreamMessage);
  expect(s.lastTs).toBe(10);
});

test("first server event replaces the derived entry for the same change (no duplicate)", () => {
  let s = reduce(initialMapState(), msg("snapshot", [asset("B03", { state: "free" })], 10));
  s = reduce(s, msg("upsert", [asset("B03", { state: "in_use" })], 11));
  expect(s.feed.length).toBe(1);
  s = reduce(s, { type: "event", site_id: "s", assets: [], ts: 11, event: { asset_id: "B03", text: "B03 state free → in_use", source_id: "src", ts: 11 } } as StreamMessage);
  expect(s.feed.map((f) => f.text)).toEqual(["B03 state free → in_use"]);
});
