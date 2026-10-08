// Who is signed in, and the route guards built on it (ADR 0008, LIVEOPS-169..172).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { ApiError, isAuthPage, setUnauthorizedHandler } from "../api/client";
import type { AuthState, Me, Role } from "../api/types";
import { authApi } from "./authApi";

type Status = "loading" | "ready" | "error";

export type AuthValue = {
  status: Status;
  error: unknown;
  state: AuthState | null;
  user: Me | null;
  /** Re-read /api/auth/state and /api/auth/me. */
  refresh: () => Promise<void>;
  /** Store the Me returned by sign-in, setup, sign-up or invite accept. */
  signedIn: (me: Me) => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}

/** Roles that may change things (sources, sites, mappings, layouts). */
export function canEdit(role: Role | undefined): boolean {
  return role === "admin" || role === "manager";
}

/**
 * The signed-in user's role, or undefined outside an AuthProvider (page tests render pages
 * on their own; the API still enforces roles).
 */
export function useRole(): Role | undefined {
  return useContext(AuthContext)?.user?.role;
}

/** True when the user may change things. Outside an AuthProvider (page tests) everything is allowed. */
export function useCanEdit(): boolean {
  const ctx = useContext(AuthContext);
  return !ctx || canEdit(ctx.user?.role);
}

/** Renders its children only for roles that can edit. */
export function CanEdit({ children }: { children: ReactNode }) {
  return useCanEdit() ? <>{children}</> : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<unknown>(null);
  const [state, setState] = useState<AuthState | null>(null);
  const [user, setUser] = useState<Me | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const refresh = useCallback(async () => {
    try {
      const st = await authApi.state();
      setState(st);
      let me: Me | null = null;
      if (!st.setup_required) {
        try {
          me = await authApi.me();
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 401)) throw e;
        }
      }
      setUser(me);
      setError(null);
      setStatus("ready");
    } catch (e) {
      setError(e);
      setStatus("error");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Any API call that comes back 401 means the session ended: drop the user so the guard redirects.
  const here = location.pathname + location.search;
  useEffect(() => setUnauthorizedHandler(() => {
    setUser(null);
    if (!isAuthPage(window.location.pathname)) navigate(`/signin?next=${encodeURIComponent(here)}`, { replace: true });
  }), [navigate, here]);

  const signedIn = useCallback((me: Me) => {
    setUser(me);
    setState((s) => (s ? { ...s, setup_required: false } : s));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await authApi.signout();
    } finally {
      setUser(null);
      navigate("/signin", { replace: true });
    }
  }, [navigate]);

  const value = useMemo<AuthValue>(
    () => ({ status, error, state, user, refresh, signedIn, signOut }),
    [status, error, state, user, refresh, signedIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Only same-site paths are allowed as a return target; never back to an auth page. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  try {
    const u = new URL(raw, "http://x.invalid");
    if (u.origin !== "http://x.invalid" || isAuthPage(u.pathname)) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

/** Guards the app: signed-out users go to /signin?next=…, a fresh install to /setup. */
export function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { status, state, user } = useAuth();
  const location = useLocation();
  if (status !== "ready") return null; // AuthGate shows loading / error
  if (state?.setup_required) return <Navigate to="/setup" replace />;
  if (!user) {
    const next = location.pathname + location.search;
    return <Navigate to={next === "/" ? "/signin" : `/signin?next=${encodeURIComponent(next)}`} replace />;
  }
  if (roles && !roles.includes(user.role)) return <Navigate to={user.role === "wallboard" ? "/map" : "/"} replace />;
  return <>{children}</>;
}

/** Sign-in, sign-up and setup are for signed-out visitors; a signed-in user goes on to `next`. */
export function SignedOutOnly({ children, setup = false }: { children: ReactNode; setup?: boolean }) {
  const { status, state, user } = useAuth();
  const location = useLocation();
  if (status !== "ready") return null;
  if (setup && !state?.setup_required) return <Navigate to="/signin" replace />;
  if (!setup && state?.setup_required) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to={safeNext(new URLSearchParams(location.search).get("next"))} replace />;
  return <>{children}</>;
}
