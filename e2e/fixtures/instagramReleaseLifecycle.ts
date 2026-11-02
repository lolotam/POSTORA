/** Canonical lifecycle only. Playwright owns child processes; this module owns fixture rows. */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { syntheticOwnerReleaseKey } from "./instagramOwnerReleaseSettings.mjs";
import { INSTAGRAM_RELEASE, assertInstagramReleaseEnvironment, assertInstagramReleaseManifest } from "./instagramRelease.ts";
import { assertOwnerExecutionSource, assertPreparedOwnerExecutionSource } from "../../scripts/instagram-owner-execution-source.mjs";

export default async function teardownInstagramRelease(): Promise<void> {
  const health = await fetch(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`, { signal: AbortSignal.timeout(5_000), redirect: "error" });
  const receipt = await health.json();
  assertInstagramReleaseManifest(receipt.manifest);
  if (receipt.fixture !== "instagram-release") throw new Error("Canonical Instagram teardown refused another runtime");
  assertOwnerExecutionSource(fileURLToPath(new URL("../../", import.meta.url)), receipt.candidate);
  const serviceKey = await syntheticOwnerReleaseKey("service_role");
  const response = await fetch(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/cleanup`, { method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "X-Instagram-Release-Namespace": receipt.manifest.namespace,
      "X-Instagram-Release-Candidate": receipt.candidate },
    signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok || (await response.json()).cleaned !== true) throw new Error("Canonical Instagram teardown failed");
}

async function startCanonicalVite(): Promise<void> {
  assertPreparedOwnerExecutionSource(fileURLToPath(new URL("../../", import.meta.url)));
  const anonKey = await syntheticOwnerReleaseKey("anon");
  const browserEnvironment = { VITE_SUPABASE_URL: INSTAGRAM_RELEASE.apiUrl, VITE_SUPABASE_PUBLISHABLE_KEY: anonKey };
  assertInstagramReleaseEnvironment(process.env, browserEnvironment);
  Object.assign(process.env, browserEnvironment);
  // The ordinary vite.config.ts explicitly calls loadEnv; Vite 5's envFile flag disables its own loader.
  const server = await createServer({ configFile: false, envFile: false, plugins: [react()],
    resolve: { alias: { "@": resolve(fileURLToPath(new URL("../../src", import.meta.url))) } },
    server: { host: "127.0.0.1", port: 8080, strictPort: true } });
  await server.listen();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--vite") throw new Error("Usage: instagramReleaseLifecycle.ts --vite");
  await startCanonicalVite();
}
