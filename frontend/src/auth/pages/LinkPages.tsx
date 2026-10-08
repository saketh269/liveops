// LIVEOPS-172 (frontend): forgot password, reset by link, verify email by link, accept an invite.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import AuthLayout from "../AuthLayout";
import { useAuth } from "../AuthProvider";
import { authApi } from "../authApi";
import { FormAlert, PasswordField, TextField } from "../fields";
import { isEmail, MIN_PASSWORD, passwordProblem } from "../password";
import { DoneIcon } from "./icons";

/** Expired or used links get a plain explanation and the way forward. */
function linkError(e: unknown, again: string): unknown {
  if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
    return { message: e.message || "This link has expired or was already used.", hint: e.hint ?? again };
  }
  return e;
}

const BACK = <Link to="/signin">Back to sign in</Link>;

export function ForgotPage() {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  if (sent) {
    return (
      <AuthLayout title="Check your email" footer={BACK} focusHeading>
        <div className="au-done">
          <DoneIcon />
          <p>If there's a Live Ops account for <strong>{sent}</strong>, we've sent it a link to choose a new password. The link works once.</p>
          <p className="muted">Nothing arrived after a few minutes? Check your spam folder, or ask your Live Ops administrator for a reset link.</p>
        </div>
      </AuthLayout>
    );
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    if (!isEmail(email)) {
      setErr(email.trim() ? "Enter a full email address, like name@hospital.org." : "Enter your email address.");
      return ref.current?.focus();
    }
    setErr(null);
    setBusy(true);
    try {
      await authApi.forgot(email.trim());
      setSent(email.trim());
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Reset your password" lead="Enter the email you sign in with and we'll send you a link to choose a new password." footer={BACK}>
      <form className="au-form" onSubmit={submit} noValidate aria-label="Reset your password">
        <TextField ref={ref} label="Email" type="email" name="email" autoComplete="username" inputMode="email" autoFocus required
          value={email} onChange={(e) => setEmail(e.target.value)} error={err} />
        <FormAlert error={error} />
        <button type="submit" className="btn primary au-submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
      </form>
    </AuthLayout>
  );
}

function MissingToken({ what }: { what: string }) {
  return (
    <AuthLayout title="This link is incomplete" footer={BACK} focusHeading>
      <div className="au-done">
        <DoneIcon bad />
        <p>The {what} link is missing its code. Open the link from the email again, or copy the whole address into the browser.</p>
      </div>
    </AuthLayout>
  );
}

export function ResetPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  if (!token) return <MissingToken what="password reset" />;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    const p = passwordProblem(password);
    setErr(p);
    if (p) return ref.current?.focus();
    setBusy(true);
    try {
      await authApi.reset(token, password);
      await refresh(); // the reset signs out every session, including this one
      navigate("/signin?reason=reset", { replace: true });
    } catch (e) {
      setError(linkError(e, "Ask for a new link from “Forgot password?” on the sign-in page."));
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Choose a new password" lead="After this you'll be signed out everywhere and can sign in with the new password." footer={BACK}>
      <form className="au-form" onSubmit={submit} noValidate aria-label="Choose a new password">
        <PasswordField ref={ref} label="New password" name="new-password" autoComplete="new-password" autoFocus required meter
          value={password} onChange={(e) => setPassword(e.target.value)} error={err} help={`At least ${MIN_PASSWORD} characters.`} />
        <FormAlert error={error} />
        <button type="submit" className="btn primary au-submit" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
      </form>
    </AuthLayout>
  );
}

export function VerifyPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { user, refresh } = useAuth();
  const [result, setResult] = useState<"pending" | "ok" | { error: unknown }>("pending");
  const started = useRef("");

  useEffect(() => {
    if (!token || started.current === token) return; // single-use token: never post it twice (StrictMode)
    started.current = token;
    authApi.verify(token).then(
      () => { setResult("ok"); void refresh(); },
      (e) => setResult({ error: linkError(e, user ? "Sign in and check My account; your address may already be verified." : "Sign in; if your address still isn't verified, ask your administrator.") }),
    );
  }, [token, refresh, user]);

  if (!token) return <MissingToken what="verification" />;
  const go = user ? <Link className="btn primary au-submit" to="/">Continue to Live Ops</Link> : <Link className="btn primary au-submit" to="/signin">Sign in</Link>;
  if (result === "pending") {
    return <AuthLayout title="Verifying your email…"><p className="muted" role="status">One moment.</p></AuthLayout>;
  }
  if (result === "ok") {
    return (
      <AuthLayout title="Email verified" focusHeading>
        <div className="au-done"><DoneIcon /><p>Thanks, your email address is confirmed.</p>{go}</div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="We couldn't verify your email" focusHeading>
      <FormAlert error={result.error} />
      {go}
    </AuthLayout>
  );
}

export function InvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const { signedIn } = useAuth();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  if (!token) return <MissingToken what="invitation" />;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    const errs: typeof errors = {};
    if (!name.trim()) errs.name = "Enter your name.";
    const p = passwordProblem(password);
    if (p) errs.password = p;
    setErrors(errs);
    if (errs.name) return nameRef.current?.focus();
    if (errs.password) return pwRef.current?.focus();
    setBusy(true);
    try {
      const me = await authApi.acceptInvite({ token, name: name.trim(), password });
      signedIn(me);
      navigate("/", { replace: true });
    } catch (e) {
      setError(linkError(e, "Ask your Live Ops administrator to send a new invitation."));
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Join Live Ops" lead="You've been invited. Add your name and choose a password to finish." footer={<>Already set up? <Link to="/signin">Sign in</Link></>}>
      <form className="au-form" onSubmit={submit} noValidate aria-label="Accept invitation">
        <TextField ref={nameRef} label="Your name" name="name" autoComplete="name" autoFocus required
          value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
        <PasswordField ref={pwRef} label="Password" name="new-password" autoComplete="new-password" required meter
          value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} help={`At least ${MIN_PASSWORD} characters.`} />
        <FormAlert error={error} />
        <button type="submit" className="btn primary au-submit" disabled={busy}>{busy ? "Joining…" : "Join and sign in"}</button>
      </form>
    </AuthLayout>
  );
}
