// LIVEOPS-172 (frontend): My account — name, password, active sessions, API tokens.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiToken, AuthSession, NewApiToken } from "../../api/types";
import { ErrorNotice, Loading } from "../../components/ui";
import { useAuth } from "../AuthProvider";
import { authApi } from "../authApi";
import { CopyField, FormAlert, PasswordField, StatusLine, TextField } from "../fields";
import { MIN_PASSWORD, passwordProblem } from "../password";
import { deviceName, roleLabel, when } from "./format";
import "../auth.css";

function useList<T>(load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(() => load().then((x) => { setItems(x); setError(null); }, setError), [load]);
  useEffect(() => { void reload(); }, [reload]);
  return { items, error, reload };
}

function Profile() {
  const { user, signedIn } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setSaved("");
    setError(null);
    if (!name.trim()) return setErr("Enter your name.");
    setErr(null);
    setBusy(true);
    try {
      signedIn(await authApi.updateMe({ name: name.trim() }));
      setSaved("Name saved.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel au-section" aria-labelledby="au-profile-h">
      <header><div><h2 id="au-profile-h">Profile</h2></div></header>
      <dl className="meta">
        <div><dt>Email</dt><dd>{user.email}</dd></div>
        <div><dt>Organisation</dt><dd>{user.org.name}</dd></div>
        <div><dt>Role</dt><dd>{roleLabel(user.role)}</dd></div>
      </dl>
      {!user.email_verified && (
        <div className="notice info">Your email address isn't verified yet. Open the link we emailed you to confirm it.</div>
      )}
      <form className="au-narrow" onSubmit={submit} noValidate aria-label="Profile">
        <TextField label="Name" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={err} required />
        <FormAlert error={error} title="Couldn't save your name" />
        <div className="row-actions"><button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save name"}</button></div>
        <StatusLine>{saved}</StatusLine>
      </form>
    </section>
  );
}

function ChangePassword({ onChanged }: { onChanged: () => void }) {
  const { user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string }>({});
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const curRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setSaved("");
    setError(null);
    const errs: typeof errors = {};
    if (!current) errs.current = "Enter your current password.";
    const p = passwordProblem(next, user?.email);
    if (p) errs.next = p;
    else if (next === current) errs.next = "Choose a password different from the current one.";
    setErrors(errs);
    if (errs.current) return curRef.current?.focus();
    if (errs.next) return nextRef.current?.focus();
    setBusy(true);
    try {
      await authApi.changePassword({ current_password: current, new_password: next });
      setCurrent("");
      setNext("");
      setSaved("Password changed. Your other devices were signed out.");
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel au-section" aria-labelledby="au-pw-h">
      <header><div><h2 id="au-pw-h">Password</h2><p className="muted">Changing it signs you out on every other device.</p></div></header>
      <form className="au-narrow" onSubmit={submit} noValidate aria-label="Change password">
        <input type="text" name="username" autoComplete="username" value={user?.email ?? ""} readOnly hidden />
        <PasswordField ref={curRef} label="Current password" name="current-password" autoComplete="current-password" required
          value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.current} />
        <PasswordField ref={nextRef} label="New password" name="new-password" autoComplete="new-password" required meter email={user?.email}
          value={next} onChange={(e) => setNext(e.target.value)} error={errors.next} help={`At least ${MIN_PASSWORD} characters.`} />
        <FormAlert error={error} title="Couldn't change your password" />
        <div className="row-actions"><button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : "Change password"}</button></div>
        <StatusLine>{saved}</StatusLine>
      </form>
    </section>
  );
}

function Sessions({ list }: { list: ReturnType<typeof useList<AuthSession>> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState("");
  const run = async (key: string, fn: () => Promise<void>, msg: string) => {
    setBusy(key);
    setError(null);
    setDone("");
    try {
      await fn();
      await list.reload();
      setDone(msg);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const others = (list.items ?? []).filter((s) => !s.current);
  return (
    <section className="panel au-section" aria-labelledby="au-sess-h">
      <header>
        <div><h2 id="au-sess-h">Where you're signed in</h2><p className="muted">Sign out anywhere you don't recognise, then change your password.</p></div>
        {others.length > 0 && (
          <button type="button" className="btn" disabled={busy !== null}
            onClick={() => run("all", authApi.endOtherSessions, "Signed out of all other devices.")}>
            Sign out of all other devices
          </button>
        )}
      </header>
      {list.error !== null && <ErrorNotice error={list.error} title="Couldn't load your sessions" onRetry={list.reload} />}
      {!list.items && list.error === null && <Loading label="Loading sessions…" />}
      {list.items && (
        <ul className="au-list" aria-label="Sessions">
          {[...list.items].sort((a, b) => Number(b.current) - Number(a.current)).map((s) => (
            <li key={s.id}>
              <div className="what">
                <strong>{deviceName(s.user_agent)} {s.current && <span className="pill ok">This device</span>}</strong>
                <span className="sub">
                  {s.ip ? `${s.ip} · ` : ""}Signed in {when(s.created_at)} · Last active {when(s.last_seen_at ?? s.created_at)}
                </span>
              </div>
              {!s.current && (
                <button type="button" className="btn" disabled={busy !== null} aria-label={`Sign out ${deviceName(s.user_agent)}, last active ${when(s.last_seen_at ?? s.created_at)}`}
                  onClick={() => run(s.id, () => authApi.endSession(s.id), "Signed out of that device.")}>
                  {busy === s.id ? "Signing out…" : "Sign out"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormAlert error={error} title="Couldn't sign out" />
      <StatusLine>{done}</StatusLine>
    </section>
  );
}

function Tokens() {
  const list = useList<ApiToken>(authApi.tokens);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<NewApiToken | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [done, setDone] = useState("");
  const create = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setDone("");
    if (!name.trim()) return setErr("Name the token after the script that will use it.");
    setErr(null);
    setBusy("create");
    try {
      setCreated(await authApi.createToken(name.trim()));
      setName("");
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const revoke = async (t: ApiToken) => {
    setBusy(t.id);
    setError(null);
    try {
      await authApi.revokeToken(t.id);
      if (created?.id === t.id) setCreated(null);
      setConfirm(null);
      await list.reload();
      setDone(`Revoked “${t.name}”.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="panel au-section" aria-labelledby="au-tok-h">
      <header><div><h2 id="au-tok-h">API tokens</h2><p className="muted">For scripts such as the site setup tool. A token acts as you, with your role.</p></div></header>
      <form className="au-narrow" onSubmit={create} noValidate aria-label="Create an API token">
        <TextField label="Token name" name="token-name" placeholder="e.g. Nightly layout import" value={name}
          onChange={(e) => setName(e.target.value)} error={err} autoComplete="off" />
        <div className="row-actions"><button type="submit" className="btn" disabled={busy !== null}>{busy === "create" ? "Creating…" : "Create token"}</button></div>
      </form>
      {created && (
        <div className="notice info au-narrow" style={{ maxWidth: "none" }}>
          <CopyField label={`New token “${created.name}”`} value={created.token}
            help="Copy it now: it is shown only once. Scripts send it as “Authorization: Bearer …”." />
          <div><button type="button" className="btn" onClick={() => setCreated(null)}>Done, I've copied it</button></div>
        </div>
      )}
      {list.error !== null && <ErrorNotice error={list.error} title="Couldn't load your tokens" onRetry={list.reload} />}
      {list.items && list.items.length === 0 && <p className="muted">No tokens yet.</p>}
      {list.items && list.items.length > 0 && (
        <ul className="au-list" aria-label="API tokens">
          {list.items.map((t) => (
            <li key={t.id}>
              <div className="what">
                <strong>{t.name}</strong>
                <span className="sub">Created {when(t.created_at)} · {t.last_used_at ? `Last used ${when(t.last_used_at)}` : "Never used"}</span>
              </div>
              {confirm === t.id ? (
                <div className="row-actions" role="group" aria-label={`Confirm revoke ${t.name}`}>
                  <span>Scripts using it stop working.</span>
                  <button type="button" className="btn danger solid" disabled={busy !== null} onClick={() => revoke(t)}>{busy === t.id ? "Revoking…" : "Yes, revoke"}</button>
                  <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className="btn danger" aria-label={`Revoke ${t.name}`} onClick={() => setConfirm(t.id)}>Revoke</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormAlert error={error} title="Couldn't update tokens" />
      <StatusLine>{done}</StatusLine>
    </section>
  );
}

export default function AccountPage() {
  const sessions = useList<AuthSession>(authApi.sessions);
  useEffect(() => { document.title = "My account · Live Ops"; }, []);
  return (
    <section className="au-app">
      <div className="page-head"><div><h1>My account</h1><p className="lead">Your details, password, devices and API tokens.</p></div></div>
      <Profile />
      <ChangePassword onChanged={() => void sessions.reload()} />
      <Sessions list={sessions} />
      <Tokens />
    </section>
  );
}
