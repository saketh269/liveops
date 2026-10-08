// LIVEOPS-169: sign in with email and password; SSO buttons when the install offers them.
import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import type { SsoProvider } from "../../api/types";
import AuthLayout from "../AuthLayout";
import { safeNext, useAuth } from "../AuthProvider";
import { authApi } from "../authApi";
import { FormAlert, PasswordField, TextField } from "../fields";
import { isEmail } from "../password";

function waitText(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  return m <= 1 ? "about a minute" : `about ${m} minutes`;
}

/** Plain words for sign-in failures. 401 never says whether the email exists. */
export function signInError(e: unknown): unknown {
  if (e instanceof ApiError && e.status === 401) {
    return "That email and password don't match. Check them and try again.";
  }
  if (e instanceof ApiError && e.status === 423) {
    const wait = e.retryAfter ? `Try again in ${waitText(e.retryAfter)}, or reset your password.` : "Wait 15 minutes and try again, or reset your password.";
    return { message: "This account is locked after too many failed sign-ins.", hint: wait };
  }
  if (e instanceof ApiError && e.status === 429) {
    const wait = e.retryAfter ? `Try again in ${waitText(e.retryAfter)}.` : "Wait a few minutes and try again.";
    return { message: "Too many sign-in attempts from this network.", hint: wait };
  }
  return e;
}

function ssoInfo(p: SsoProvider): { id: string; name: string; url: string } {
  const id = typeof p === "string" ? p : p.id;
  const name = typeof p === "string" ? p : p.name ?? p.id;
  const url = typeof p === "string" || !p.url ? `/api/auth/sso/${encodeURIComponent(id)}` : p.url;
  return { id, name: name.charAt(0).toUpperCase() + name.slice(1), url };
}

export default function SignInPage() {
  const { state, signedIn } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const sso = (state?.sso ?? []).map(ssoInfo);
  const reason = params.get("reason");

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const errs: typeof errors = {};
    if (!isEmail(email)) errs.email = email.trim() ? "Enter a full email address, like name@hospital.org." : "Enter your email address.";
    if (!password) errs.password = "Enter your password.";
    setErrors(errs);
    setError(null);
    if (errs.email) return emailRef.current?.focus();
    if (errs.password) return pwRef.current?.focus();
    setBusy(true);
    try {
      const me = await authApi.signin({ email: email.trim(), password, remember });
      signedIn(me);
      navigate(next, { replace: true });
    } catch (e) {
      setError(signInError(e));
      setBusy(false);
      pwRef.current?.select();
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      lead="Welcome back. Sign in to see your live operations."
      footer={state?.signup_open ? <>New to Live Ops? <Link to="/signup">Create an account</Link></> : undefined}
    >
      {reason === "reset" && <div className="notice info" role="status">Your password was changed. Sign in with the new one.</div>}
      {sso.length > 0 && (
        <>
          <div className="au-sso">
            {sso.map((p) => <a key={p.id} className="btn" href={`${p.url}?next=${encodeURIComponent(next)}`}>Continue with {p.name}</a>)}
          </div>
          <div className="au-divider">or use your email</div>
        </>
      )}
      <form className="au-form" onSubmit={submit} noValidate aria-label="Sign in">
        <TextField
          ref={emailRef} label="Email" type="email" name="email" autoComplete="username" inputMode="email" autoFocus required
          value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email}
        />
        <PasswordField
          ref={pwRef} label="Password" name="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password}
          aside={<Link to="/forgot">Forgot password?</Link>}
        />
        <label className="au-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Keep me signed in for 30 days</span>
        </label>
        <FormAlert error={error} />
        <button type="submit" className="btn primary au-submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </AuthLayout>
  );
}
