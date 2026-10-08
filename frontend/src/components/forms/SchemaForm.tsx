import type { JSONSchema } from "../../api/types";
import { humanize } from "../format";

/**
 * Renders a connector's settings and secrets as a form, straight from the JSON
 * Schema the backend serves (ConnectorSpec.settings_schema / secrets_schema).
 *
 * Form state holds what the user typed (text, booleans, key/value rows);
 * `toSettings` converts it to the typed payload on submit and never turns an
 * object into a string. Supported: string, integer, number, boolean, enum,
 * array of primitives (comma separated), object with free keys (key/value
 * editor), object with fixed properties or arrays of objects (JSON editor),
 * password (format or any secret).
 */

export type KVRow = { key: string; value: string };
export type FormValue = string | boolean | KVRow[];
export type FormValues = Record<string, FormValue>;
export type FormErrors = Record<string, string>;

type Kind = "boolean" | "enum" | "kv" | "json" | "list" | "integer" | "number" | "text";

export function fieldKind(p: JSONSchema): Kind {
  if (p.type === "boolean") return "boolean";
  if (p.enum) return "enum";
  if (p.type === "object") return p.properties && Object.keys(p.properties).length ? "json" : "kv";
  if (p.type === "array") {
    const it = p.items?.type;
    return it === undefined || it === "string" || it === "integer" || it === "number" ? "list" : "json";
  }
  if (p.type === "integer") return "integer";
  if (p.type === "number") return "number";
  return "text";
}

const ENUM_LABELS: Record<string, Record<string, string>> = {
  auth: {
    none: "None",
    api_key: "API key (sent as a header)",
    bearer: "Bearer token",
    oauth2_client_credentials: "OAuth2 client credentials",
  },
  encryption: {
    required: "Required (recommended)",
    verify: "Required and verify the server certificate",
    required_legacy_auth: "Required (allow older password methods)",
    off: "Off (local testing only)",
  },
};

function props(schema: JSONSchema): [string, JSONSchema][] {
  return Object.entries(schema.properties ?? {});
}

function kvValueType(p: JSONSchema): string | undefined {
  return typeof p.additionalProperties === "object" ? p.additionalProperties.type : undefined;
}

/** Starting values for a new source: every schema default, as form values. */
export function initialValues(schema: JSONSchema): FormValues {
  const out: FormValues = {};
  for (const [key, p] of props(schema)) out[key] = toFormValue(p, p.default);
  return out;
}

/** Existing settings (edit mode) as form values. */
export function valuesFrom(schema: JSONSchema, settings: Record<string, unknown>): FormValues {
  const out = initialValues(schema);
  for (const [key, p] of props(schema)) {
    if (key in settings) out[key] = toFormValue(p, settings[key]);
  }
  return out;
}

function toFormValue(p: JSONSchema, v: unknown): FormValue {
  const kind = fieldKind(p);
  if (kind === "boolean") return v === true;
  if (kind === "kv") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return [];
    return Object.entries(v as Record<string, unknown>).map(([key, val]) => ({
      key, value: typeof val === "string" ? val : JSON.stringify(val),
    }));
  }
  if (v === undefined || v === null) return "";
  if (kind === "json") return JSON.stringify(v, null, 2);
  if (kind === "list") return Array.isArray(v) ? v.map(String).join(", ") : String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function convertScalar(type: string | undefined, s: string): unknown {
  if (type === "integer") return parseInt(s, 10);
  if (type === "number") return Number(s);
  if (type === "boolean") return s === "true";
  return s;
}

/** Converts form values to the typed settings object the API expects. Blank optional scalars are left out. */
export function toSettings(schema: JSONSchema, values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, p] of props(schema)) {
    const v = values[key];
    const kind = fieldKind(p);
    if (kind === "boolean") {
      out[key] = v === true;
      continue;
    }
    if (kind === "kv") {
      const rows = Array.isArray(v) ? v : [];
      const vt = kvValueType(p);
      out[key] = Object.fromEntries(
        rows.filter((r) => r.key.trim() !== "").map((r) => [r.key.trim(), convertScalar(vt, r.value)]));
      continue;
    }
    const s = typeof v === "string" ? v.trim() : "";
    if (s === "") continue;
    if (kind === "json") out[key] = JSON.parse(s);
    else if (kind === "list") out[key] = s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => convertScalar(p.items?.type, x));
    else out[key] = convertScalar(kind === "integer" || kind === "number" ? kind : undefined, s);
  }
  return out;
}

/**
 * Only the secrets the user typed; blank means "keep what is saved".
 * Secrets listed in `remove` are sent as null, which clears them.
 */
export function toSecrets(values: FormValues, remove: Record<string, boolean> = {}): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(values)) if (typeof v === "string" && v !== "") out[k] = v;
  for (const [k, r] of Object.entries(remove)) if (r && !(k in out)) out[k] = null;
  return out;
}

function checkScalar(p: JSONSchema, label: string, s: string, kind: Kind): string | undefined {
  if (kind === "integer" && !/^-?\d+$/.test(s)) return `${label} must be a whole number.`;
  if (kind === "number" && (s === "" || Number.isNaN(Number(s)))) return `${label} must be a number.`;
  if (kind === "integer" || kind === "number") {
    const n = Number(s);
    if (p.minimum !== undefined && n < p.minimum) return `${label} must be at least ${p.minimum}.`;
    if (p.maximum !== undefined && n > p.maximum) return `${label} must be at most ${p.maximum}.`;
  }
  if (kind === "text") {
    if (p.minLength !== undefined && s.length < p.minLength) return `${label} must be at least ${p.minLength} characters.`;
    if (p.maxLength !== undefined && s.length > p.maxLength) return `${label} must be at most ${p.maxLength} characters.`;
  }
  return undefined;
}

export function validate(
  settingsSchema: JSONSchema, settings: FormValues,
  secretsSchema: JSONSchema, secrets: FormValues, secretsSet: Record<string, boolean> = {},
): FormErrors {
  const errors: FormErrors = {};
  const req = new Set(settingsSchema.required ?? []);
  for (const [key, p] of props(settingsSchema)) {
    const v = settings[key];
    const kind = fieldKind(p);
    const label = p.title ?? humanize(key);
    const id = `settings.${key}`;
    if (kind === "boolean") continue;
    if (kind === "kv") {
      const rows = (Array.isArray(v) ? v : []).filter((r) => r.key.trim() !== "" || r.value !== "");
      const keys = rows.map((r) => r.key.trim());
      if (keys.some((k) => k === "")) errors[id] = `Every value in ${label} needs a name.`;
      else if (new Set(keys).size !== keys.length) errors[id] = `${label} has the same name twice.`;
      else if (req.has(key) && rows.length === 0) errors[id] = `${label} needs at least one entry.`;
      else {
        const vt = kvValueType(p);
        const bad = rows.find((r) => (vt === "integer" || vt === "number") && checkScalar({}, "", r.value, vt));
        if (bad) errors[id] = `The value for “${bad.key}” must be a number.`;
      }
      continue;
    }
    const s = typeof v === "string" ? v.trim() : "";
    if (s === "") {
      if (req.has(key)) errors[id] = `${label} is required.`;
      continue;
    }
    if (kind === "json") {
      try {
        const parsed = JSON.parse(s);
        const wantArray = p.type === "array";
        if (wantArray !== Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
          errors[id] = `${label} must be a JSON ${wantArray ? "list" : "object"}.`;
        }
      } catch {
        errors[id] = `${label} isn't valid JSON. Check quotes, commas and brackets.`;
      }
      continue;
    }
    if (kind === "list") {
      const it = p.items?.type;
      if (it === "integer" || it === "number") {
        const bad = s.split(",").map((x) => x.trim()).filter(Boolean).find((x) => checkScalar({}, "", x, it));
        if (bad) errors[id] = `${label}: “${bad}” isn't a ${it === "integer" ? "whole number" : "number"}.`;
      }
      continue;
    }
    const msg = checkScalar(p, label, s, kind);
    if (msg) errors[id] = msg;
  }
  const sreq = new Set(secretsSchema.required ?? []);
  for (const [key, p] of props(secretsSchema)) {
    const v = secrets[key];
    const label = p.title ?? humanize(key);
    if (typeof v === "string" && v !== "") {
      const msg = checkScalar(p, label, v, "text");
      if (msg) errors[`secrets.${key}`] = msg;
    } else if (sreq.has(key) && !secretsSet[key]) {
      errors[`secrets.${key}`] = `${label} is required.`;
    }
  }
  return errors;
}

type FieldsProps = {
  group: "settings" | "secrets";
  schema: JSONSchema;
  values: FormValues;
  onChange: (v: FormValues) => void;
  errors: FormErrors;
  /** Edit mode: which secrets already have a saved value. */
  secretsSet?: Record<string, boolean>;
  /** Edit mode: optional saved secrets the user chose to remove. */
  removed?: Record<string, boolean>;
  onRemovedChange?: (r: Record<string, boolean>) => void;
  /** Extra help per field, e.g. "You changed the host, so enter this again." */
  extraHelp?: Record<string, string>;
};

function KVEditor({ id, label, rows, onChange, invalid, describedBy }: {
  id: string; label: string; rows: KVRow[]; onChange: (r: KVRow[]) => void; invalid: boolean; describedBy?: string;
}) {
  const set = (i: number, patch: Partial<KVRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
      {rows.length === 0 && <span className="help">None yet.</span>}
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input aria-label={`${label}: name ${i + 1}`} placeholder="name" value={r.key} aria-invalid={invalid}
            onChange={(e) => set(i, { key: e.target.value })} autoComplete="off" />
          <input aria-label={`${label}: value ${i + 1}`} placeholder="value" value={r.value}
            onChange={(e) => set(i, { value: e.target.value })} autoComplete="off" />
          <button type="button" className="btn link" aria-label={`Remove ${label} ${r.key || i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div>
        <button type="button" className="btn" id={id} onClick={() => onChange([...rows, { key: "", value: "" }])}>
          Add {label.toLowerCase().replace(/s$/, "")}
        </button>
      </div>
    </div>
  );
}

export function SchemaFields({ group, schema, values, onChange, errors, secretsSet, removed = {}, onRemovedChange, extraHelp = {} }: FieldsProps) {
  const required = new Set(schema.required ?? []);
  const editing = secretsSet !== undefined;
  return (
    <>
      {props(schema).map(([key, p]) => {
        const id = `f-${group}-${key}`;
        const err = errors[`${group}.${key}`];
        const label = p.title ?? humanize(key);
        const set = (v: FormValue) => onChange({ ...values, [key]: v });
        const kind = fieldKind(p);
        const isSecret = group === "secrets";
        const saved = isSecret && secretsSet?.[key];
        const isRemoved = isSecret && removed[key];
        const isRequired = required.has(key) && !(isSecret && saved) && kind !== "boolean";
        const helps: string[] = [];
        if (extraHelp[key]) helps.push(extraHelp[key]);
        if (p.description) helps.push(p.description);
        if (kind === "list") helps.push("Separate several values with commas.");
        if (kind === "json") helps.push(`Enter a JSON ${p.type === "array" ? "list" : "object"}.`);
        if (isSecret && editing && !extraHelp[key]) {
          helps.push(saved
            ? "A value is saved. Leave this blank to keep it, or type a new one to replace it."
            : "No value saved yet.");
        }
        const helpId = helps.length ? `${id}-help` : undefined;
        const errId = err ? `${id}-err` : undefined;
        const described = [helpId, errId].filter(Boolean).join(" ") || undefined;
        const value = values[key];
        const strValue = typeof value === "string" ? value : "";

        if (kind === "boolean") {
          return (
            <div className="field" key={key}>
              <label className="check" htmlFor={id}>
                <input id={id} type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)}
                  aria-describedby={described} />
                {label}
              </label>
              {helpId && <span className="help" id={helpId}>{helps.join(" ")}</span>}
              {key === "allow_http" && value === true && (
                <div className="notice" role="note">
                  <strong>Plain HTTP is allowed.</strong> Data and keys can travel unencrypted. Use this only for local testing.
                </div>
              )}
            </div>
          );
        }

        let control;
        if (kind === "kv") {
          control = (
            <KVEditor id={id} label={label} rows={Array.isArray(value) ? value : []} onChange={set} invalid={!!err} describedBy={described} />
          );
        } else if (kind === "enum") {
          control = (
            <select id={id} value={strValue} onChange={(e) => set(e.target.value)} aria-invalid={!!err}
              aria-describedby={described} required={isRequired}>
              {!isRequired && p.default === undefined && <option value="">Not set</option>}
              {(p.enum ?? []).map((opt) => (
                <option key={opt} value={opt}>{ENUM_LABELS[key]?.[opt] ?? humanize(opt)}</option>
              ))}
            </select>
          );
        } else if (kind === "json") {
          control = (
            <textarea id={id} rows={4} className="mono" value={strValue} onChange={(e) => set(e.target.value)}
              aria-invalid={!!err} aria-describedby={described} spellCheck={false} />
          );
        } else {
          const password = isSecret || p.format === "password";
          const example = p.examples?.[0];
          control = (
            <input
              id={id}
              type={password ? "password" : "text"}
              inputMode={kind === "integer" ? "numeric" : kind === "number" ? "decimal" : undefined}
              autoComplete={password ? "new-password" : "off"}
              value={strValue}
              disabled={isRemoved}
              placeholder={example !== undefined ? `e.g. ${String(example)}` : saved ? "Saved; leave blank to keep" : undefined}
              onChange={(e) => set(e.target.value)}
              aria-invalid={!!err}
              aria-describedby={described}
              aria-required={isRequired}
            />
          );
        }
        const wide = kind === "kv" || kind === "json";
        return (
          <div className={`field${wide ? " wide" : ""}`} key={key}>
            {kind === "kv" ? (
              <span className="kv-label" id={`${id}-label`}>
                {label}
                {isRequired && <span className="req" aria-hidden="true">*</span>}
              </span>
            ) : (
              <label htmlFor={id} id={`${id}-label`}>
                {label}
                {isRequired && <span className="req" aria-hidden="true">*</span>}
                {isRequired && <span className="sr-only"> (required)</span>}
              </label>
            )}
            {control}
            {helpId && <span className="help" id={helpId}>{helps.join(" ")}</span>}
            {err && <span className="err" id={errId}>{err}</span>}
            {saved && !required.has(key) && onRemovedChange && (
              <label className="check">
                <input type="checkbox" checked={!!isRemoved}
                  onChange={(e) => { onRemovedChange({ ...removed, [key]: e.target.checked }); if (e.target.checked) set(""); }} />
                Remove the saved {label.toLowerCase()}
              </label>
            )}
            {key === "encryption" && value === "off" && (
              <div className="notice" role="note">
                <strong>Encryption is off.</strong> Passwords and data will cross the network unencrypted.
                Use this only for local testing; company databases should use Required.
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
