#!/usr/bin/env node
// End-to-end run against the REAL backend.
//
// 1. Creates a temporary portal DB, a temporary source DB with a `beds` table,
//    and a unique read-only role (names carry a random suffix so parallel runs
//    never collide).
// 2. Runs Alembic migrations and starts uvicorn on a free port.
// 3. Starts Vite on a free port, proxying /api and /ws to that backend.
// 4. Runs the Playwright specs in this folder.
// 5. Always stops both servers and drops the DBs and role.
//
// Needs: psql on PATH, Postgres reachable via LIVEOPS_TEST_PG_DSN
// (default postgresql://postgres:postgres@localhost:5432/postgres), backend
// Python deps installed, Chromium for Playwright.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, "..");
const backend = join(frontend, "..", "backend");
const adminDsn = new URL(process.env.LIVEOPS_TEST_PG_DSN ?? "postgresql://postgres:postgres@localhost:5432/postgres");

const sfx = randomBytes(4).toString("hex");
const portalDb = `liveops_e2e_portal_${sfx}`;
const sourceDb = `liveops_e2e_src_${sfx}`;
const roRole = `liveops_e2e_ro_${sfx}`;
const roPassword = randomBytes(12).toString("hex");
const logDir = mkdtempSync(join(tmpdir(), "liveops-e2e-"));

const dsnFor = (db) => { const u = new URL(adminDsn); u.pathname = `/${db}`; return u.toString(); };

function psql(db, sql) {
  const r = spawnSync("psql", [dsnFor(db), "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed on ${db}: ${r.stderr || r.error}`);
  return r.stdout;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, what, ms = 90_000) {
  const until = Date.now() + ms;
  let last = "";
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e.cause?.code ?? e.message);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} didn't start within ${ms / 1000} s (${last}). Logs: ${logDir}`);
}

const children = [];
function start(name, cmd, args, opts) {
  const log = openSync(join(logDir, `${name}.log`), "a");
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ["ignore", log, log] });
  children.push({ name, child });
  child.on("exit", (code) => { if (code && !stopping) console.error(`[e2e] ${name} exited with code ${code}. Log: ${join(logDir, `${name}.log`)}`); });
  return child;
}

let stopping = false;
async function stopAll() {
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode === null) try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await Promise.all(children.map(({ child }) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } resolve(); }, 8000);
    child.on("exit", () => { clearTimeout(t); resolve(); });
  })));
}

function cleanupDbs() {
  const admin = adminDsn.pathname.replace(/^\//, "") || "postgres";
  for (const sql of [
    `DROP DATABASE IF EXISTS ${portalDb} WITH (FORCE)`,
    `DROP DATABASE IF EXISTS ${sourceDb} WITH (FORCE)`,
    `DROP ROLE IF EXISTS ${roRole}`,
  ]) {
    try { psql(admin, sql); } catch (e) { console.error(`[e2e] cleanup: ${e.message}`); }
  }
}

let code = 1;
const onSignal = async () => { await stopAll(); cleanupDbs(); process.exit(130); };
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

try {
  const admin = adminDsn.pathname.replace(/^\//, "") || "postgres";
  console.log(`[e2e] creating ${portalDb}, ${sourceDb} and role ${roRole}`);
  psql(admin, `CREATE DATABASE ${portalDb}`);
  psql(admin, `CREATE DATABASE ${sourceDb}`);
  psql(admin, `CREATE ROLE ${roRole} LOGIN PASSWORD '${roPassword}'`);
  psql(sourceDb, `
    CREATE TABLE beds (bed_id text PRIMARY KEY, unit text NOT NULL, status text NOT NULL, bed_label text, patient_count int);
    INSERT INTO beds VALUES
      ('B01', 'ICU', 'occupied', 'Bed 01', 1),
      ('B02', 'ICU', 'vacant', 'Bed 02', 0),
      ('B03', 'Ward 4', 'cleaning', 'Bed 03', 0),
      ('B04', 'Ward 4', 'occupied', 'Bed 04', 1);
    REVOKE ALL ON DATABASE ${sourceDb} FROM PUBLIC;
    GRANT CONNECT ON DATABASE ${sourceDb} TO ${roRole};
    GRANT USAGE ON SCHEMA public TO ${roRole};
    GRANT SELECT ON beds TO ${roRole};
  `);

  const apiPort = await freePort();
  const webPort = await freePort();
  const portalUrl = dsnFor(portalDb).replace(/^postgres(ql)?:/, "postgresql+psycopg:");
  const secretKey = randomBytes(32).toString("base64url") + "=";

  console.log(`[e2e] backend on :${apiPort}, vite on :${webPort}, logs in ${logDir}`);
  start("backend", "bash", ["-c", `alembic upgrade head && exec uvicorn app.main:app --host 127.0.0.1 --port ${apiPort}`], {
    cwd: backend,
    env: { ...process.env, LIVEOPS_DATABASE_URL: portalUrl, LIVEOPS_SECRET_KEY: secretKey, LIVEOPS_LOG_LEVEL: "INFO" },
  });
  start("vite", join(frontend, "node_modules", ".bin", "vite"),
    ["--config", join(here, "vite.e2e.config.ts"), "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
      cwd: frontend,
      env: { ...process.env, LIVEOPS_E2E_API: `http://127.0.0.1:${apiPort}` },
    });
  await waitFor(`http://127.0.0.1:${apiPort}/api/health`, "Backend");
  await waitFor(`http://127.0.0.1:${webPort}/`, "Vite");

  const pw = spawnSync(join(frontend, "node_modules", ".bin", "playwright"), ["test", "-c", join(here, "playwright.config.ts"), ...process.argv.slice(2)], {
    cwd: frontend,
    stdio: "inherit",
    env: {
      ...process.env,
      E2E_BASE_URL: `http://127.0.0.1:${webPort}`,
      E2E_OUTPUT_DIR: join(logDir, "results"),
      E2E_SOURCE_HOST: adminDsn.hostname,
      E2E_SOURCE_PORT: adminDsn.port || "5432",
      E2E_SOURCE_DB: sourceDb,
      E2E_SOURCE_DSN: dsnFor(sourceDb),
      E2E_RO_USER: roRole,
      E2E_RO_PASSWORD: roPassword,
    },
  });
  code = pw.status ?? 1;
  if (code !== 0) {
    console.error(`[e2e] failed. Backend log tail (${join(logDir, "backend.log")}):`);
    console.error(readFileSync(join(logDir, "backend.log"), "utf8").split("\n").slice(-40).join("\n"));
  }
} catch (e) {
  console.error(`[e2e] ${e.message}`);
  code = 1;
} finally {
  await stopAll();
  cleanupDbs();
  console.log(`[e2e] cleaned up ${portalDb}, ${sourceDb}, ${roRole}`);
}
process.exit(code);
