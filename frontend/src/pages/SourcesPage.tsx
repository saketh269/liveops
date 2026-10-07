import { useState } from "react";
import UploadPanel from "../components/sources/UploadPanel";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { ConnectorSpec, Source } from "../api/types";
import { formatDate } from "../components/format";
import { ConnectorPicker, MaturityBadge } from "../components/sources/ConnectorPicker";
import { SourceForm } from "../components/sources/SourceForm";
import { TestPanel } from "../components/sources/TestResults";
import { ConfirmDelete, EmptyState, ErrorNotice, Loading } from "../components/ui";
import { useLoad } from "../components/useLoad";

export default function SourcesPage() {
  return (
    <Routes>
      <Route index element={<SourceList />} />
      <Route path="new" element={<NewSource />} />
      <Route path=":sourceId" element={<EditSource />} />
    </Routes>
  );
}

function useConnectorsAndSources() {
  return useLoad(() => Promise.all([api.connectors(), api.sources()]));
}

function SourceList() {
  const { data, error, loading, reload } = useConnectorsAndSources();
  const specs = new Map((data?.[0] ?? []).map((c) => [c.type, c]));
  const sources = data?.[1] ?? [];
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Sources</h1>
          <p className="lead">The systems Live Ops reads from. Live Ops only reads; it never changes your data.</p>
        </div>
        <Link className="btn primary" to="/sources/new">Connect a source</Link>
      </div>
      {loading && !data && <Loading label="Loading sources…" />}
      {error !== null && <ErrorNotice error={error} title="Couldn't load sources" onRetry={reload} />}
      {data && sources.length === 0 && (
        <EmptyState
          title="No sources yet"
          action={<Link className="btn primary" to="/sources/new">Connect your first source</Link>}
        >
          <ol>
            <li>Choose “Connect a source” and pick the kind of system, for example PostgreSQL.</li>
            <li>Enter its address and a read-only user. Live Ops stores the password encrypted.</li>
            <li>Test the connection, then map a table to a site in the Mapping studio.</li>
          </ol>
        </EmptyState>
      )}
      {sources.length > 0 && (
        <ul className="card-list" style={{ listStyle: "none", padding: 0, margin: 0 }} aria-label="Sources">
          {sources.map((s) => (
            <li key={s.id} className="panel card">
              <div className="card-head">
                <h2>{s.name}</h2>
                <div className="badges">
                  {s.warnings.length > 0 && <span className="pill warn">{s.warnings.length === 1 ? "1 warning" : `${s.warnings.length} warnings`}</span>}
                  {specs.get(s.type) && <MaturityBadge maturity={specs.get(s.type)!.maturity} />}
                </div>
              </div>
              <dl className="meta">
                <div><dt>Type</dt><dd>{specs.get(s.type)?.display_name ?? s.type}</dd></div>
                <div><dt>Added</dt><dd>{formatDate(s.created_ts)}</dd></div>
              </dl>
              {s.warnings.map((w) => <div key={w} className="notice">{w}</div>)}
              <div className="row-actions">
                <Link className="btn" to={`/sources/${s.id}`} aria-label={`Edit and test ${s.name}`}>Edit and test</Link>
                <Link className="btn link" to={`/mapping/new?source=${s.id}`}>Map to a site</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewSource() {
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad(() => api.connectors());
  const [spec, setSpec] = useState<ConnectorSpec | null>(null);
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{spec ? `Connect ${spec.display_name}` : "Connect a source"}</h1>
          <p className="lead">
            {spec ? spec.description || "Fill in the connection details, then save to test them." : "Pick the kind of system your data lives in."}
          </p>
        </div>
        <Link className="btn" to="/sources">Back to sources</Link>
      </div>
      {loading && <Loading label="Loading the list of connectors…" />}
      {error !== null && <ErrorNotice error={error} title="Couldn't load the list of connectors" onRetry={reload} />}
      {data && !spec && data.length === 0 && (
        <EmptyState title="No connectors are installed">The backend didn't report any source types. Check the backend version.</EmptyState>
      )}
      {data && !spec && <ConnectorPicker connectors={data} onPick={setSpec} />}
      {spec && (
        <div className="panel stack">
          {spec.maturity !== "stable" && (
            <div className="notice" role="note">
              {spec.maturity === "beta"
                ? "This connector is in beta. It works, but details may change."
                : "This connector hasn't been tested against a real server yet. Try it on a test system first."}
            </div>
          )}
          <SourceForm spec={spec} onSaved={(s) => navigate(`/sources/${s.id}?new=1`)} onCancel={() => setSpec(null)} />
        </div>
      )}
    </section>
  );
}

function EditSource() {
  const { sourceId = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad(
    () => Promise.all([api.connectors(), api.source(sourceId)]), [sourceId]);
  const [saved, setSaved] = useState<Source | null>(null);
  const [testKey, setTestKey] = useState(0);
  const isNew = params.get("new") === "1";

  if (loading && !data) return <Loading label="Loading source…" />;
  if (error !== null || !data) {
    return (
      <section className="stack">
        <h1>Source</h1>
        <ErrorNotice error={error} title="Couldn't load this source" onRetry={reload} />
        <Link to="/sources">Back to sources</Link>
      </section>
    );
  }
  const [specs, loaded] = data;
  const source = saved ?? loaded;
  const spec = specs.find((c) => c.type === source.type);
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{source.name}</h1>
          <p className="lead">{spec?.display_name ?? source.type} · added {formatDate(source.created_ts)}</p>
        </div>
        <Link className="btn" to="/sources">Back to sources</Link>
      </div>
      {isNew && !saved && <div className="notice info" role="status">Source saved. Testing the connection now.</div>}
      {source.warnings.map((w) => <div key={w} className="notice">{w}</div>)}
      {source.type === "csv_file" && (
        <UploadPanel sourceId={source.id} onUploaded={() => setTestKey((k) => k + 1)} />
      )}
      <TestPanel key={testKey} sourceId={source.id} autoRun={isNew || testKey > 0} />
      <section className="panel stack" aria-labelledby="edit-head">
        <h2 id="edit-head">Edit source</h2>
        {saved && <div className="notice info" role="status">Changes saved. Running mappings restarted with the new settings.</div>}
        {spec ? (
          <SourceForm key={source.updated_ts} spec={spec} source={source} onSaved={(s) => { setSaved(s); setTestKey((k) => k + 1); }} />
        ) : (
          <div className="notice bad">
            This source uses the “{source.type}” connector, which this server no longer provides. You can delete it below.
          </div>
        )}
      </section>
      <section className="panel stack-sm" aria-labelledby="delete-head">
        <h2 id="delete-head">Delete source</h2>
        <p className="muted" style={{ margin: 0 }}>Removes the connection and its saved password from Live Ops. Your data is not touched.</p>
        <div>
          <ConfirmDelete
            label="Delete source"
            what={`“${source.name}”`}
            consequence="Every mapping that uses this source will stop, and its assets will disappear from the live map."
            onConfirm={async () => { await api.deleteSource(source.id); navigate("/sources"); }}
          />
        </div>
      </section>
    </section>
  );
}
