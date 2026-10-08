// LIVEOPS-170: public sign-up (only when an organisation allows it) and first-run setup.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Me } from "../../api/types";
import AuthLayout from "../AuthLayout";
import { useAuth } from "../AuthProvider";
import { authApi } from "../authApi";
import { DoneIcon } from "./icons";
import NewAccountForm from "./NewAccountForm";

export function SignUpPage() {
  const { state, signedIn } = useAuth();
  const navigate = useNavigate();
  const [created, setCreated] = useState<Me | null>(null);

  if (created) {
    return (
      <AuthLayout title="Check your email to verify" focusHeading>
        <div className="au-done">
          <DoneIcon />
          <p>We sent a verification link to <strong>{created.email}</strong>. Open it to confirm the address.</p>
          <p className="muted">Your account for {created.org.name} is ready. You can start setting up now and verify later.</p>
          <button type="button" className="btn primary au-submit" onClick={() => { signedIn(created); navigate("/", { replace: true }); }}>
            Continue to Live Ops
          </button>
        </div>
      </AuthLayout>
    );
  }

  if (!state?.signup_open) {
    return (
      <AuthLayout title="Sign-up is closed" lead="New accounts on this Live Ops are created by an administrator." footer={<Link to="/signin">Back to sign in</Link>}>
        <p>Ask your Live Ops administrator to invite you. You'll get an email with a link to set your password.</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      lead="Set up Live Ops for your organisation. You'll be its administrator."
      footer={<>Already have an account? <Link to="/signin">Sign in</Link></>}
    >
      <NewAccountForm
        label="Create your account" submitLabel="Create account" busyLabel="Creating account…" terms
        onSubmit={async (v) => { const me = await authApi.signup(v); setCreated(me); return me; }}
      />
    </AuthLayout>
  );
}

export function SetupPage() {
  const { signedIn } = useAuth();
  const navigate = useNavigate();
  return (
    <AuthLayout
      title="Create your admin account"
      lead="This Live Ops has no accounts yet. Create the first one; it can manage everything, including other users."
    >
      <NewAccountForm
        label="Create your admin account" submitLabel="Create admin account" busyLabel="Creating…" terms={false}
        onSubmit={async ({ org_name, name, email, password }) => {
          const me = await authApi.setup({ org_name, name, email, password });
          signedIn(me);
          navigate("/", { replace: true });
          return me;
        }}
      />
    </AuthLayout>
  );
}
