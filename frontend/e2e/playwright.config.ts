import { defineConfig } from "@playwright/test";

// Run through `npm run test:e2e` (e2e/run.mjs), which starts the real backend
// and Vite on free ports and sets E2E_BASE_URL.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
  },
  outputDir: process.env.E2E_OUTPUT_DIR ?? "test-results",
// Random free-ish port so parallel agents/CI jobs don't collide. Set once in the
// main process; workers inherit the environment.
process.env.BENCH_PORT ||= String(20000 + Math.floor(Math.random() * 20000));
const port = Number(process.env.BENCH_PORT);

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts$/,
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../test-results",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    launchOptions: {
      // Lets headless Chromium use SwiftShader (software WebGL) when no GPU is present.
      args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", ...(process.env.BENCH_CHROME_ARGS?.split(" ").filter(Boolean) ?? [])],
    },
  },
  webServer: {
    // Serves the production build (run `npm run build` first; `npm run bench:map` does).
    command: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: "..",
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
