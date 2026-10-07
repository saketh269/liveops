import { useState } from "react";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { Mapping, MappingHealth, Site, Source } from "../api/types";
import { MappingWizard } from "../components/mapping/MappingWizard";
import { timeAgo } from "../components/format";
import { ConfirmDelete, EmptyState, ErrorNotice, Loading, StatusPill } from "../components/ui";
import { useLoad } from "../components/useLoad";

export default function MappingPage() {
  return (
    <Routes>
      <Route index element={<MappingList />} />
      <Route path="new" element={<MappingEditor />} />
      <Route path=":mappingId/edit" element={<MappingEditor />} />
    </Routes>
  );
}

function useAll() {
  return useLoad(() => Promise.all([api.sites(), api.sources(), api.connectors(), api.mappings(), api.mappingHealth()]));
}

export function mappingStatus(m: Mapping, h?: MappingHealth): string {
  if (!m.active) return "paused";
  if (h && h.status !== "paused") return h.status;
  return m.running ? "running" : "starting";
}

function MappingRow({ m, source, health, onChanged }: { m: Mapping; source?: Source; health?: MappingHealth; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateMapping(m.id, { active: !m.active });
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const status = mappingStatus(m, health);
  return (
    <li className="panel card" aria-label={`Mapping ${m.dataset}`}>
      <div className="card-head">
        <h3 className="mono" style={{ fontSize: "0.95rem" }}>{m.dataset}</h3>
        <StatusPill status={status} />
      </div>
      <dl className="meta">
        <div><dt>Source</dt><dd>{source?.name ?? "Deleted source"}</dd></div>
        <div><dt>ID</dt><dd>{m.config.id_field}</dd></div>
        {m.config.match_key && m.config.match_key !== m.config.id_field && <div><dt>Match key</dt><dd>{m.config.match_key}</dd></div>}
        {m.config.kind && <div><dt>Kind</dt><dd>{m.config.kind}</dd></div>}
        {health && <div><dt>Last event</dt><dd>{timeAgo(health.last_event_ts)}</dd></div>}
      </dl>
      {status === "error" && health?.last_error && (
        <div className="notice bad">
          <strong>{health.last_error}</strong>
          {health.last_error_hint && <span>{health.last_error_hint}</span>}
        </div>
      )}
      {error !== null && <ErrorNotice error={error} title={m.active ? "Couldn't pause" : "Couldn't resume"} />}
      <div className="row-actions">
        <button type="button" className="btn" onClick={toggle} disabled={busy}>
          {busy ? "Saving…" : m.active ? "Pause" : "Resume"}
        </button>
        <Link className="btn" to={`/mapping/${m.id}/edit`}>Edit</Link>
      </div>
      <ConfirmDelete
        label="Delete mapping"
        what={`the mapping for ${m.dataset}`}
        consequence="Its assets disappear from the live map. The source and its data are not changed."
        onConfirm={async () => { await api.deleteMapping(m.id); onChanged(); }}
      />
    </li>
  );
}

function MappingList() {
  const { data, error, loading, reload } = useAll();
  const [params, setParams] = useSearchParams();
  const siteFilter = params.get("site") ?? "";
  const saved = params.get("saved");
  if (loading && !data) return <Loading label="Loading mappings…" />;
  if (!data) {
    return (
      <section className="stack">
        <h1>Mapping studio</h1>
        <ErrorNotice error={error} title="Couldn't load mappings" onRetry={reload} />
      </section>
    );
  }
  const [sites, sources, , mappings, health] = data;
  const healthById = new Map(health.map((h) => [h.mapping_id, h]));
  const shown: Site[] = siteFilter ? sites.filter((s) => s.id === siteFilter) : sites;
  const newLink = `/mapping/new${siteFilter ? `?site=${siteFilter}` : ""}`;
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Mapping studio</h1>
          <p className="lead">A mapping turns the records of one table into assets on a site's live map.</p>
        </div>
        {sites.length > 0 && sources.length > 0 && <Link className="btn primary" to={newLink}>New mapping</Link>}
      </div>
      {error !== null && <ErrorNotice error={error} title="Couldn't refresh" onRetry={reload} />}
      {saved && (
        <div className="notice info" role="status">
          Mapping saved{saved === "started" ? " and started" : ""}. Check it on the <Link to="/health">Health</Link> page
          {siteFilter && <> or open the <Link to={`/map/${siteFilter}`}>live map</Link></>}.
        </div>
      )}
      {sources.length === 0 && (
        <EmptyState title="Connect a source first" action={<Link className="btn primary" to="/sources/new">Connect a source</Link>}>
          A mapping reads from a source. Connect one, test it, then come back here.
        </EmptyState>
      )}
      {sources.length > 0 && sites.length === 0 && (
        <EmptyState title="Create a site first" action={<Link className="btn primary" to="/sites">Go to Sites</Link>}>
          A mapping shows records on a site's map. Create a site, then come back here.
        </EmptyState>
      )}
      {sites.length > 1 && (
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="site-filter">Show site</label>
          <select id="site-filter" value={siteFilter} onChange={(e) => setParams(e.target.value ? { site: e.target.value } : {})}>
            <option value="">All sites</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}
      {sources.length > 0 && shown.map((site) => {
        const ms = mappings.filter((m) => m.site_id === site.id);
        return (
          <section key={site.id} className="stack-sm" aria-label={`Mappings for ${site.name}`}>
            <div className="card-head">
              <h2>{site.name}</h2>
              <div className="row-actions">
                <Link className="btn link" to={`/map/${site.id}`}>Live map</Link>
                <Link className="btn" to={`/mapping/new?site=${site.id}`}>Add mapping</Link>
              </div>
            </div>
            {ms.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No mappings yet. Add one to show this site's assets on its map.</p>
            ) : (
              <ul className="card-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {ms.map((m) => (
                  <MappingRow key={m.id} m={m} source={sources.find((s) => s.id === m.source_id)} health={healthById.get(m.id)} onChanged={reload} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </section>
  );
}

function MappingEditor() {
  const { mappingId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useAll();
  const title = mappingId ? "Edit mapping" : "New mapping";
  if (loading && !data) return <Loading label="Loading…" />;
  if (!data) {
    return (
      <section className="stack">
        <h1>{title}</h1>
        <ErrorNotice error={error} title="Couldn't load sites and sources" onRetry={reload} />
      </section>
    );
  }
  const [sites, sources, connectors, mappings] = data;
  const existing = mappingId ? mappings.find((m) => m.id === mappingId) : undefined;
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="lead">Pick a table, check a sample of its records, and tell Live Ops which columns mean what.</p>
        </div>
        <Link className="btn" to="/mapping">Back to mappings</Link>
      </div>
      {mappingId && !existing ? (
        <ErrorNotice error={new Error("This mapping doesn't exist any more.")} title="Mapping not found" />
      ) : sites.length === 0 || sources.length === 0 ? (
        <EmptyState title={sources.length === 0 ? "Connect a source first" : "Create a site first"}
          action={<Link className="btn primary" to={sources.length === 0 ? "/sources/new" : "/sites"}>{sources.length === 0 ? "Connect a source" : "Go to Sites"}</Link>}>
          A mapping needs at least one site and one source.
        </EmptyState>
      ) : (
        <MappingWizard
          sites={sites}
          sources={sources}
          connectors={connectors}
          existing={existing}
          initialSiteId={params.get("site") ?? undefined}
          initialSourceId={params.get("source") ?? undefined}
          onSaved={(m) => navigate(`/mapping?site=${m.site_id}&saved=${m.active ? "started" : "1"}`)}
          onCancel={() => navigate("/mapping")}
        />
      )}
    </section>
  );
}
