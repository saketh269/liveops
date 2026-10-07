import type { Asset, SiteLayout } from "../api/types";
import { resolveZone } from "./placement";
import { assetName, type FeedEntry } from "./reducer";
import { STATE_EXAMPLES, STATE_KEYS, STATE_LABELS, stateKey, type StateKey } from "./stateColors";

export function Swatch({ k }: { k: StateKey }) {
  return <span className={`lm-swatch lm-s-${k}`} aria-hidden="true" />;
}

type Counts = Record<StateKey, number>;
const zero = (): Counts => ({ free: 0, "in-use": 0, cleaning: 0, alert: 0, unknown: 0 });

export function countAssets(layout: SiteLayout, assets: ReadonlyMap<string, Asset>) {
  const byState = zero();
  const byZone = new Map<string, { name: string; counts: Counts; total: number }>();
  for (const z of layout.zones ?? []) byZone.set(z.id, { name: z.name || z.id, counts: zero(), total: 0 });
  const unassigned = { name: "Unassigned", counts: zero(), total: 0 };
  for (const a of assets.values()) {
    const k = stateKey(a.state);
    byState[k]++;
    const z = resolveZone(layout.zones ?? [], a.zone);
    const row = (z && byZone.get(z.id)) || unassigned;
    row.counts[k]++;
    row.total++;
  }
  const zones = [...byZone.values()];
  if (unassigned.total) zones.push(unassigned);
  return { byState, zones, total: assets.size };
}

export function KpiPanel({ layout, assets }: { layout: SiteLayout; assets: ReadonlyMap<string, Asset> }) {
  const { byState, zones, total } = countAssets(layout, assets);
  return (
    <section className="panel lm-panel" aria-labelledby="lm-kpi-h">
      <h2 id="lm-kpi-h">Status <span className="muted mono lm-total">{total} assets</span></h2>
      <ul className="lm-kpis">
        {STATE_KEYS.map((k) => (
          <li key={k} className="lm-kpi">
            <span className="lm-kpi-label"><Swatch k={k} /> {STATE_LABELS[k]}</span>
            <span className="lm-kpi-value mono" data-state={k}>{byState[k]}</span>
          </li>
        ))}
      </ul>
      <h3 className="lm-sub">By zone</h3>
      {zones.length === 0 ? (
        <p className="muted">No zones yet. Use Edit layout to draw them.</p>
      ) : (
        <table className="lm-zone-table">
          <thead>
            <tr><th scope="col">Zone</th><th scope="col" className="lm-num">Assets</th><th scope="col">Mix</th></tr>
          </thead>
          <tbody>
            {zones.map((z) => (
              <tr key={z.name}>
                <th scope="row">{z.name}</th>
                <td className="lm-num mono">{z.total}</td>
                <td>
                  <span className="lm-bar" role="img" aria-label={STATE_KEYS.filter((k) => z.counts[k]).map((k) => `${z.counts[k]} ${STATE_LABELS[k]}`).join(", ") || "empty"}>
                    {STATE_KEYS.map((k) => z.counts[k] ? <span key={k} className={`lm-s-${k}`} style={{ flexGrow: z.counts[k] }} /> : null)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Legend() {
  return (
    <section className="panel lm-panel" aria-labelledby="lm-legend-h">
      <h2 id="lm-legend-h">Legend</h2>
      <ul className="lm-legend">
        {STATE_KEYS.map((k) => (
          <li key={k}>
            <Swatch k={k} />
            <span><strong>{STATE_LABELS[k]}</strong> <span className="muted">{STATE_EXAMPLES[k].join(", ")}</span></span>
          </li>
        ))}
      </ul>
      <p className="muted lm-small">Shapes show the asset kind. A short pulse marks a state change. Assets whose zone is not in the layout sit in the Unassigned strip.</p>
    </section>
  );
}

const time = (ts: number) => new Date(ts * 1000).toLocaleTimeString();

export function EventFeed({ feed, onSelect, sourceNames = {} }: { feed: FeedEntry[]; onSelect: (id: string) => void; sourceNames?: Record<string, string> }) {
  return (
    <section className="panel lm-panel" aria-labelledby="lm-feed-h">
      <h2 id="lm-feed-h">Events <span className="muted mono lm-total">{feed.length}</span></h2>
      {feed.length === 0 ? (
        <p className="muted">No changes yet. Changes from your sources appear here as they happen.</p>
      ) : (
        <ol className="lm-feed" role="log" aria-live="off">
          {feed.map((e) => (
            <li key={e.id} className={`lm-feed-item lm-feed-${e.kind}`}>
              <span className="mono muted lm-feed-time">{time(e.ts)}</span>
              {e.source && <span className="pill" title={`Source ${e.source}`}>{sourceNames[e.source] ?? e.source}</span>}
              {e.assetId ? (
                <button type="button" className="lm-link" onClick={() => onSelect(e.assetId!)}>{e.text}</button>
              ) : (
                <span>{e.text}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function show(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function AssetDetails({ asset, layout, pinned, onClose, sourceNames = {} }: { asset: Asset; layout: SiteLayout; pinned: boolean; onClose: () => void; sourceNames?: Record<string, string> }) {
  const name = (id: string | undefined) => (id ? sourceNames[id] ?? id : "");
  const k = stateKey(asset.state);
  const src = asset._sources ?? {};
  const zone = resolveZone(layout.zones ?? [], asset.zone);
  const fields = Object.keys(asset).filter((f) => f !== "_sources" && f !== "attributes" && f !== "site_id").sort((a, b) =>
    a === "asset_id" ? -1 : b === "asset_id" ? 1 : a.localeCompare(b));
  const attrs = Object.entries(asset.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section className="panel lm-details" aria-labelledby="lm-details-h" aria-live="polite">
      <div className="lm-details-head">
        <h2 id="lm-details-h"><Swatch k={k} /> {assetName(asset)}</h2>
        {pinned && <button type="button" className="btn" onClick={onClose} aria-label="Close asset details">Close</button>}
      </div>
      <p className="muted lm-small">
        {STATE_LABELS[k]}{asset.state !== undefined ? ` (${show(asset.state)})` : ""} · {zone ? zone.name : "Unassigned"}
      </p>
      <table className="lm-fields">
        <thead><tr><th scope="col">Field</th><th scope="col">Value</th><th scope="col">Set by</th></tr></thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f}>
              <th scope="row" className="mono">{f}</th>
              <td className="mono">{f === "updated_ts" && typeof asset[f] === "number" ? `${time(asset[f] as number)}` : show(asset[f])}</td>
              <td className="muted">{name(src[f])}</td>
            </tr>
          ))}
          {attrs.map(([f, v]) => (
            <tr key={`a.${f}`}>
              <th scope="row" className="mono">attributes.{f}</th>
              <td className="mono">{show(v)}</td>
              {/* Each attribute key keeps its own source (LIVEOPS-51). */}
              <td className="muted">{name(src[`attributes.${f}`] ?? src.attributes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
