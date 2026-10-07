import { useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import "./ui.css";

/** Plain-words explanation of any error thrown by the API client. */
export function describeError(err: unknown): { message: string; hint?: string; problems?: string[] } {
  if (err instanceof ApiError) {
    let hint = err.hint;
    if (!hint && err.status >= 500) {
      hint = "The Live Ops server hit a problem. Try again; if it keeps happening, check the backend logs.";
    }
    if (!hint && err.status === 404) hint = "It may have been deleted. Reload the page to see the current list.";
    return { message: err.message, hint, problems: err.problems };
  }
  if (err instanceof TypeError) {
    return {
      message: "Can't reach the Live Ops server.",
      hint: "Check that the backend is running and your network is connected, then try again.",
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

export function ErrorNotice({ error, title, onRetry }: { error: unknown; title?: string; onRetry?: () => void }) {
  const e = describeError(error);
  return (
    <div className="notice bad" role="alert">
      <strong>{title ?? e.message}</strong>
      {title && <div>{e.message}</div>}
      {e.problems && e.problems.length > 0 && (
        <ul className="problems">
          {e.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      {e.hint && <div className="hint">{e.hint}</div>}
      {onRetry && (
        <div className="row-actions">
          <button type="button" className="btn" onClick={onRetry}>Try again</button>
        </div>
      )}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="panel empty">
      <h2>{title}</h2>
      {children && <div className="muted">{children}</div>}
      {action && <div className="row-actions">{action}</div>}
    </div>
  );
}

/**
 * Two-step delete: the first click reveals an inline confirmation with the
 * consequence spelled out. No window.confirm.
 */
export function ConfirmDelete({
  label, what, consequence, onConfirm,
}: { label?: string; what: string; consequence: string; onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!open) {
    return <button type="button" className="btn danger" onClick={() => setOpen(true)}>{label ?? "Delete"}</button>;
  }
  return (
    <div className="confirm" role="group" aria-label={`Confirm delete ${what}`}>
      <p><strong>Delete {what}?</strong> {consequence}</p>
      {error !== null && <ErrorNotice error={error} title="Couldn't delete" />}
      <div className="row-actions">
        <button
          type="button"
          className="btn danger solid"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
            } catch (e) {
              setError(e);
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Yes, delete"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone = { running: "ok", stable: "ok", ok: "ok", starting: "info", beta: "warn", paused: "", error: "bad", needs_real_test: "warn" }[status] ?? "";
  const text = { running: "Running", starting: "Starting", paused: "Paused", error: "Error" }[status] ?? status;
  return <span className={`pill ${tone}`}>{text}</span>;
}
