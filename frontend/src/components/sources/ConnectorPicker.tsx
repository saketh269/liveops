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

/** How fresh the map will be, in the user's words. Live (cdc/push) wins over polling. */
export function ModeBadge({ modes }: { modes: ConnectorSpec["modes"] }) {
  if (modes.includes("cdc")) {
    return <span className="pill info" title="Reads the database's change log: changes appear within a second or two">Live changes</span>;
  }
  if (modes.includes("push")) {
    return <span className="pill info" title="Your system sends changes to Live Ops as they happen">Pushed live</span>;
  }
  return <span className="pill" title="Live Ops checks for changes every few seconds">Checks every few seconds</span>;
}

const MODE_LABELS: Record<string, string> = {
  poll: "Checks for changes every few seconds",
  cdc: "Streams each change as it is committed",
  push: "Receives changes as your system sends them",
};

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
                  <span className="badges">
                    <ModeBadge modes={c.modes} />
                    <MaturityBadge maturity={c.maturity} />
                  </span>
                </span>
                {c.description && <span className="desc">{c.description}</span>}
                <span className="meta">{c.modes.map((m) => MODE_LABELS[m] ?? m).join("; or ")}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
