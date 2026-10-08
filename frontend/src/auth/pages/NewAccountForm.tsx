// The organisation + first admin form shared by sign-up (LIVEOPS-170) and first-run setup.
import { useRef, useState, type FormEvent } from "react";
import type { Me } from "../../api/types";
import { FormAlert, PasswordField, TextField } from "../fields";
import { isEmail, MIN_PASSWORD, passwordProblem } from "../password";

export type NewAccount = { org_name: string; name: string; email: string; password: string; accept_terms: boolean };
type Errors = Partial<Record<keyof NewAccount, string>>;

export function validateNewAccount(v: NewAccount, needTerms: boolean): Errors {
  const errs: Errors = {};
  if (!v.name.trim()) errs.name = "Enter your name.";
  if (!isEmail(v.email)) errs.email = v.email.trim() ? "Enter a full email address, like name@hospital.org." : "Enter your work email.";
  if (!v.org_name.trim()) errs.org_name = "Enter your organisation's name.";
  const pw = passwordProblem(v.password, v.email);
  if (pw) errs.password = pw;
  if (needTerms && !v.accept_terms) errs.accept_terms = "Accept the terms to continue.";
  return errs;
}

const ORDER: (keyof NewAccount)[] = ["name", "email", "org_name", "password", "accept_terms"];

export default function NewAccountForm({ submitLabel, busyLabel, terms, onSubmit, label }: {
  submitLabel: string; busyLabel: string; terms: boolean; label: string;
  onSubmit: (v: NewAccount) => Promise<Me>;
}) {
  const [v, setV] = useState<NewAccount>({ org_name: "", name: "", email: "", password: "", accept_terms: false });
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refs = useRef<Partial<Record<keyof NewAccount, HTMLInputElement | null>>>({});
  const set = <K extends keyof NewAccount>(k: K, val: NewAccount[K]) => setV((o) => ({ ...o, [k]: val }));
  const reg = (k: keyof NewAccount) => (el: HTMLInputElement | null) => { refs.current[k] = el; };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const errs = validateNewAccount(v, terms);
    setErrors(errs);
    setError(null);
    const first = ORDER.find((k) => errs[k]);
    if (first) return refs.current[first]?.focus();
    setBusy(true);
    try {
      await onSubmit({ ...v, email: v.email.trim(), name: v.name.trim(), org_name: v.org_name.trim() });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <form className="au-form" onSubmit={submit} noValidate aria-label={label}>
      <TextField ref={reg("name")} label="Your name" name="name" autoComplete="name" autoFocus required
        value={v.name} onChange={(e) => set("name", e.target.value)} error={errors.name} />
      <TextField ref={reg("email")} label="Work email" type="email" name="email" autoComplete="email" inputMode="email" required
        value={v.email} onChange={(e) => set("email", e.target.value)} error={errors.email} />
      <TextField ref={reg("org_name")} label="Organisation name" name="organization" autoComplete="organization" required
        value={v.org_name} onChange={(e) => set("org_name", e.target.value)} error={errors.org_name}
        help="Your hospital or company. You can change it later." />
      <PasswordField ref={reg("password")} label="Password" name="new-password" autoComplete="new-password" required meter email={v.email}
        value={v.password} onChange={(e) => set("password", e.target.value)} error={errors.password}
        help={`At least ${MIN_PASSWORD} characters. A short sentence is easy to remember and hard to guess.`} />
      {terms && (
        <div className="field">
          <label className="au-check">
            <input ref={reg("accept_terms")} type="checkbox" checked={v.accept_terms} onChange={(e) => set("accept_terms", e.target.checked)}
              aria-invalid={errors.accept_terms ? true : undefined} aria-describedby={errors.accept_terms ? "au-terms-err" : undefined} />
            <span>I accept the terms of service and privacy notice.</span>
          </label>
          {errors.accept_terms && <div className="err" id="au-terms-err">{errors.accept_terms}</div>}
        </div>
      )}
      <FormAlert error={error} />
      <button type="submit" className="btn primary au-submit" disabled={busy}>{busy ? busyLabel : submitLabel}</button>
    </form>
  );
}
