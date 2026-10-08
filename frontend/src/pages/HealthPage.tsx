import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AppHealth, Mapping, MappingHealth, Site, Source } from "../api/types";
import { formatMs, timeAgo } from "../components/format";
import { EmptyState, ErrorNotice, Loading, StatusPill } from "../components/ui";
import { CanEdit } from "../auth/AuthProvider"; // auth-ui: hide edit controls for viewer/wallboard

export const HEALTH_POLL_MS = 5000;

type Snapshot = { app: AppHealth; health: MappingHealth[]; mappings: Mapping[]; sources: Source[]; sites: Site[]; at: number };

export default function HealthPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const [app, health, mappings, sources, sites] = await Promise.all([
          api.health(), api.mappingHealth(), api.mappings(), api.sources(), api.sites(),
        ]);
        if (stopped) return;
        setSnap({ app, health, mappings, sources, sites, at: Date.now() / 1000 });
        setError(null);
      } catch (e) {
        if (!stopped) setError(e);
      }
      if (!stopped) {
        setNow(Date.now() / 1000);
        timer.current = setTimeout(load, HEALTH_POLL_MS);
      }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer.current); };
  }, []);

  const mappingById = new Map(snap?.mappings.map((m) => [m.id, m]));
  const sourceName = (id: string) => snap?.sources.find((s) => s.id === id)?.name ?? "Deleted source";
  const siteName = (id?: string) => snap?.sites.find((s) => s.id === id)?.name;
  // Show every mapping: those the runner knows about, plus paused ones it doesn't.
  const rows: MappingHealth[] = snap ? [
    ...snap.health,
    ...snap.mappings.filter((m) => !snap.health.some((h) => h.mapping_id === m.id)).map((m): MappingHealth => ({
      mapping_id: m.id, source_id: m.source_id, status: m.active ? "starting" : "paused", last_event_ts: null,
      events_total: 0, events_per_min: 0, lag_ms_p95: null, skipped_records: 0, last_error: null, last_error_hint: null, last_error_ts: null,
    })),
  ] : [];

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Health</h1>
          <p className="lead">Is data flowing? Refreshes every {HEALTH_POLL_MS / 1000} seconds.</p>
        </div>
        {snap && <span className="muted" aria-live="polite">Updated {timeAgo(snap.at, now)}</span>}
      </div>

      {error !== null && (
        <ErrorNotice error={error} title={snap ? "Lost contact with the server; showing the last known state" : "Couldn't load health"} />
      )}
      {!snap && error === null && <Loading label="Checking health…" />}

      {snap && (
        <div className="panel app-health" aria-label="App health">
          <StatusPill status={snap.app.ok ? "ok" : "error"} />
          <span><strong>Live Ops</strong> <span className="mono">v{snap.app.version}</span></span>
          <span className="muted">
            Portal database: {snap.app.portal_db === "unreachable" ? "unreachable. Check LIVEOPS_DATABASE_URL and that Postgres is running." : "ok"}
          </span>
        </div>
      )}

      {snap && rows.length === 0 && (
        <EmptyState title="No mappings yet" action={<CanEdit><Link className="btn primary" to="/mapping/new">Create a mapping</Link></CanEdit>}>
          Health shows each mapping once it exists. Create one in the Mapping studio to start reading data.
        </EmptyState>
      )}

      {rows.length > 0 && (
        <ul className="card-list" style={{ listStyle: "none", padding: 0, margin: 0 }} aria-label="Mapping health">
          {rows.map((h) => {
            const m = mappingById.get(h.mapping_id);
            const site = siteName(m?.site_id);
            return (
              <li key={h.mapping_id} className="panel health-row" aria-label={`Health of ${m?.dataset ?? h.mapping_id}`}>
                <div className="card-head">
                  <h2 className="mono" style={{ fontSize: "0.95rem", overflowWrap: "anywhere" }}>{m?.dataset ?? h.mapping_id}</h2>
                  <StatusPill status={h.status} />
                </div>
                <div className="meta">
                  <span>{sourceName(h.source_id)}</span>
                  {site && <span>→ {site}</span>}
                  <span>Last event {timeAgo(h.last_event_ts, now)}</span>
                </div>
                <dl className="stats">
                  <div><dt>Events / min</dt><dd>{h.events_per_min}</dd></div>
                  <div><dt>Lag p95</dt><dd>{formatMs(h.lag_ms_p95)}</dd></div>
                  <div><dt>Events total</dt><dd>{h.events_total}</dd></div>
                  <div><dt>Rows skipped (no ID)</dt><dd>{h.skipped_records}</dd></div>
                </dl>
                {h.skipped_records > 0 && (
                  <p className="muted" style={{ margin: 0 }}>
                    Some rows had no value in the ID or match key column, so they aren't on the map. Check the mapping's
                    ID column, or fill in the missing values in the source.
                  </p>
                )}
                {h.last_error && (
                  <div className={`notice ${h.status === "error" ? "bad" : ""}`}>
                    <strong>{h.status === "error" ? "Error" : "Last error"} {timeAgo(h.last_error_ts, now)}: {h.last_error}</strong>
                    <span>{h.last_error_hint || "Check the source on the Sources page and run Test connection."}</span>
                  </div>
                )}
                {m && (
                  <div className="row-actions">
                    <CanEdit><Link className="btn link" to={`/mapping/${m.id}/edit`}>Edit mapping</Link>
                    <Link className="btn link" to={`/sources/${h.source_id}`}>Test source</Link></CanEdit>
                    <Link className="btn link" to={`/map/${m.site_id}`}>Live map</Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
