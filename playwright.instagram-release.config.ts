import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { syntheticOwnerReleaseKey } from "./e2e/fixtures/instagramOwnerReleaseSettings.mjs";
import { INSTAGRAM_RELEASE, assertInstagramReleaseEnvironment } from "./e2e/fixtures/instagramRelease.ts";
import { assertPreparedOwnerExecutionSource } from "./scripts/instagram-owner-execution-source.mjs";

assertPreparedOwnerExecutionSource(fileURLToPath(new URL(".", import.meta.url)));
const anonKey = await syntheticOwnerReleaseKey("anon");
const browserEnvironment = { VITE_SUPABASE_URL: INSTAGRAM_RELEASE.apiUrl, VITE_SUPABASE_PUBLISHABLE_KEY: anonKey };
assertInstagramReleaseEnvironment(process.env, browserEnvironment);

export default defineConfig({
  testDir: "./e2e", testMatch: ["instagram-release.spec.ts"],
  globalTeardown: "./e2e/fixtures/instagramReleaseLifecycle.ts",
  fullyParallel: false, workers: 1, forbidOnly: true, retries: 0, timeout: 180_000,
  reporter: [["list"], ["json", { outputFile: join(tmpdir(), "postora-instagram-release-playwright.json") }]],
  outputDir: join(tmpdir(), "postora-instagram-release-playwright"),
  use: { baseURL: INSTAGRAM_RELEASE.appUrl, trace: "retain-on-failure", screenshot: "only-on-failure", serviceWorkers: "block" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "deno run --no-config --no-lock --cached-only --allow-env --allow-read --allow-run=docker,git --allow-net=127.0.0.1:65431,127.0.0.1:65435,127.0.0.1:65436 e2e/fixtures/instagramReleaseServer.ts",
      url: `${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`, timeout: 180_000, reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 } },
    { command: "node --experimental-transform-types e2e/fixtures/instagramReleaseLifecycle.ts --vite",
      url: `${INSTAGRAM_RELEASE.appUrl}/src/main.tsx`, timeout: 180_000, reuseExistingServer: false, env: browserEnvironment },
  ],
});
