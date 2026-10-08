// Accessible form pieces for the sign-in and account pages: labelled inputs with inline errors,
// a password input with show/hide, the strength meter, an always-present live error region,
// and a copy-to-clipboard field for invite and reset links.
import { forwardRef, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { describeError } from "../components/ui";
import { passwordStrength } from "./password";

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  error?: string | null;
  help?: ReactNode;
  /** Right-aligned link or note on the label row (e.g. "Forgot password?"). */
  aside?: ReactNode;
};

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField(
  { label, error, help, aside, required, ...input }, ref,
) {
  const id = useId();
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field au-field">
      <div className="au-label-row">
        <label htmlFor={id}>{label}{required && <span className="req" aria-hidden="true">*</span>}</label>
        {aside}
      </div>
      <input ref={ref} id={id} required={required} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {help && <div className="help" id={`${id}-help`}>{help}</div>}
      {error && <div className="err" id={`${id}-err`}>{error}</div>}
    </div>
  );
});

type PasswordProps = FieldProps & { meter?: boolean; email?: string };

export const PasswordField = forwardRef<HTMLInputElement, PasswordProps>(function PasswordField(
  { label, error, help, aside, meter, email, required, value, ...input }, ref,
) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const describedBy = [help ? `${id}-help` : null, meter ? `${id}-meter` : null, error ? `${id}-err` : null]
    .filter(Boolean).join(" ") || undefined;
  const strength = meter ? passwordStrength(String(value ?? ""), email) : null;
  return (
    <div className="field au-field">
      <div className="au-label-row">
        <label htmlFor={id}>{label}{required && <span className="req" aria-hidden="true">*</span>}</label>
        {aside}
      </div>
      <div className="au-pw">
        <input
          ref={ref} id={id} type={shown ? "text" : "password"} required={required} value={value}
          aria-invalid={error ? true : undefined} aria-describedby={describedBy} spellCheck={false} autoCapitalize="none" {...input}
        />
        <button
          type="button" className="au-pw-toggle" aria-controls={id} aria-pressed={shown}
          aria-label={shown ? "Hide password" : "Show password"} onClick={() => setShown((s) => !s)}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {help && <div className="help" id={`${id}-help`}>{help}</div>}
      {strength && (
        <div className="au-meter" id={`${id}-meter`} data-score={strength.score}>
          <div className="au-meter-bar" aria-hidden="true"><span /><span /><span /><span /></div>
          <span className="au-meter-label" aria-live="polite">{strength.label ? `Strength: ${strength.label}` : " "}</span>
        </div>
      )}
      {error && <div className="err" id={`${id}-err`}>{error}</div>}
    </div>
  );
});

export type PlainMessage = { message: string; hint?: string; problems?: string[] };
function isPlainMessage(v: unknown): v is PlainMessage {
  return typeof v === "object" && v !== null && !(v instanceof Error) && typeof (v as PlainMessage).message === "string";
}

/**
 * The form-level error region. It is always in the DOM so screen readers announce changes;
 * `error` may be a string or anything the API client throws.
 */
export function FormAlert({ error, title }: { error: unknown; title?: string }) {
  const e = !error ? null
    : typeof error === "string" ? { message: error }
    : isPlainMessage(error) ? error
    : describeError(error);
  return (
    <div className="au-alert-slot" role="alert" aria-live="assertive">
      {e && (
        <div className="notice bad au-alert">
          <strong>{title ?? e.message}</strong>
          {title && <span>{e.message}</span>}
          {"problems" in e && e.problems && e.problems.length > 0 && <ul className="problems">{e.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          {"hint" in e && e.hint && <span className="hint">{e.hint}</span>}
        </div>
      )}
    </div>
  );
}

/** Polite status line (saved, copied, signed out). Always rendered so updates are announced. */
export function StatusLine({ children }: { children?: ReactNode }) {
  return <div className="au-status" role="status" aria-live="polite">{children}</div>;
}

/** Read-only text with a Copy button, for invite/reset links and new API tokens. */
export function CopyField({ label, value, help }: { label: string; value: string; help?: ReactNode }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"" | "ok" | "manual">("");
  useEffect(() => { setCopied(""); }, [value]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("ok");
    } catch {
      input.current?.select();
      setCopied("manual");
    }
  };
  return (
    <div className="field au-field">
      <label htmlFor={id}>{label}</label>
      <div className="au-copy">
        <input ref={input} id={id} className="mono" readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-describedby={help ? `${id}-help` : undefined} />
        <button type="button" className="btn" onClick={copy}>Copy</button>
      </div>
      {help && <div className="help" id={`${id}-help`}>{help}</div>}
      <StatusLine>{copied === "ok" ? "Copied to the clipboard." : copied === "manual" ? "Selected. Press Ctrl+C (or ⌘C) to copy." : ""}</StatusLine>
    </div>
  );
}
