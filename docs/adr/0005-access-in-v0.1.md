# ADR 0005: Local-only access until sign-in ships

Date: 2026-10-07 · Status: accepted · Fixes: LIVEOPS-15 (mitigation), 33, 37

## Context

v0.1 has no user sign-in. Security review showed the compose file published
the portal on every network interface, the backend accepted any Host header
(DNS rebinding) and the WebSocket accepted any Origin.

## Decision

- Compose publishes the portal on `127.0.0.1:8080` only.
- nginx answers only to `localhost`, `127.0.0.1` and `[::1]`; the backend uses
  `TrustedHostMiddleware` with `LIVEOPS_ALLOWED_HOSTS`, and the WebSocket
  refuses Origins whose host is not in that list.
- Validation errors never echo submitted values (passwords).
- The frontend container runs as non-root (`nginx-unprivileged`).
- Sign-in (OIDC/SAML, roles, audit log) is a Phase 6 story. Until then the
  README states the portal must not be exposed beyond the local machine.

## Consequences

Safe for a single user on their own computer. Sharing with a team requires
the sign-in story first.
