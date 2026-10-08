# Live Ops

A live 3D operations map that connects to the systems a company already has:
databases, APIs and files. Connect a source, map its records to things on a
site, and watch them change in real time.

> Status: **v0.1.0 in development** (Sprint 1). Tracked in Jira project LIVEOPS.

## Run it (Windows, Mac or Linux)

Needs Docker Desktop.

```bash
git clone https://github.com/saketh269/liveops.git
cd liveops
cp .env.example .env        # on Windows PowerShell: copy .env.example .env
```

Open `.env` and set `LIVEOPS_SECRET_KEY` to a new random key. Generate one with
any of these (all give a 44-character key; you don't need anything installed
beyond Docker):

```bash
# Docker (any OS)
docker run --rm python:3.12-slim python -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
```

```powershell
# Windows PowerShell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).Replace('+','-').Replace('/','_')
```

Keep this key safe and don't change it: it encrypts the passwords you save for
your sources. If it changes, the portal asks you to enter those passwords again.

```bash
docker compose up --build
```

Open http://localhost:8080. The first visit asks you to **create your admin
account** (organisation name, your name, email and a password of at least 10
characters). Upgrading an install from before sign-in works the same way: your
sources, sites and mappings are kept, and the first visit creates the admin.
After that, everyone signs in; admins add people under **Users** (invite link or
password) with a role: admin, manager, viewer (read-only) or wallboard (live map only).

Without email settings, invite and password-reset links appear in the admin
screen to copy, and are written to the backend log (`docker compose logs backend`).
To send them by email, set `LIVEOPS_SMTP_HOST`, `LIVEOPS_SMTP_PORT`,
`LIVEOPS_SMTP_USER`, `LIVEOPS_SMTP_PASSWORD`, `LIVEOPS_SMTP_FROM` and
`LIVEOPS_PUBLIC_URL` (the address people open, used in links) in `.env`.

> **Still local by default.** The portal listens only on your own computer.
> Before you share it with a team, serve it over HTTPS (sign-in cookies are then
> marked Secure; set `LIVEOPS_COOKIE_SECURE=true` if TLS ends at a proxy) and add
> its host name to `LIVEOPS_ALLOWED_HOSTS`. See ADR 0008.

### API tokens for scripts

Scripts use an API token instead of a password: in the app open **My account →
API tokens**, create one and copy it (it is shown once). Send it as
`Authorization: Bearer lo_…`, for example:

```bash
python tools/riverside-mock/setup_site.py --liveops http://localhost:8000 --token lo_... --site hs
```

A token acts with your role and stops working when you delete it or your account
is turned off. On a local dev install, `--email you@example.org --password ...`
signs in instead.

## Update to a new version

```bash
git pull
docker compose up --build
```

Database migrations run automatically, so your sources, sites and mappings are kept.

## Connecting to a database on your own computer

From inside Docker, use `host.docker.internal` as the host name, not `localhost`.

## For developers

- Design and connector contract: [`docs/design.md`](docs/design.md)
- How we work, checks and ownership: [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md)
- Decisions: [`docs/adr/`](docs/adr)
- Review checklist: [`docs/review-checklist.md`](docs/review-checklist.md)
- Busy-hospital test data for the map (test tool, never shipped): [`tools/hospital-sim/`](tools/hospital-sim/README.md)
