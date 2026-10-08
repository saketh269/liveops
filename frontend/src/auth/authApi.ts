// Typed client for the sign-in and accounts API (docs/adr/0008-sign-in-and-accounts.md).
import { request as req } from "../api/client";
import type {
  AccountUser, ApiToken, AuthSession, AuthState, CreateUserResult, Me, NewApiToken, OrgSettings, Role, UserStatus,
} from "../api/types";

const enc = encodeURIComponent;

export const authApi = {
  state: () => req<AuthState>("GET", "/api/auth/state"),
  me: () => req<Me>("GET", "/api/auth/me"),
  setup: (b: { org_name: string; name: string; email: string; password: string }) => req<Me>("POST", "/api/auth/setup", b),
  signin: (b: { email: string; password: string; remember: boolean }) => req<Me>("POST", "/api/auth/signin", b),
  signout: () => req<void>("POST", "/api/auth/signout"),
  signup: (b: { org_name: string; name: string; email: string; password: string; accept_terms: boolean }) =>
    req<Me>("POST", "/api/auth/signup", b),
  verify: (token: string) => req<void>("POST", "/api/auth/verify", { token }),
  forgot: (email: string) => req<void>("POST", "/api/auth/forgot", { email }),
  reset: (token: string, password: string) => req<void>("POST", "/api/auth/reset", { token, password }),
  acceptInvite: (b: { token: string; name: string; password: string }) => req<Me>("POST", "/api/auth/invite/accept", b),

  updateMe: (b: { name?: string }) => req<Me>("PATCH", "/api/auth/me", b),
  changePassword: (b: { current_password: string; new_password: string }) => req<void>("POST", "/api/auth/me/password", b),
  sessions: () => req<AuthSession[]>("GET", "/api/auth/me/sessions"),
  endSession: (id: string) => req<void>("DELETE", `/api/auth/me/sessions/${enc(id)}`),
  endOtherSessions: () => req<void>("DELETE", "/api/auth/me/sessions"),
  tokens: () => req<ApiToken[]>("GET", "/api/auth/tokens"),
  createToken: (name: string) => req<NewApiToken>("POST", "/api/auth/tokens", { name }),
  revokeToken: (id: string) => req<void>("DELETE", `/api/auth/tokens/${enc(id)}`),

  users: () => req<AccountUser[]>("GET", "/api/users"),
  createUser: (b: { email: string; name: string; role: Role; mode: "invite" | "password"; password?: string }) =>
    req<CreateUserResult>("POST", "/api/users", b),
  updateUser: (id: string, b: { role?: Role; status?: Exclude<UserStatus, "invited">; name?: string }) =>
    req<AccountUser>("PATCH", `/api/users/${enc(id)}`, b),
  resendInvite: (id: string) => req<{ invite_link: string }>("POST", `/api/users/${enc(id)}/resend-invite`),
  resetUserPassword: (id: string) => req<{ reset_link: string }>("POST", `/api/users/${enc(id)}/reset-password`),
  org: () => req<OrgSettings>("GET", "/api/org"),
  updateOrg: (b: Partial<OrgSettings>) => req<OrgSettings>("PATCH", "/api/org", b),
};
