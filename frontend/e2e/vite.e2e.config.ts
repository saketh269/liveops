// Vite config for the end-to-end run: same app, proxy pointed at the
// temporary backend that e2e/run.mjs starts (LIVEOPS_E2E_API).
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

const api = process.env.LIVEOPS_E2E_API ?? "http://127.0.0.1:8000";

export default mergeConfig(
  base,
  defineConfig({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: {
      proxy: {
        "/api": api,
        "/ws": { target: api.replace(/^http/, "ws"), ws: true },
      },
    },
  }),
);
