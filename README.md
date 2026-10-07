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

Open `.env` and set `LIVEOPS_SECRET_KEY` (the file shows how to generate one).

```bash
docker compose up --build
```

Open http://localhost:8080.

> **Local use only in v0.1.** There is no sign-in yet, so the portal only
> listens on your own computer. Don't expose it on a network until sign-in ships.

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
