import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { OWNER_RELEASE } from "./e2e/fixtures/instagramOwnerReleaseSeed";
import { assertPreparedOwnerExecutionSource } from "./scripts/instagram-owner-execution-source.mjs";

assertPreparedOwnerExecutionSource(fileURLToPath(new URL(".", import.meta.url)));

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role: "anon", iss: "supabase", exp: 4_102_444_800 })}`;
const anonKey = `${unsigned}.${createHmac("sha256", OWNER_RELEASE.signingSecret).update(unsigned).digest("base64url")}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "instagram-owner-release.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  // Cold Windows Vite transforms can consume over a minute before the real login form mounts.
  timeout: 180_000,
  reporter: [["list"], ["json", { outputFile: join(tmpdir(), "postora-owner-release-playwright.json") }]],
  outputDir: join(tmpdir(), "postora-owner-release-playwright"),
  use: { baseURL: "http://127.0.0.1:8080", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 8080 --strictPort",
    url: "http://127.0.0.1:8080/src/main.tsx",
    timeout: 180_000,
    reuseExistingServer: false,
    env: { VITE_SUPABASE_URL: OWNER_RELEASE.apiUrl, VITE_SUPABASE_PUBLISHABLE_KEY: anonKey },
  },
});
