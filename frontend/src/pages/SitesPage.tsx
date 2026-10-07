import { useState, type FormEvent } from "react";
import { Link, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { Mapping, Site } from "../api/types";
import { formatDate } from "../components/format";
import { SetupFromSource } from "../components/setup/SetupFromSource";
import { ConfirmDelete, EmptyState, ErrorNotice, Loading } from "../components/ui";
import { useLoad } from "../components/useLoad";

export const TEMPLATES: { id: string; label: string; help: string }[] = [
  { id: "hospital", label: "Hospital", help: "Wards and beds" },
  { id: "warehouse", label: "Warehouse", help: "Docks, aisles and trucks" },
  { id: "farm", label: "Farm", help: "Fields, barns and machines" },
  { id: "delivery", label: "Delivery", help: "Depots, routes and vehicles" },
  { id: "generic", label: "Generic", help: "A blank floor to lay out yourself" },
];
const templateLabel = (id: string) => TEMPLATES.find((t) => t.id === id)?.label ?? id;

function SiteForm({ site, onDone, onCancel }: { site?: Site; onDone: (s: Site) => void; onCancel: () => void }) {
  const [name, setName] = useState(site?.name ?? "");
  const [template, setTemplate] = useState(site?.template ?? "hospital");
  const [nameError, setNameError] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const idp = site ? `site-${site.id}` : "site-new";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setNameError("Give the site a name, for example “St Mary's, Ward 4”.");
      return;
    }
    setNameError("");
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), template };
      onDone(site ? await api.updateSite(site.id, body) : await api.createSite(body));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="stack-sm" onSubmit={submit} noValidate aria-label={site ? `Edit ${site.name}` : "New site"}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${idp}-name`}>Site name<span className="req" aria-hidden="true">*</span></label>
          <input id={`${idp}-name`} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} autoComplete="off" />
          {nameError && <span className="err">{nameError}</span>}
        </div>
        <div className="field">
          <label htmlFor={`${idp}-template`}>Template</label>
          <select id={`${idp}-template`} value={template} onChange={(e) => setTemplate(e.target.value)} aria-describedby={`${idp}-template-help`}>
            {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <span className="help" id={`${idp}-template-help`}>
            {TEMPLATES.find((t) => t.id === template)?.help}. Sets the starting map style; you can change the layout later.
          </span>
        </div>
      </div>
      {error !== null && <ErrorNotice error={error} title="Couldn't save the site" />}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : site ? "Save changes" : "Create site"}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

function SiteCard({ site, mappings, onChanged }: { site: Site; mappings: Mapping[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const zones = site.layout?.zones?.length ?? 0;
  const running = mappings.filter((m) => m.running).length;
  return (
    <li className="panel card">
      {editing ? (
        <SiteForm site={site} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <div className="card-head">
            <h2>{site.name}</h2>
            <span className="pill info">{templateLabel(site.template)}</span>
          </div>
          <dl className="meta">
            <div><dt>Zones</dt><dd>{zones}</dd></div>
            <div><dt>Mappings</dt><dd>{mappings.length}{mappings.length > 0 && ` (${running} running)`}</dd></div>
            <div><dt>Created</dt><dd>{formatDate(site.created_ts)}</dd></div>
          </dl>
          {zones === 0 && <p className="muted" style={{ margin: 0 }}>No zones yet. Use “Edit layout” to draw them.</p>}
          <div className="row-actions">
            <Link className="btn primary" to={`/map/${site.id}`}>Open live map</Link>
            <Link className="btn" to={`/map/${site.id}?edit=1`}>Edit layout</Link>
            <Link className="btn" to={`/sites/${site.id}/setup`}>Set up from a source</Link>
            <Link className="btn" to={`/mapping?site=${site.id}`}>Mappings</Link>
            <button type="button" className="btn" onClick={() => setEditing(true)}>Rename or change template</button>
          </div>
          <ConfirmDelete
            label="Delete site"
            what={`“${site.name}”`}
            consequence={`Its layout and ${mappings.length === 1 ? "1 mapping" : `${mappings.length} mappings`} are removed and the live map stops. Your source data is not touched.`}
            onConfirm={async () => { await api.deleteSite(site.id); onChanged(); }}
          />
        </>
      )}
    </li>
  );
}

export default function SitesPage() {
  return (
    <Routes>
      <Route index element={<SitesList />} />
      <Route path=":siteId/setup" element={<SiteSetupPage />} />
    </Routes>
  );
}

function SiteSetupPage() {
  const { siteId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, error, loading, reload } = useLoad(() => Promise.all([api.site(siteId), api.sources()]), [siteId]);
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Set up {data ? data[0].name : "a site"} from a source</h1>
          <p className="lead">Choose a source. Live Ops suggests which tables to show on the map and how; you check and create them in one go.</p>
        </div>
        <Link className="btn" to="/sites">Back to sites</Link>
      </div>
      {loading && !data && <Loading label="Loading…" />}
      {error !== null && <ErrorNotice error={error} title="Couldn't load the site" onRetry={reload} />}
      {data && data[1].length === 0 && (
        <EmptyState title="Connect a source first" action={<Link className="btn primary" to="/sources/new">Connect a source</Link>}>
          Suggestions are made from a source's tables. Connect one, test it, then come back here.
        </EmptyState>
      )}
      {data && data[1].length > 0 && (
        <SetupFromSource site={data[0]} sources={data[1]} initialSourceId={params.get("source") ?? undefined}
          onSourceChange={(id) => setParams(id ? { source: id } : {}, { replace: true })} />
      )}
    </section>
  );
}

function SitesList() {
  const { data, error, loading, reload } = useLoad(() => Promise.all([api.sites(), api.mappings()]));
  const [creating, setCreating] = useState(false);
  const sites = data?.[0] ?? [];
  const mappings = data?.[1] ?? [];
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Sites</h1>
          <p className="lead">A site is one place you watch live: a hospital, a warehouse, a farm or a delivery area.</p>
        </div>
        {!creating && <button type="button" className="btn primary" onClick={() => setCreating(true)}>New site</button>}
      </div>
      {creating && (
        <div className="panel">
          <SiteForm onDone={() => { setCreating(false); reload(); }} onCancel={() => setCreating(false)} />
        </div>
      )}
      {loading && !data && <Loading label="Loading sites…" />}
      {error !== null && <ErrorNotice error={error} title="Couldn't load sites" onRetry={reload} />}
      {data && sites.length === 0 && !creating && (
        <EmptyState title="No sites yet" action={<button type="button" className="btn primary" onClick={() => setCreating(true)}>Create your first site</button>}>
          Create a site, then map a source to it in the Mapping studio to see its assets on the live map.
        </EmptyState>
      )}
      {sites.length > 0 && (
        <ul className="card-list" style={{ listStyle: "none", padding: 0, margin: 0 }} aria-label="Sites">
          {sites.map((s) => (
            <SiteCard key={s.id} site={s} mappings={mappings.filter((m) => m.site_id === s.id)} onChanged={reload} />
          ))}
        </ul>
      )}
    </section>
  );
}
