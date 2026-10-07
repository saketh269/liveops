import type { JSONSchema } from "../../api/types";
import { humanize } from "../format";

/**
 * Renders a connector's settings and secrets as a form, straight from the JSON
 * Schema the backend serves (ConnectorSpec.settings_schema / secrets_schema).
 *
 * Form state holds raw strings (what the user typed); `toSettings` converts to
 * the typed payload on submit. Supported: string, integer/number, boolean,
 * enum, array of strings (comma separated), password (format or any secret).
 */

export type FormValues = Record<string, string | boolean>;
export type FormErrors = Record<string, string>;

const ENUM_LABELS: Record<string, Record<string, string>> = {
  encryption: {
    required: "Required (recommended)",
    verify: "Required and verify the server certificate",
    off: "Off (local testing only)",
  },
};

function props(schema: JSONSchema): [string, JSONSchema][] {
  return Object.entries(schema.properties ?? {});
}

/** Starting values for a new source: every schema default, as form text. */
export function initialValues(schema: JSONSchema): FormValues {
  const out: FormValues = {};
  for (const [key, p] of props(schema)) {
    out[key] = toFormValue(p, p.default);
  }
  return out;
}

/** Existing settings (edit mode) as form text. */
export function valuesFrom(schema: JSONSchema, settings: Record<string, unknown>): FormValues {
  const out = initialValues(schema);
  for (const [key, p] of props(schema)) {
    if (key in settings) out[key] = toFormValue(p, settings[key]);
  }
  return out;
}

function toFormValue(p: JSONSchema, v: unknown): string | boolean {
  if (p.type === "boolean") return v === true;
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** Converts form text to the typed settings object the API expects. Blank optional fields are left out. */
export function toSettings(schema: JSONSchema, values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, p] of props(schema)) {
    const v = values[key];
    if (p.type === "boolean") {
      out[key] = v === true;
      continue;
    }
    const s = typeof v === "string" ? v.trim() : "";
    if (s === "") continue;
    if (p.type === "integer") out[key] = parseInt(s, 10);
    else if (p.type === "number") out[key] = Number(s);
    else if (p.type === "array") out[key] = s.split(",").map((x) => x.trim()).filter(Boolean);
    else out[key] = s;
  }
  return out;
}

/** Only the secrets the user typed; blank means "keep what is saved". */
export function toSecrets(values: FormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (typeof v === "string" && v !== "") out[k] = v;
  return out;
}

export function validate(
  settingsSchema: JSONSchema, settings: FormValues,
  secretsSchema: JSONSchema, secrets: FormValues, secretsSet: Record<string, boolean> = {},
): FormErrors {
  const errors: FormErrors = {};
  const req = new Set(settingsSchema.required ?? []);
  for (const [key, p] of props(settingsSchema)) {
    const v = settings[key];
    const s = typeof v === "string" ? v.trim() : "";
    const label = p.title ?? humanize(key);
    if (req.has(key) && p.type !== "boolean" && s === "") {
      errors[`settings.${key}`] = `${label} is required.`;
    } else if (s !== "" && p.type === "integer" && !/^-?\d+$/.test(s)) {
      errors[`settings.${key}`] = `${label} must be a whole number.`;
    } else if (s !== "" && p.type === "number" && Number.isNaN(Number(s))) {
      errors[`settings.${key}`] = `${label} must be a number.`;
    }
  }
  const sreq = new Set(secretsSchema.required ?? []);
  for (const [key, p] of props(secretsSchema)) {
    if (sreq.has(key) && !secretsSet[key] && !secrets[key]) {
      errors[`secrets.${key}`] = `${p.title ?? humanize(key)} is required.`;
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
};

export function SchemaFields({ group, schema, values, onChange, errors, secretsSet }: FieldsProps) {
  const required = new Set(schema.required ?? []);
  const editing = secretsSet !== undefined;
  return (
    <>
      {props(schema).map(([key, p]) => {
        const id = `f-${group}-${key}`;
        const err = errors[`${group}.${key}`];
        const label = p.title ?? humanize(key);
        const set = (v: string | boolean) => onChange({ ...values, [key]: v });
        const isSecret = group === "secrets";
        const saved = isSecret && secretsSet?.[key];
        const isRequired = required.has(key) && !(isSecret && saved) && p.type !== "boolean";
        const helps: string[] = [];
        if (p.description) helps.push(p.description);
        if (p.type === "array") helps.push("Separate several values with commas.");
        if (isSecret && editing) {
          helps.push(saved
            ? "A value is saved. Leave this blank to keep it, or type a new one to replace it."
            : "No value saved yet.");
        }
        const helpId = helps.length ? `${id}-help` : undefined;
        const errId = err ? `${id}-err` : undefined;
        const described = [helpId, errId].filter(Boolean).join(" ") || undefined;
        const value = values[key];
        const strValue = typeof value === "string" ? value : "";

        if (p.type === "boolean") {
          return (
            <div className="field" key={key}>
              <label className="check" htmlFor={id}>
                <input id={id} type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)}
                  aria-describedby={described} />
                {label}
              </label>
              {helpId && <span className="help" id={helpId}>{helps.join(" ")}</span>}
            </div>
          );
        }

        let control;
        if (p.enum) {
          control = (
            <select id={id} value={strValue} onChange={(e) => set(e.target.value)} aria-invalid={!!err}
              aria-describedby={described} required={isRequired}>
              {!isRequired && p.default === undefined && <option value="">Not set</option>}
              {p.enum.map((opt) => (
                <option key={opt} value={opt}>{ENUM_LABELS[key]?.[opt] ?? humanize(opt)}</option>
              ))}
            </select>
          );
        } else {
          const password = isSecret || p.format === "password";
          const example = p.examples?.[0];
          control = (
            <input
              id={id}
              type={password ? "password" : "text"}
              inputMode={p.type === "integer" ? "numeric" : p.type === "number" ? "decimal" : undefined}
              autoComplete={password ? "new-password" : "off"}
              value={strValue}
              placeholder={example !== undefined ? `e.g. ${String(example)}` : saved ? "Saved; leave blank to keep" : undefined}
              onChange={(e) => set(e.target.value)}
              aria-invalid={!!err}
              aria-describedby={described}
              aria-required={isRequired}
            />
          );
        }
        return (
          <div className="field" key={key}>
            <label htmlFor={id}>
              {label}
              {isRequired && <span className="req" aria-hidden="true">*</span>}
              {isRequired && <span className="sr-only"> (required)</span>}
            </label>
            {control}
            {helpId && <span className="help" id={helpId}>{helps.join(" ")}</span>}
            {err && <span className="err" id={errId}>{err}</span>}
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
