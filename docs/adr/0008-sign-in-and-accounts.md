# ADR 0008: Sign-in and accounts (replaces the local-only rule of ADR 0005)

Status: accepted · Tickets: LIVEOPS-168 (foundation), 169 (sign-in page), 170 (sign-up page),
171 (account creation / user management), 172 (forgot password, verification, My account).
Later: 163 (SSO, per-site roles), 164 (privacy masking, audit log UI).

## Decision

Live Ops gets its own accounts. Every API route and the live WebSocket require a signed-in user,
except the routes listed under "Open routes". One install = one or more organisations; every user
belongs to exactly one organisation. (Sites/sources are not yet split per organisation: in this
release all organisations on an install see the same sites. Per-organisation data separation is
part of LIVEOPS-163.)

### Data (migration 0003_accounts)
- `organisations`: id (uuid str), name, signup_open (bool, default false), created_at
- `users`: id, org_id → organisations, email (unique, stored lower-case), name, password_hash
  (Argon2id via `argon2-cffi`), role (`admin` | `manager` | `viewer` | `wallboard`),
  status (`invited` | `active` | `disabled`), email_verified_at, last_sign_in_at, failed_attempts,
  locked_until, created_at
- `sessions`: id (random 32-byte token, only its SHA-256 stored), user_id, created_at, last_seen_at,
  expires_at, user_agent, ip
- `user_tokens`: id, user_id, purpose (`invite` | `reset` | `verify`), token_hash (SHA-256),
  expires_at, used_at — single-use
- `api_tokens`: id, user_id, name, token_hash, created_at, last_used_at — for scripts
  (`Authorization: Bearer lo_…`), e.g. `tools/riverside-mock/setup_site.py --token`
- `audit_log`: id, at, user_id (nullable), action (e.g. `user.create`, `user.role`, `signin.fail`),
  target, detail (json, never passwords or tokens)

### Sessions
- Cookie `liveops_session`: HttpOnly, SameSite=Lax, Path=/, Secure when the request is HTTPS
  (or `LIVEOPS_COOKIE_SECURE=true`). 12 h sliding; "remember me" = 30 days.
- CSRF: double-submit. Sign-in sets a readable cookie `liveops_csrf`; every unsafe request
  (POST/PUT/PATCH/DELETE) with a session cookie must send header `X-CSRF-Token` equal to it.
  Requests with a Bearer API token skip CSRF.
- WebSocket `/ws/sites/{site_id}`: authenticated by the session cookie (plus the existing Origin check).
- Failed sign-ins: 5 in a row → locked 15 minutes. Per-IP limit 20 sign-in attempts / 5 min.
  Messages never reveal whether an email exists.

### API (all JSON, under `/api/auth` unless noted)
| Method & path | Who | Body → result |
|---|---|---|
| GET `/api/auth/state` | open | `{setup_required: bool, signup_open: bool, sso: []}` — `setup_required` when no users exist |
| POST `/api/auth/setup` | open, only while no users exist | `{org_name, name, email, password}` → creates org + first admin, signs in → `Me` |
| POST `/api/auth/signin` | open | `{email, password, remember}` → `Me` (sets cookies) / 401 `{detail:{message}}` / 423 locked |
| POST `/api/auth/signout` | user | → 204 |
| GET `/api/auth/me` | user | → `Me = {id, email, name, role, org: {id, name}, email_verified}` / 401 |
| POST `/api/auth/signup` | open, only if any org has `signup_open` or env `LIVEOPS_PUBLIC_SIGNUP=true` | `{org_name, name, email, password, accept_terms}` → new org + admin, verification email → `Me` |
| POST `/api/auth/verify` | open | `{token}` → 204 |
| POST `/api/auth/forgot` | open | `{email}` → always 204 (sends a reset link if the account exists) |
| POST `/api/auth/reset` | open | `{token, password}` → 204, signs out all sessions of that user |
| POST `/api/auth/invite/accept` | open | `{token, name, password}` → `Me` |
| PATCH `/api/auth/me` | user | `{name?}` → `Me` |
| POST `/api/auth/me/password` | user | `{current_password, new_password}` → 204, ends the user's other sessions |
| GET `/api/auth/me/sessions` | user | → `[{id, created_at, last_seen_at, user_agent, ip, current}]` |
| DELETE `/api/auth/me/sessions/{id}` / DELETE `/api/auth/me/sessions` | user | sign out one / all others |
| GET `/api/users` | admin | → `[User]` (`User = {id, email, name, role, status, last_sign_in_at, created_at}`) |
| POST `/api/users` | admin | `{email, name, role, mode: "invite"|"password", password?}` → `{user, invite_link?}` |
| PATCH `/api/users/{id}` | admin | `{role?, status?: "active"|"disabled", name?}` → `User` (can't demote/disable the last admin) |
| POST `/api/users/{id}/resend-invite` | admin | → `{invite_link}` |
| POST `/api/users/{id}/reset-password` | admin | → `{reset_link}` (also emailed) |
| GET/PATCH `/api/org` | admin | `{name, signup_open}` |
| GET/POST/DELETE `/api/auth/tokens` | user | API tokens for scripts; the plain token is shown once |

Errors use the existing shape `{detail: {message, hint?}}`. Passwords: at least 10 characters,
not equal to the email; strength meter in the UI only.

### Roles (this release)
`admin`: everything incl. users and org settings. `manager`: everything except users/org.
`viewer`: read-only (GET routes, live map, history). `wallboard`: live map + stream only.
Enforced in the API with a dependency `require_role(...)`; the UI hides what a role can't use.

### Open routes
`/api/auth/state|setup|signin|signup|verify|forgot|reset|invite/accept`, `/api/health` (liveness only; `/api/health/mappings` requires a user), and inbound webhooks
(`POST /api/webhooks/{source_id}`, they keep their own per-source secret). Everything else → 401 `{detail:{message:"Sign in to continue."}}`.

### Email
SMTP via `LIVEOPS_SMTP_HOST/PORT/USER/PASSWORD/FROM`, `LIVEOPS_PUBLIC_URL` for links. Without SMTP,
links are written to the backend log (INFO, one line) so a local install still works, and the admin
UI shows invite/reset links to copy.

### Switch for tests and upgrades
`LIVEOPS_AUTH_REQUIRED` (default **true**). The existing test suite sets it to false in its
conftest so the 600+ existing tests keep passing; the new auth tests run with it true and include
a test that walks every registered route and asserts 401 without a session.
Upgrading an existing install: the first visit shows "Create your admin account" (setup).

### Frontend
Routes `/signin`, `/signup`, `/setup`, `/forgot`, `/reset?token=`, `/verify?token=`,
`/invite?token=`, `/account` (My account), `/admin/users` (admins). An `AuthProvider` loads
`/api/auth/state` and `/api/auth/me`; unauthenticated users are sent to `/signin?next=<path>`
(or `/setup`). `api/client.ts` sends `credentials: "same-origin"` and the `X-CSRF-Token` header on
unsafe methods, and on 401 redirects to sign-in. Header shows the user's name with a menu
(My account, Users for admins, Sign out). Pages use the Live Ops look: glass card over a soft,
blurred hospital-map background, design tokens, light + dark, phone width, accessible labels.

## Consequences
The portal can be shared with a team once served over HTTPS. ADR 0005's localhost binding stays
the default in docker-compose; exposing it is now a documented, deliberate step.
