import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { assertOwnerExecutionSource } from "../scripts/instagram-owner-execution-source.mjs";
import { syntheticOwnerReleaseKey } from "./fixtures/instagramOwnerReleaseSettings.mjs";
import { INSTAGRAM_RELEASE } from "./fixtures/instagramRelease.ts";
import { prepareInstagramReleaseBrowser, signInInstagramRelease } from "./fixtures/instagramReleaseBrowser.ts";

async function searchInstagramRelease(page: Page, username: string) {
  await page.getByPlaceholder("Enter @username or instagram.com/username").fill(`@${username}`);
  const response = page.waitForResponse((reply) => reply.url().endsWith("/functions/v1/brand-scrape") && reply.request().method() === "POST");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  return response;
}

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
  expect(await calls.json()).toEqual({ calls: [], apifyCalls: [], networkRefusals: 0 });
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
    const reply = await searchInstagramRelease(browser, "release_competitor");
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
  expect(before).toEqual({ calls: [], apifyCalls: [], networkRefusals: 0 });
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
  await expect(page).toHaveURL(/\/analytics\/instagram\?tab=performance$/);
  await page.getByRole("button", { name: "Brand & Competitors", exact: true }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  const historyDialog = page.getByRole("dialog", { name: "Saved analyses", exact: true });
  const history = historyDialog.getByRole("row").filter({ hasText: "@release_competitor" });
  await expect(history).toHaveCount(2);
  await expect(history.first().getByText("Official", { exact: true })).toBeVisible();
  await history.first().getByRole("button", { name: "Reuse", exact: true }).click();
  await expect(historyDialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "History", exact: true })).toBeFocused();
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
  await page.getByRole("button", { name: "History", exact: true }).click();
  const otherHistoryDialog = page.getByRole("dialog", { name: "Saved analyses", exact: true });
  const otherHistory = otherHistoryDialog.getByRole("row").filter({ hasText: "@release_competitor" });
  await expect(otherHistory).toHaveCount(1);
  await expect(otherHistory.getByText("Official", { exact: true })).toBeVisible();
  await expect(otherHistoryDialog.getByText("@release_history_official", { exact: true })).toHaveCount(0);
  expect(await providerState()).toEqual(afterOtherOwner);
  await page.keyboard.press("Escape");
  await expect(otherHistoryDialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "History", exact: true })).toBeFocused();
});

test("canonical discovery keeps ambiguous viewer failures out of target eligibility and labels only explicitly enabled third-party fallback", async ({ page, request }) => {
  const manifest = await prepareInstagramReleaseBrowser(page, request);
  const health = await (await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`)).json();
  const headers = { Authorization: `Bearer ${await syntheticOwnerReleaseKey("service_role")}`,
    "X-Instagram-Release-Namespace": manifest.namespace, "X-Instagram-Release-Candidate": health.candidate };
  const control = async (path: string, data: Record<string, unknown>) => {
    const response = await request.post(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/${path}`, { headers, data });
    expect(response.status()).toBe(200);
  };
  const receipts = async () => {
    const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/provider-calls`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const cases = [
    { scenario: "permission_denied", username: "release_missing", status: 502, code: "DISCOVERY_PROVIDER_UNAVAILABLE", message: "Instagram discovery could not be completed.", reconnect: false },
    { scenario: "token_expired", username: "release_zero", status: 409, code: "IG_RECONNECT_REQUIRED", message: "Reconnect Instagram to enable official competitor data.", reconnect: true },
    { scenario: "network_failure", username: "release_null", status: 502, code: "DISCOVERY_PROVIDER_UNAVAILABLE", message: "Instagram discovery could not be completed.", reconnect: false },
    { scenario: "ambiguous_target", username: "release_stale", status: 502, code: "DISCOVERY_PROVIDER_UNAVAILABLE", message: "Instagram discovery could not be completed.", reconnect: false },
  ];
  const usernames = [...cases.map((entry) => entry.username), "release_partial", "release_negative"];
  const stored = async (table: string) => {
    const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/rest/v1/${table}`, { headers,
      params: { user_id: `eq.${manifest.users.ownerA.id}`, username: `in.(${usernames.join(",")})`, order: "username.asc" } });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const watchlistsBefore = await stored("competitor_watchlist");
  expect(watchlistsBefore).toHaveLength(usernames.length);
  const before = await receipts();
  expect(before.apifyCalls).toEqual([]);
  const fallbackControlUrl = `${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/interactive-fallback`;
  expect((await request.post(fallbackControlUrl, { data: { enabled: true } })).status()).toBe(401);
  expect((await request.post(fallbackControlUrl, { headers: { ...headers, "X-Instagram-Release-Namespace": "foreign" }, data: { enabled: true } })).status()).toBe(409);
  expect((await request.post(fallbackControlUrl, { headers, data: { enabled: "true" } })).status()).toBe(400);
  await signInInstagramRelease(page, manifest, "ownerA");
  await page.goto("/analytics/instagram?tab=analyze");
  try {
    for (const entry of cases) {
      await control("provider-scenario", { account: "pageGranted", scenario: entry.scenario });
      const response = await searchInstagramRelease(page, entry.username);
      expect(response.status()).toBe(entry.status);
      expect(await response.json()).toEqual({ error: entry.message, error_code: entry.code });
      await expect(page.getByText(entry.message, { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Reconnect Instagram", exact: true })).toHaveCount(entry.reconnect ? 1 : 0);
      await expect(page.getByRole("heading", { name: "Synthetic release competitor", exact: true })).toHaveCount(0);
    }
    const refused = await receipts();
    expect(refused.apifyCalls).toEqual([]);
    expect(refused.networkRefusals).toBe(0);
    for (const entry of cases) expect(refused.calls.slice(before.calls.length)).toEqual(expect.arrayContaining([
      expect.objectContaining({ account: "pageGranted", operation: "discovery", scenario: entry.scenario }),
    ]));
    expect(await stored("brand_scrape_sessions")).toEqual([]);
    expect(await stored("competitor_watchlist")).toEqual(watchlistsBefore);

    // The privileged fixture control models an administrator's persisted setting, never browser authority.
    await control("interactive-fallback", { enabled: true });
    await control("provider-scenario", { account: "pageGranted", scenario: "token_expired" });
    const fallback = await searchInstagramRelease(page, "release_partial");
    expect(fallback.status()).toBe(200);
    const payload = await fallback.json();
    expect(payload.source).toBe("apify");
    expect(payload.profile).toMatchObject({ source: "apify", followersCount: 67 });
    expect(payload.posts).toEqual([expect.objectContaining({ mediaType: "REEL", likesCount: null, videoViewCount: 17 })]);
    expect(payload.warning.code).toBe("IG_RECONNECT_REQUIRED");
    await expect(page.getByRole("heading", { name: "Synthetic third-party competitor", exact: true })).toBeVisible();
    await expect(page.getByText("Third-party", { exact: true })).toBeVisible();
    await expect(page.getByText("Official", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reconnect Instagram", exact: true })).toBeVisible();
    const afterFallback = await receipts();
    expect(afterFallback.apifyCalls).toEqual([{ username: "release_partial", observedAt: manifest.referenceInstant }]);
    expect((await stored("brand_scrape_sessions")).map((row: { profile_data: { source: string } }) => row.profile_data.source)).toEqual(["apify"]);

    await control("provider-scenario", { account: "pageGranted", scenario: "rate_limited" });
    const throttled = await searchInstagramRelease(page, "release_negative");
    expect(throttled.status()).toBe(429);
    expect(await throttled.json()).toEqual({ error: "Instagram discovery is temporarily unavailable.", error_code: "DISCOVERY_RATE_LIMITED" });
    await expect(page.getByText("Instagram discovery is temporarily unavailable.", { exact: true })).toBeVisible({ timeout: 15_000 });
    const afterThrottle = await receipts();
    expect(afterThrottle.apifyCalls).toEqual(afterFallback.apifyCalls);
    expect(afterThrottle.networkRefusals).toBe(0);
    expect(await stored("competitor_watchlist")).toEqual(watchlistsBefore);
  } finally {
    await control("interactive-fallback", { enabled: false });
    await control("provider-scenario", { account: "pageGranted", scenario: "normal" });
  }
});
