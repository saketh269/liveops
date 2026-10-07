import type { ConnectorSpec } from "../../api/types";

const CATEGORY_LABELS: Record<ConnectorSpec["category"], string> = {
  database: "Databases",
  warehouse: "Data warehouses",
  stream: "Streams",
  api: "APIs and webhooks",
  file: "Files",
  federation: "Federated query",
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as ConnectorSpec["category"][];

const MODE_LABELS: Record<string, string> = { poll: "Polls for changes", cdc: "Reads the change log", push: "Receives pushed events" };

export function MaturityBadge({ maturity }: { maturity: ConnectorSpec["maturity"] }) {
  if (maturity === "stable") return null;
  if (maturity === "beta") return <span className="pill warn" title="Works, but may change">Beta</span>;
  return (
    <span className="pill warn" title="Built and unit tested, but not yet run against a real server">
      Not yet tested on a real server
    </span>
  );
}

export function ConnectorPicker({ connectors, onPick }: { connectors: ConnectorSpec[]; onPick: (c: ConnectorSpec) => void }) {
  const groups = CATEGORY_ORDER
    .map((cat) => ({ cat, items: connectors.filter((c) => c.category === cat) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="stack">
      {groups.map((g) => (
        <section className="picker-group" key={g.cat} aria-labelledby={`cat-${g.cat}`}>
          <h3 id={`cat-${g.cat}`}>{CATEGORY_LABELS[g.cat] ?? g.cat}</h3>
          <div className="card-list">
            {g.items.map((c) => (
              <button type="button" key={c.type} className="picker-option" onClick={() => onPick(c)}>
                <span className="card-head">
                  <span className="name">{c.display_name}</span>
                  <MaturityBadge maturity={c.maturity} />
                </span>
                {c.description && <span className="desc">{c.description}</span>}
                <span className="meta">{c.modes.map((m) => MODE_LABELS[m] ?? m).join(" · ")}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
