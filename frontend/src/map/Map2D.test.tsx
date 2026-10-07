import { act, render } from "@testing-library/react";
import type { Asset, SiteLayout } from "../api/types";
import Map2D from "./Map2D";
import { placeAssets } from "./placement";

// Synthetic records for tests only.
const layout: SiteLayout = {
  width: 40, depth: 20,
  zones: [
    { id: "A", name: "A", polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    { id: "B", name: "B", polygon: [[30, 0], [40, 0], [40, 10], [30, 10]] },
  ],
};
const rec = (id: string, zone: string, extra: Partial<Asset> = {}): Asset =>
  ({ site_id: "s", asset_id: id, updated_ts: 1, zone, state: "free", kind: "staff", role: "nurse", _sources: {}, ...extra });
const map = (...list: Asset[]) => new Map(list.map((a) => [a.asset_id, a]));
const at = (id: string) => document.querySelector(`[data-asset="${id}"]`)!;
const xy = (id: string) => {
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(at(id).getAttribute("transform") ?? "")!;
  return [Number(m[1]), Number(m[2])];
};
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

function setup(first: Map<string, Asset>, props: { motion?: boolean } = {}) {
  const onDeparting = vi.fn();
  const base = { layout, selectedId: null, onSelect: () => {}, onHover: () => {}, onDeparting, ...props };
  const r = render(<Map2D {...base} assets={first} ready />);
  return { onDeparting, update: (assets: Map<string, Asset>) => r.rerender(<Map2D {...base} assets={assets} ready />) };
}

test("each record gets the glyph for its kind and role", () => {
  setup(map(rec("n1", "A"), rec("b1", "A", { kind: "bed", role: undefined }), rec("x1", "B", { kind: "pump", role: undefined })));
  expect(at("n1").getAttribute("data-figure")).toBe("nurse");
  expect(at("b1").getAttribute("data-figure")).toBe("bed");
  expect(at("x1").getAttribute("data-figure")).toBe("other");
  expect(at("n1").getAttribute("class")).toContain("lm-s-free");
});

test("the snapshot is placed instantly; a zone change walks there over time", async () => {
  const { update } = setup(map(rec("n1", "A")));
  const p = placeAssets(layout, [rec("n1", "A")]).positions.get("n1")!;
  expect(xy("n1")).toEqual([p.x, p.y]);
  update(map(rec("n1", "B")));
  const target = placeAssets(layout, [rec("n1", "B")]).positions.get("n1")!;
  await wait(300);
  const [x] = xy("n1");
  expect(x).toBeGreaterThan(p.x);
  expect(x).toBeLessThan(target.x);
});

test("motion off: a zone change jumps", () => {
  const { update } = setup(map(rec("n1", "A")), { motion: false });
  update(map(rec("n1", "B")));
  const target = placeAssets(layout, [rec("n1", "B")]).positions.get("n1")!;
  expect(xy("n1")).toEqual([target.x, target.y]);
});

test("a removed record walks out with its final data", async () => {
  const { update, onDeparting } = setup(map(rec("n1", "A", { label: "Nurse Kim" }), rec("n2", "B")));
  update(map(rec("n2", "B")));
  expect(at("n1").getAttribute("class")).toContain("lm-asset--leaving");
  await wait(0);
  const last = onDeparting.mock.calls[onDeparting.mock.calls.length - 1][0] as Map<string, Asset>;
  expect(last.get("n1")?.label).toBe("Nurse Kim");
});
