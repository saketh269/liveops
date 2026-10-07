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
});
