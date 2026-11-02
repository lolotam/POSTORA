import { expect, test, type Page } from "@playwright/test";
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
  // The shared lifecycle cleans up after every canonical journey has finished.
});

test("canonical discovery preserves official provenance, nullable media and owner-scoped cache through saved history", async ({ page, request }) => {
  const manifest = await prepareInstagramReleaseBrowser(page, request);
  const health = await (await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`)).json();
  const headers = { Authorization: `Bearer ${await syntheticOwnerReleaseKey("service_role")}`,
    "X-Instagram-Release-Namespace": manifest.namespace, "X-Instagram-Release-Candidate": health.candidate };
  const providerState = async () => {
    const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/provider-calls`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const analyze = async (browser: Page) => {
    await browser.getByPlaceholder("Enter @username or instagram.com/username").fill("@release_competitor");
    const response = browser.waitForResponse((reply) => reply.url().endsWith("/functions/v1/brand-scrape") && reply.request().method() === "POST");
    await browser.getByRole("button", { name: "Analyze", exact: true }).click();
    const reply = await response;
    expect(reply.status()).toBe(200);
    return reply.json();
  };
  const expectResult = async () => {
    await expect(page.getByRole("heading", { name: "Synthetic release competitor", exact: true })).toBeVisible();
    await expect(page.getByText("Official", { exact: true })).toBeVisible();
    await expect(page.getByText("Followers", { exact: true }).locator("..")).toContainText("120");
    await expect(page.getByText("Synthetic release media 0", { exact: true })).toBeVisible();
    await expect(page.getByText("Synthetic release media 1", { exact: true })).toBeVisible();
    await expect(page.getByText("REEL", { exact: true })).toBeVisible();
    await expect(page.getByText("VIDEO", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveCount(2);
  };

  const before = await providerState();
  expect(before).toEqual({ calls: [], networkRefusals: 0 });
  await signInInstagramRelease(page, manifest, "ownerA");
  await page.goto("/analytics/instagram?tab=analyze");
  const discovered = await analyze(page);
  expect(discovered.profile).toMatchObject({ username: "release_competitor", source: "official", followersCount: 120, postsCount: 2 });
  expect(discovered.posts).toHaveLength(2);
  expect(discovered.posts).toEqual(expect.arrayContaining([
    expect.objectContaining({ mediaType: "REEL", likesCount: null, videoViewCount: 300 }),
    expect.objectContaining({ mediaType: "VIDEO", likesCount: 20, videoViewCount: null }),
  ]));
  await expectResult();
  const afterDiscovery = await providerState();
  expect(afterDiscovery.networkRefusals).toBe(0);
  expect(afterDiscovery.calls.map((call: { account: string; operation: string }) => ({ account: call.account, operation: call.operation })))
    .toEqual([{ account: "pageGranted", operation: "discovery" }, { account: "pageGranted", operation: "discovery" }]);
  const cached = await analyze(page);
  expect(cached.fromCache).toBe(true);
  expect(cached.profile).toEqual(discovered.profile);
  expect(cached.posts).toEqual(discovered.posts);
  expect(await providerState()).toEqual(afterDiscovery);

  await page.goto("/brand-intelligence");
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const history = page.getByRole("row").filter({ hasText: "@release_competitor" });
  await expect(history).toHaveCount(2);
  await expect(history.first().getByText("Official", { exact: true })).toBeVisible();
  await history.first().getByRole("button", { name: "Reuse", exact: true }).click();
  await expectResult();
  expect(await providerState()).toEqual(afterDiscovery);

  await page.locator('header button[aria-haspopup="menu"]').last().click();
  await page.getByRole("menuitem", { name: "Logout", exact: true }).click();
  await page.waitForURL("/");
  await signInInstagramRelease(page, manifest, "ownerB");
  await page.goto("/analytics/instagram?tab=analyze");
  await expect(page.getByRole("heading", { name: "Synthetic release competitor", exact: true })).toHaveCount(0);
  const otherOwner = await analyze(page);
  expect(otherOwner.fromCache).not.toBe(true);
  expect(otherOwner.profile).toEqual(discovered.profile);
  expect(otherOwner.posts).toEqual(discovered.posts);
  await expectResult();
  const afterOtherOwner = await providerState();
  expect(afterOtherOwner.networkRefusals).toBe(0);
  expect(afterOtherOwner.calls.slice(2).map((call: { account: string; operation: string }) => ({ account: call.account, operation: call.operation })))
    .toEqual([{ account: "otherPage", operation: "discovery" }, { account: "otherPage", operation: "discovery" }]);
  await page.goto("/brand-intelligence");
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const otherHistory = page.getByRole("row").filter({ hasText: "@release_competitor" });
  await expect(otherHistory).toHaveCount(1);
  await expect(otherHistory.getByText("Official", { exact: true })).toBeVisible();
  await expect(page.getByText("@release_history_official", { exact: true })).toHaveCount(0);
  expect(await providerState()).toEqual(afterOtherOwner);
});
