// Camera controls in a real browser (camera fix): `npm run test:camera` builds the app and
// runs camera.ui.ts against the production build with a stubbed backend (no servers needed).
import { defineConfig } from "@playwright/test";
import bench from "./bench.config";

export default defineConfig({
  ...bench,
  testMatch: /camera\.ui\.ts$/,
  use: {
    ...bench.use,
    launchOptions: { args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-gl=swiftshader"] },
  },
});
