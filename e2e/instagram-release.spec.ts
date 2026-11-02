import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { assertOwnerExecutionSource } from "../scripts/instagram-owner-execution-source.mjs";
import { syntheticOwnerReleaseKey } from "./fixtures/instagramOwnerReleaseSettings.mjs";
import { INSTAGRAM_RELEASE } from "./fixtures/instagramRelease.ts";
import { prepareInstagramReleaseBrowser, signInInstagramRelease } from "./fixtures/instagramReleaseBrowser.ts";

test("canonical fixture smoke: real Auth, ordinary owners, separate admin and SQL quota state", async ({ page, request }) => {
  const manifest = await prepareInstagramReleaseBrowser(page, request);
  const healthReceipt = await (await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`)).json();
  const candidate = assertOwnerExecutionSource(fileURLToPath(new URL("../", import.meta.url)), healthReceipt.candidate);
  const headers = { Authorization: `Bearer ${await syntheticOwnerReleaseKey("service_role")}`,
    "X-Instagram-Release-Namespace": manifest.namespace, "X-Instagram-Release-Candidate": candidate };
  const initial = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/state`, { headers });
  expect(initial.status()).toBe(200);
  expect(await initial.json()).toEqual({ users: 3, admins: [manifest.users.admin.id],
    quotas: { [manifest.users.ownerA.id]: 20, [manifest.users.ownerB.id]: 5, [manifest.users.admin.id]: 0 },
    active: { [manifest.users.ownerA.id]: 11, [manifest.users.ownerB.id]: 5, [manifest.users.admin.id]: 1 },
    active_cron: 0, completed_jobs: 0 });
  for (const key of ["ownerA", "ownerB", "admin"] as const) {
    await page.goto(INSTAGRAM_RELEASE.appUrl);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await signInInstagramRelease(page, manifest, key);
    const quota = await page.evaluate(async (apiUrl) => {
      const session = Object.entries(localStorage).find(([name]) => name.endsWith("-auth-token"));
      if (!session) throw new Error("Real Auth session unavailable");
      const token = JSON.parse(session[1]).access_token;
      const response = await fetch(`${apiUrl}/rest/v1/rpc/read_own_competitor_quota`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("Real SQL quota read failed");
      return response.json();
    }, INSTAGRAM_RELEASE.apiUrl);
    expect(quota).toEqual({ max_tracked_competitors: key === "admin" ? -1 : key === "ownerA" ? 20 : 5,
      unlimited: key === "admin", tracked_active: key === "ownerA" ? 11 : key === "ownerB" ? 5 : 1,
      remaining: key === "admin" ? null : key === "ownerA" ? 9 : 0 });
  }
  const calls = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/provider-calls`, { headers });
  expect(await calls.json()).toEqual({ calls: [], networkRefusals: 0 });
  const cleanup = await request.post(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/cleanup`, { headers });
  expect(cleanup.status()).toBe(200);
  expect(await cleanup.json()).toEqual({ cleaned: true });
  const health = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`);
  expect(health.status()).toBe(503);
});
