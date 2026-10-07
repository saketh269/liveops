import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../api/client";
import type { ConnectorSpec, Source } from "../../api/types";
import {
  SchemaFields, initialValues, toSecrets, toSettings, validate, valuesFrom,
  type FormErrors, type FormValues,
} from "../forms/SchemaForm";
import { ErrorNotice } from "../ui";

type Props = {
  spec: ConnectorSpec;
  /** Present when editing an existing source. */
  source?: Source;
  onSaved: (s: Source) => void;
  onCancel?: () => void;
};

export function SourceForm({ spec, source, onSaved, onCancel }: Props) {
  const editing = source !== undefined;
  const [name, setName] = useState(source?.name ?? "");
  const [settings, setSettings] = useState<FormValues>(() =>
    source ? valuesFrom(spec.settings_schema, source.settings) : initialValues(spec.settings_schema));
  // Secrets are never pre-filled: the API doesn't return them, and blank means "keep".
  const [secrets, setSecrets] = useState<FormValues>(() =>
    Object.fromEntries(Object.keys(spec.secrets_schema.properties ?? {}).map((k) => [k, ""])));
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const hasSecrets = Object.keys(spec.secrets_schema.properties ?? {}).length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = validate(spec.settings_schema, settings, spec.secrets_schema, secrets, source?.secrets_set);
    if (!name.trim()) errs.name = "Give the source a name, for example “Hospital EHR”.";
    setErrors(errs);
    setServerError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const body = { name: name.trim(), settings: toSettings(spec.settings_schema, settings), secrets: toSecrets(secrets) };
      const saved = editing
        ? await api.updateSource(source.id, body)
        : await api.createSource({ ...body, type: spec.type });
      onSaved(saved);
    } catch (err) {
      setServerError(err);
      if (err instanceof ApiError && err.problems) {
        const fieldErrs: FormErrors = {};
        for (const p of err.problems) {
          if (p in (spec.settings_schema.properties ?? {})) fieldErrs[`settings.${p}`] = "Required by the server.";
          if (p in (spec.secrets_schema.properties ?? {})) fieldErrs[`secrets.${p}`] = "Required by the server.";
        }
        setErrors(fieldErrs);
      }
    } finally {
      setBusy(false);
    }
  };

  const errorCount = Object.keys(errors).length;
  return (
    <form className="stack" onSubmit={submit} noValidate aria-label={editing ? "Edit source" : `Connect ${spec.display_name}`}>
      <div className="form-grid">
        <div className="field wide">
          <label htmlFor="f-name">Name<span className="req" aria-hidden="true">*</span></label>
          <input id="f-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name}
            aria-describedby="f-name-help" autoComplete="off" />
          <span className="help" id="f-name-help">How this source appears in Live Ops, e.g. “Hospital EHR”.</span>
          {errors.name && <span className="err">{errors.name}</span>}
        </div>
      </div>
      <fieldset>
        <legend>Connection</legend>
        <div className="form-grid">
          <SchemaFields group="settings" schema={spec.settings_schema} values={settings} onChange={setSettings} errors={errors} />
        </div>
      </fieldset>
      {hasSecrets && (
        <fieldset>
          <legend>Sign-in</legend>
          <p className="help muted" style={{ marginTop: 0 }}>
            Stored encrypted. Live Ops never shows it again{editing ? "; leave a field blank to keep the saved value." : "."}
          </p>
          <div className="form-grid">
            <SchemaFields group="secrets" schema={spec.secrets_schema} values={secrets} onChange={setSecrets}
              errors={errors} secretsSet={editing ? source.secrets_set : undefined} />
          </div>
        </fieldset>
      )}
      {errorCount > 0 && serverError === null && (
        <div className="notice bad" role="alert">Fix the {errorCount === 1 ? "highlighted field" : `${errorCount} highlighted fields`} and save again.</div>
      )}
      {serverError !== null && <ErrorNotice error={serverError} title="Couldn't save the source" />}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Saving…" : editing ? "Save changes" : "Save and test"}
        </button>
        {onCancel && <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>}
      </div>
    </form>
  );
}
