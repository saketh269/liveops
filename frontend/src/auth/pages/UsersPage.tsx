// LIVEOPS-171: users and organisation settings (admins only).
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AccountUser, OrgSettings, Role } from "../../api/types";
import { ErrorNotice, Loading } from "../../components/ui";
import { useAuth } from "../AuthProvider";
import { authApi } from "../authApi";
import Dialog from "../Dialog";
import { CopyField, FormAlert, PasswordField, StatusLine, TextField } from "../fields";
import { isEmail, MIN_PASSWORD, passwordProblem } from "../password";
import { ROLES, roleLabel, statusLabel, when } from "./format";
import "../auth.css";

type RowNote = { kind: "invite" | "reset"; link: string } | { kind: "error"; error: unknown };

function OrgSettingsPanel() {
  const [org, setOrg] = useState<OrgSettings | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const load = useCallback(() => authApi.org().then((o) => { setOrg(o); setName(o.name); setOpen(o.signup_open); setLoadError(null); }, setLoadError), []);
  useEffect(() => { void load(); }, [load]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setSaved("");
    setError(null);
    if (!name.trim()) return setErr("Enter the organisation's name.");
    setErr(null);
    setBusy(true);
    try {
      const o = await authApi.updateOrg({ name: name.trim(), signup_open: open });
      setOrg(o);
      setName(o.name);
      setOpen(o.signup_open);
      setSaved("Organisation settings saved.");
      void refresh(); // the header and sign-in page read the org name and sign-up switch
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel au-section" aria-labelledby="au-org-h">
      <header><div><h2 id="au-org-h">Organisation</h2></div></header>
      {loadError !== null && <ErrorNotice error={loadError} title="Couldn't load organisation settings" onRetry={load} />}
      {!org && loadError === null && <Loading label="Loading organisation…" />}
      {org && (
        <form className="au-narrow" onSubmit={submit} noValidate aria-label="Organisation settings">
          <TextField label="Organisation name" name="organization" value={name} onChange={(e) => setName(e.target.value)} error={err} required />
          <label className="au-toggle">
            <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} aria-describedby="au-signup-help" />
            <span>
              <strong>Allow public sign-up</strong>
              <span className="help" id="au-signup-help">Anyone who can reach this Live Ops can create a new organisation and account. Leave it off to add people by invitation only.</span>
            </span>
          </label>
          <FormAlert error={error} title="Couldn't save organisation settings" />
          <div className="row-actions"><button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button></div>
          <StatusLine>{saved}</StatusLine>
        </form>
      )}
    </section>
  );
}

type AddResult = { user: AccountUser; link: string | null };

function AddUserDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (u: AccountUser) => void }) {
  const [mode, setMode] = useState<"invite" | "password">("invite");
  const [v, setV] = useState({ name: "", email: "", role: "viewer" as Role, password: "" });
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddResult | null>(null);
  const refs = { name: useRef<HTMLInputElement>(null), email: useRef<HTMLInputElement>(null), password: useRef<HTMLInputElement>(null) };
  const doneBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (result) doneBtn.current?.focus(); }, [result]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    const errs: typeof errors = {};
    if (!v.name.trim()) errs.name = "Enter their name.";
    if (!isEmail(v.email)) errs.email = v.email.trim() ? "Enter a full email address." : "Enter their email address.";
    if (mode === "password") { const p = passwordProblem(v.password, v.email); if (p) errs.password = p; }
    setErrors(errs);
    const first = (["name", "email", "password"] as const).find((k) => errs[k]);
    if (first) return refs[first].current?.focus();
    setBusy(true);
    try {
      const r = await authApi.createUser({
        email: v.email.trim(), name: v.name.trim(), role: v.role, mode, ...(mode === "password" ? { password: v.password } : {}),
      });
      onAdded(r.user);
      setResult({ user: r.user, link: r.invite_link ?? null });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Dialog title={`${result.user.name} added`} onClose={onClose}>
        {result.link ? (
          <>
            <p>We emailed an invitation to <strong>{result.user.email}</strong>. If email isn't set up, send them this link yourself. It works once.</p>
            <CopyField label="Invitation link" value={result.link} />
          </>
        ) : (
          <p>{result.user.name} can sign in now as <strong>{result.user.email}</strong> with the password you set. Share it with them privately.</p>
        )}
        <div className="row-actions"><button ref={doneBtn} type="button" className="btn primary" onClick={onClose}>Done</button></div>
      </Dialog>
    );
  }

  const role = ROLES.find((r) => r.value === v.role);
  return (
    <Dialog title="Add user" onClose={onClose}>
      <form className="au-form" onSubmit={submit} noValidate aria-label="Add user">
        <fieldset className="au-seg" style={{ padding: 0 }}>
          <legend className="sr-only">How they get access</legend>
          <label><input type="radio" name="mode" value="invite" checked={mode === "invite"} onChange={() => setMode("invite")} />Send an invite</label>
          <label><input type="radio" name="mode" value="password" checked={mode === "password"} onChange={() => setMode("password")} />Set a password</label>
        </fieldset>
        <TextField ref={refs.name} label="Name" name="name" autoComplete="off" required value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} />
        <TextField ref={refs.email} label="Email" type="email" name="email" autoComplete="off" inputMode="email" required value={v.email}
          onChange={(e) => setV({ ...v, email: e.target.value })} error={errors.email} />
        <div className="field au-field">
          <label htmlFor="au-add-role">Role</label>
          <select id="au-add-role" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value as Role })} aria-describedby="au-add-role-help">
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <div className="help" id="au-add-role-help">{role?.help}</div>
        </div>
        {mode === "password" && (
          <PasswordField ref={refs.password} label="Password" name="new-password" autoComplete="new-password" required meter email={v.email}
            value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} error={errors.password}
            help={`At least ${MIN_PASSWORD} characters. They can change it in My account.`} />
        )}
        <FormAlert error={error} title="Couldn't add the user" />
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Adding…" : mode === "invite" ? "Send invite" : "Add user"}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}

function UserRow({ u, me, onChanged }: { u: AccountUser; me: string; onChanged: (u: AccountUser) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<RowNote | null>(null);
  const isMe = u.id === me;
  const st = statusLabel(u.status);

  const run = async (key: string, fn: () => Promise<RowNote | null | void>) => {
    setBusy(key);
    setNote(null);
    try {
      const n = await fn();
      if (n) setNote(n);
    } catch (e) {
      setNote({ kind: "error", error: e });
    } finally {
      setBusy(null);
    }
  };
  const patch = (b: Parameters<typeof authApi.updateUser>[1]) => async () => { onChanged(await authApi.updateUser(u.id, b)); };

  return (
    <>
      <tr>
        <td className="au-cell-user" data-label="Name">
          <strong>{u.name}</strong>{isMe && <span className="muted"> (you)</span>}
        </td>
        <td data-label="Email" className="au-cell-email">{u.email}</td>
        <td data-label="Role">
          <select aria-label={`Role for ${u.name}`} value={u.role} disabled={busy !== null}
            onChange={(e) => run("role", patch({ role: e.target.value as Role }))}>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </td>
        <td data-label="Status"><span className={`pill ${st.tone}`}>{st.text}</span></td>
        <td data-label="Last sign-in">{u.last_sign_in_at ? when(u.last_sign_in_at) : <span className="muted">Never</span>}</td>
        <td className="au-cell-actions" data-label="Actions">
          <div className="au-row-actions">
            {u.status === "invited" && (
              <button type="button" className="btn" disabled={busy !== null} aria-label={`Resend invite to ${u.name}`}
                onClick={() => run("invite", async () => ({ kind: "invite", link: (await authApi.resendInvite(u.id)).invite_link }))}>
                {busy === "invite" ? "Sending…" : "Resend invite"}
              </button>
            )}
            {u.status === "active" && (
              <button type="button" className="btn" disabled={busy !== null} aria-label={`Reset password for ${u.name}`}
                onClick={() => run("reset", async () => ({ kind: "reset", link: (await authApi.resetUserPassword(u.id)).reset_link }))}>
                {busy === "reset" ? "Creating link…" : "Reset password"}
              </button>
            )}
            {!isMe && (u.status === "disabled" ? (
              <button type="button" className="btn" disabled={busy !== null} aria-label={`Reactivate ${u.name}`} onClick={() => run("status", patch({ status: "active" }))}>
                {busy === "status" ? "Saving…" : "Reactivate"}
              </button>
            ) : (
              <button type="button" className="btn danger" disabled={busy !== null} aria-label={`Deactivate ${u.name}`} onClick={() => run("status", patch({ status: "disabled" }))}>
                {busy === "status" ? "Saving…" : "Deactivate"}
              </button>
            ))}
          </div>
        </td>
      </tr>
      {note && (
        <tr className="au-row-note">
          <td colSpan={6}>
            {note.kind === "error" ? (
              <FormAlert error={note.error} title={`Couldn't update ${u.name}`} />
            ) : (
              <CopyField
                label={note.kind === "invite" ? `New invitation link for ${u.name}` : `Password reset link for ${u.name}`}
                value={note.link}
                help={note.kind === "invite" ? "Emailed to them too. It works once." : "Emailed to them too. It works once; their current sessions end when they use it."}
              />
            )}
            <button type="button" className="btn link" onClick={() => setNote(null)}>Dismiss</button>
          </td>
        </tr>
      )}
    </>
  );
}

export default function UsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AccountUser[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [announce, setAnnounce] = useState("");
  const load = useCallback(() => authApi.users().then((u) => { setUsers(u); setError(null); }, setError), []);
  useEffect(() => { void load(); document.title = "Users · Live Ops"; }, [load]);
  const replace = (u: AccountUser) => {
    setUsers((list) => (list ?? []).map((x) => (x.id === u.id ? u : x)));
    setAnnounce(`${u.name}: ${roleLabel(u.role)}, ${statusLabel(u.status).text}.`);
  };

  return (
    <section className="au-app">
      <div className="page-head">
        <div><h1>Users</h1><p className="lead">Who can use Live Ops in {user?.org.name ?? "your organisation"}, and what they can do.</p></div>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add user</button>
      </div>
      <StatusLine>{announce}</StatusLine>
      {error !== null && <ErrorNotice error={error} title="Couldn't load users" onRetry={load} />}
      {!users && error === null && <Loading label="Loading users…" />}
      {users && (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="au-users">
            <caption className="sr-only">Users</caption>
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last sign-in</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {[...users].sort((a, b) => a.name.localeCompare(b.name)).map((u) => (
                <UserRow key={u.id} u={u} me={user?.id ?? ""} onChanged={replace} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <OrgSettingsPanel />
      {adding && (
        <AddUserDialog
          onClose={() => setAdding(false)}
          onAdded={(u) => { setUsers((list) => [...(list ?? []).filter((x) => x.id !== u.id), u]); setAnnounce(`Added ${u.name}.`); }}
        />
      )}
    </section>
  );
}
