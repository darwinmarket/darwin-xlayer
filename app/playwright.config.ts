import { defineConfig } from "@playwright/test";

/**
 * Smoke tests against a running app on port 3050 reading a local fork of X Layer.
 *   npm run build && npm run e2e         (starts `next start` on 3050 unless one is already up)
 * E2E_RPC points the test wallet at the same chain the app reads (default 127.0.0.1:8546).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3050",
    headless: true,
    viewport: { width: 1360, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npx next start -p 3050", port: 3050, reuseExistingServer: true, timeout: 60_000 },
});
