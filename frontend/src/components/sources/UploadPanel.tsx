import { useId, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import type { UploadResult } from "../../api/types";

const ACCEPT = ".csv,.xlsx";
const MAX_MB = 50;

/** Upload or replace the file behind a CSV / Excel source (LIVEOPS-80). */
export default function UploadPanel({ sourceId, onUploaded }: { sourceId: string; onUploaded: () => void }) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [done, setDone] = useState<UploadResult | null>(null);

  async function upload(file: File) {
    setError(null);
    setDone(null);
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      setError({ message: "Choose a .csv or .xlsx file." });
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setError({ message: `The file is larger than ${MAX_MB} MB.`, hint: "Split it into smaller files." });
      return;
    }
    setBusy(true);
    try {
      const result = await api.uploadFile(sourceId, file);
      setDone(result);
      onUploaded();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setError({ message: err?.message ?? "Upload failed. Check your connection and try again.", hint: err?.hint });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <section className="panel stack-sm" aria-labelledby={`${inputId}-head`}>
      <h2 id={`${inputId}-head`}>File</h2>
      <p className="muted" style={{ margin: 0 }}>
        Upload a .csv or .xlsx file (up to {MAX_MB} MB). Uploading a file with the same name replaces it, and the
        live map updates within a few seconds.
      </p>
      <div className="field">
        <label htmlFor={inputId}>Choose a file to upload</label>
        <input
          id={inputId}
          ref={input}
          type="file"
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
        />
      </div>
      {busy && <div className="notice info" role="status">Uploading…</div>}
      {done && (
        <div className="notice info" role="status">
          Uploaded {done.dataset}: {done.rows.toLocaleString()} rows, {done.columns.length} columns. Map it in Mapping studio.
        </div>
      )}
      {error && (
        <div className="notice bad" role="alert">
          {error.message}
          {error.hint && <div className="muted">{error.hint}</div>}
        </div>
      )}
    </section>
  );
}
