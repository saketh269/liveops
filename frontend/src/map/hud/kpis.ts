// KPI tiles for the top strip, chosen from what the live data contains.
// Every number is a count of live records; "longest"/"oldest" appear only when
// records carry a since-timestamp (see time.ts). Phase 2 adds timers and rules.
import type { Asset, Site } from "../../api/types";
import { assetName } from "../reducer";
import { STATE_LABELS, stateKey, type StateKey } from "../stateColors";
import { byAgeDesc, CLEANING_PIN_MINUTES, isAmbulance, isBed, isBoarding, isPatient, modelOf, plural, zoneOf, type Focus } from "./model";
import { ageOf, fmtDur, sayDur } from "./time";
import { FIGURE_LABELS } from "../figures";

export type KpiTone = "" | "warn" | "alert";

export type KpiTile = {
  id: string;
  label: string;
  value: number;
  /** Shown as "value / total". */
  total?: number;
  sub: string;
  tone: KpiTone;
  /** What a click shows: the worst item, or null to go back to the overview. */
  focus: Focus | null;
  /** Full sentence for assistive tech. */
  spoken: string;
};

function etaOf(a: Asset): number | null {
  const v = a.attributes?.eta_minutes ?? a.attributes?.eta ?? a.eta_minutes;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function oldest(list: Asset[], now: number): { asset: Asset | undefined; age: number | null } {
  const sorted = [...list].sort(byAgeDesc(now));
  const asset = sorted[0];
  return { asset, age: asset ? ageOf(asset, now) : null };
}

const focusOf = (a: Asset | undefined): Focus | null => (a ? { assetId: a.asset_id } : null);

/**
 * Tiles for the KPI strip. Hospital-style data (beds, patients, ambulances,
 * waiting zones) gets hospital tiles; anything else gets one tile per state.
 */
export function kpiDefinitions(site: Pick<Site, "layout">, assets: ReadonlyMap<string, Asset>, now = Date.now() / 1000): KpiTile[] {
  const layout = site.layout ?? {};
  const list = [...assets.values()];
  const beds = list.filter(isBed);
  const patients = list.filter(isPatient);
  const ambulances = list.filter(isAmbulance);
  const waitingZones = (layout.zones ?? []).filter((z) => z.kind === "waiting");
  const hospital = beds.length > 0 || patients.length > 0 || ambulances.length > 0;
  if (!hospital) return genericTiles(list, now);

  const tiles: KpiTile[] = [];
  /** Patients already counted as waiting or boarding are not counted again as alerts. */
  const waitingIds = new Set<string>();

  if (patients.length && waitingZones.length) {
    const byZone = new Map<string, Asset[]>();
    for (const p of patients) {
      const z = zoneOf(layout, p);
      if (z?.kind === "waiting") byZone.set(z.id, [...(byZone.get(z.id) ?? []), p]);
    }
    const waiting = [...byZone.values()].flat();
    for (const w of waiting) waitingIds.add(w.asset_id);
    const { age } = oldest(waiting, now);
    const busiest = [...byZone.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const zoneName = busiest ? (layout.zones ?? []).find((z) => z.id === busiest[0])?.name ?? busiest[0] : null;
    const sub = age !== null ? `longest ${fmtDur(age)}` : waiting.length === 0 ? "nobody waiting" : byZone.size === 1 ? `in ${zoneName}` : `in ${byZone.size} areas`;
    tiles.push({
      id: "waiting", label: "People waiting", value: waiting.length, sub, tone: "",
      focus: busiest ? { zoneId: busiest[0] } : null,
      spoken: `${plural(waiting.length, "patient")} in waiting areas${age !== null ? `, longest ${sayDur(age)}` : ""}`,
    });
  }

  if (patients.length) {
    const boarding = patients.filter((p) => isBoarding(p) && !waitingIds.has(p.asset_id));
    for (const b of boarding) waitingIds.add(b.asset_id);
    const { asset, age } = oldest(boarding, now);
    tiles.push({
      id: "boarding", label: "Boarding", value: boarding.length,
      sub: boarding.length === 0 ? "none" : age !== null ? `longest ${fmtDur(age)}` : `${plural(boarding.length, "patient")} held`,
      tone: boarding.length ? "warn" : "", focus: focusOf(asset),
      spoken: `${plural(boarding.length, "patient")} boarding${age !== null ? `, longest ${sayDur(age)}` : ""}`,
    });
  }

  {
    const alerts = list.filter((a) => stateKey(a.state) === "alert" && !waitingIds.has(a.asset_id));
    const { asset, age } = oldest(alerts, now);
    const kinds = new Map<string, number>();
    for (const a of alerts) {
      const k = FIGURE_LABELS[modelOf(a)].toLowerCase();
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    const mix = [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => plural(n, k)).join(" · ");
    tiles.push({
      id: "alerts", label: "Alerts", value: alerts.length,
      sub: alerts.length === 0 ? "none open" : age !== null ? `oldest ${fmtDur(age)}` : mix,
      tone: alerts.length ? "alert" : "", focus: focusOf(asset),
      spoken: `${plural(alerts.length, "record")} in alert${mix ? `: ${mix.replace(/ · /g, ", ")}` : ""}${waitingIds.size ? ", not counting people waiting or boarding" : ""}`,
    });
  }

  if (beds.length) {
    const dirty = beds.filter((b) => stateKey(b.state) === "cleaning");
    const { asset, age } = oldest(dirty, now);
    const late = age !== null && age > CLEANING_PIN_MINUTES * 60;
    tiles.push({
      id: "cleaning", label: "Dirty beds", value: dirty.length,
      sub: dirty.length === 0 ? "all clean" : age !== null ? `oldest ${fmtDur(age)}` : plural(dirty.length, "bed") + " waiting",
      tone: late ? "warn" : "", focus: focusOf(asset),
      spoken: `${plural(dirty.length, "bed")} waiting for cleaning${age !== null ? `, oldest ${sayDur(age)}` : ""}`,
    });
  }

  if (ambulances.length) {
    const busy = ambulances.filter((a) => stateKey(a.state) === "in-use");
    const withEta = busy.filter((a) => etaOf(a) !== null).sort((a, b) => etaOf(a)! - etaOf(b)!);
    if (withEta.length) {
      const next = etaOf(withEta[0])!;
      tiles.push({
        id: "ambulances", label: "Ambulances inbound", value: withEta.length, sub: `next ETA ${Math.round(next)} min`,
        tone: "warn", focus: focusOf(withEta[0]),
        spoken: `${plural(withEta.length, "ambulance")} inbound, next in ${Math.round(next)} minutes`,
      });
    } else {
      tiles.push({
        id: "ambulances", label: "Ambulances out", value: busy.length, sub: `of ${ambulances.length} in the fleet`,
        tone: "", focus: focusOf(busy[0]),
        spoken: `${busy.length} of ${plural(ambulances.length, "ambulance")} on a run`,
      });
    }
  }

  if (beds.length) {
    const used = beds.filter((b) => stateKey(b.state) === "in-use").length;
    const free = beds.filter((b) => stateKey(b.state) === "free").length;
    const pct = Math.round((used / beds.length) * 100);
    tiles.push({
      id: "beds", label: "Beds used", value: used, total: beds.length, sub: `${pct}% full · ${free} free`,
      tone: free === 0 ? "alert" : "", focus: null,
      spoken: `${used} of ${plural(beds.length, "bed")} in use, ${free} free`,
    });
  }
  return tiles;
}

const GENERIC: StateKey[] = ["in-use", "free", "cleaning", "alert"];

function genericTiles(list: Asset[], now: number): KpiTile[] {
  return GENERIC.map((k) => {
    const hits = list.filter((a) => stateKey(a.state) === k);
    const { asset, age } = oldest(hits, now);
    const problem = k === "alert" || k === "cleaning";
    return {
      id: `state-${k}`, label: STATE_LABELS[k], value: hits.length, total: k === "in-use" ? list.length : undefined,
      sub: age !== null && problem ? `oldest ${fmtDur(age)}`
        : hits.length && problem ? `e.g. ${assetName(asset!)}`
        : k === "in-use" ? `${list.length ? Math.round((hits.length / list.length) * 100) : 0}% of assets`
        : `of ${plural(list.length, "asset")}`,
      tone: k === "alert" && hits.length ? "alert" : "", focus: problem ? focusOf(asset) : null,
      spoken: `${hits.length} of ${plural(list.length, "asset")} ${STATE_LABELS[k].toLowerCase()}`,
    } satisfies KpiTile;
  });
}
