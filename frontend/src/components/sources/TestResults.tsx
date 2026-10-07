import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { TestReport } from "../../api/types";
import { ErrorNotice, Loading } from "../ui";

export function TestChecklist({ report }: { report: TestReport }) {
  return (
    <div className="stack-sm">
      <div className={`notice ${report.ok ? "info" : "bad"}`} role="status">
        <strong>{report.ok ? "Connection works." : "Connection needs attention."}</strong>
        <span>
          {report.ok
            ? "Every check passed. You can now map this source to a site in the Mapping studio."
            : "Fix the failed checks below, edit the source if needed, then test again."}
          {" "}<span className="muted">({report.duration_ms} ms)</span>
        </span>
      </div>
      <ul className="checklist" aria-label="Connection checks">
        {report.steps.map((s, i) => (
          <li key={`${s.name}-${i}`} className={s.ok ? "ok" : "fail"}>
            <span className="mark" aria-hidden="true">{s.ok ? "✓" : "✗"}</span>
            <div>
              <div>
                <strong>{s.name}</strong>
                <span className="sr-only">{s.ok ? ": passed" : ": failed"}</span>
              </div>
              {s.detail && <div className="detail">{s.detail}</div>}
              {!s.ok && (
                <div className="fix">
                  <strong>How to fix: </strong>
                  {s.hint || "Check the settings for this step and try again."}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Test connection" button plus results. `autoRun` starts the test on mount (after first save). */
export function TestPanel({ sourceId, autoRun = false }: { sourceId: string; autoRun?: boolean }) {
  const [report, setReport] = useState<TestReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const autoRan = useRef(false);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.testSource(sourceId));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, [sourceId]);

  useEffect(() => {
    if (autoRun && !autoRan.current) {
      autoRan.current = true;
      void run();
    }
  }, [autoRun, run]);

  return (
    <section className="panel stack-sm" aria-labelledby="test-head">
      <div className="card-head">
        <h2 id="test-head">Test connection</h2>
        <button type="button" className="btn primary" onClick={run} disabled={busy}>
          {busy ? "Testing…" : report ? "Test again" : "Test connection"}
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Checks that Live Ops can reach the server, sign in, use encryption, read only, and see your tables.
      </p>
      {busy && <Loading label="Testing the connection. This can take up to 15 seconds…" />}
      {error !== null && <ErrorNotice error={error} title="The test couldn't run" />}
      {report && !busy && <TestChecklist report={report} />}
    </section>
  );
}
