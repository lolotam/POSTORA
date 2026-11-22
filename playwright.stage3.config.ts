import { defineConfig, devices } from "@playwright/test";

/**
 * Isolated Stage 3 browser run.
 *
 * Uses a PREBUILT bundle on its own port so a cold Vite transform cannot time
 * out page.goto, and never touches the manager's 8080 server. Retries stay at
 * zero: the journeys must pass on their own, not because a second attempt was
 * warmer. Timeouts are generous for the slow sandbox; every functional
 * assertion remains unchanged.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "youtube-stage3.spec.ts",
  retries: 0,
  workers: 1,
  timeout: 120_000,
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:8091",
    navigationTimeout: 60_000,
    actionTimeout: 30_000,
    expect: { timeout: 30_000 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite preview --host 127.0.0.1 --port 8091 --strictPort",
    url: "http://127.0.0.1:8091",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
