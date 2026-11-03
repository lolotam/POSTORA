import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { assertOwnerExecutionSource } from "../scripts/instagram-owner-execution-source.mjs";
import { syntheticOwnerReleaseKey } from "./fixtures/instagramOwnerReleaseSettings.mjs";
import { INSTAGRAM_RELEASE } from "./fixtures/instagramRelease.ts";
import { prepareInstagramReleaseBrowser, signInInstagramRelease } from "./fixtures/instagramReleaseBrowser.ts";
import type { CompetitorReportDetail, CompetitorReportList } from "../supabase/functions/competitor-tracking-report/contracts.ts";
import type { OwnerReport } from "../supabase/functions/instagram-insights-report/contracts.ts";

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

test("canonical owner and competitor screens retain exact outliers across periods and pages with distinct metric bases", async ({ page, request }) => {
  const manifest = await prepareInstagramReleaseBrowser(page, request);
  const health = await (await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`)).json();
  const headers = { Authorization: `Bearer ${await syntheticOwnerReleaseKey("service_role")}`,
    "X-Instagram-Release-Namespace": manifest.namespace, "X-Instagram-Release-Candidate": health.candidate };
  const providerState = async () => {
    const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/provider-calls`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const before = await providerState();
  await signInInstagramRelease(page, manifest, "ownerA");
  await page.goto("/analytics/instagram?tab=competitors");
  const detailResponse = (period: number, cursor = false) => page.waitForResponse((reply) => {
    if (!reply.url().endsWith("/functions/v1/competitor-tracking-report")) return false;
    const body = reply.request().postDataJSON();
    return body?.action === "detail" && body.period_days === period && Boolean(body.cursor) === cursor;
  });
  const first = detailResponse(7);
  await page.getByRole("button", { name: "View report for @release_cursor_tie", exact: true }).click();
  const firstReply = await first;
  expect(firstReply.status()).toBe(200);
  const short: CompetitorReportDetail = await firstReply.json();
  const original = short.media.find((item) => item.ig_media_id === "release_cursor_tie_media_0")!;
  expect(original.outlier).toMatchObject({ score: 3, label: "outlier", baselineMedian: 100, baselineSize: 12, metric_basis: "public_views" });
  const longReply = detailResponse(30);
  await page.getByRole("dialog").getByRole("tab", { name: "Follower change · 30 days", exact: true }).click();
  const response = await longReply;
  expect(response.status()).toBe(200);
  const long: CompetitorReportDetail = await response.json();
  expect(long.media.find((item) => item.ig_media_id === original.ig_media_id)?.outlier).toEqual(original.outlier);
  expect(long.next_cursor).not.toBeNull();
  const continuation = detailResponse(30, true);
  await page.getByRole("dialog").getByRole("button", { name: "Load more", exact: true }).click();
  const continued = await continuation;
  expect(continued.status()).toBe(200);
  const tail: CompetitorReportDetail = await continued.json();
  const media = [...long.media, ...tail.media];
  for (const verdict of [
    { index: 0, label: "outlier", score: 3, copy: "Outlier" },
    { index: 1, label: "above", score: 1.5, copy: "Above usual" },
    { index: 2, label: "normal", score: 1, copy: "Normal" },
    { index: 3, label: "below", score: 0.5, copy: "Below usual" },
    { index: 4, label: "no_data", score: null, copy: "Data unavailable" },
    { index: 5, label: "below", score: 0, copy: "Below usual" },
    { index: 20, label: "small_baseline", score: null, copy: "Not enough earlier posts" },
    { index: 29, label: "too_early", score: null, copy: "Too early" },
  ]) {
    const item = media.find((candidate) => candidate.ig_media_id === `release_cursor_tie_media_${verdict.index}`)!;
    expect(item?.outlier).toMatchObject({ label: verdict.label, score: verdict.score });
    const row = page.getByRole("dialog").getByRole("row").filter({ has: page.getByText(`Synthetic competitor media ${verdict.index}`, { exact: true }) });
    await expect(row.getByText(verdict.copy, { exact: true })).toBeVisible();
    await expect(row.getByText(`Metric basis: ${verdict.index === 20 ? "public interactions" : "public views"}`, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("dialog").getByRole("row").filter({ has: page.getByText("Synthetic competitor media 0", { exact: true }) })
    .getByText("Outlier", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  const account = manifest.accounts.find((item) => item.key === "pageGranted")!;
  const ownerResponse = (period: number, cursor = false) => page.waitForResponse((reply) => {
    if (!reply.url().endsWith("/functions/v1/instagram-insights-report")) return false;
    const body = reply.request().postDataJSON();
    return body?.social_account_id === account.id && body.period_days === period && Boolean(body.cursor) === cursor;
  });
  const ownerFirst = ownerResponse(30);
  await page.goto("/analytics/instagram?tab=performance");
  const ownerReply = await ownerFirst;
  expect(ownerReply.status()).toBe(200);
  const owner: OwnerReport = await ownerReply.json();
  await expect(page.getByRole("combobox")).toContainText("@release_pagegranted");
  const ownerNext = ownerResponse(30, true);
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  const ownerTailReply = await ownerNext;
  expect(ownerTailReply.status()).toBe(200);
  const ownerTail: OwnerReport = await ownerTailReply.json();
  const ownerItems = [...owner.media.page.items, ...ownerTail.media.page.items];
  for (const verdict of [
    { suffix: "history_0", label: "outlier", score: 3, copy: "🌟 3.0x Outlier" },
    { suffix: "history_1", label: "above", score: 1.5, copy: "▲ 1.5x Above" },
    { suffix: "history_2", label: "normal", score: 1, copy: "1.0x Normal" },
    { suffix: "history_3", label: "below", score: 0.5, copy: "▼ 0.5x Below" },
    { suffix: "history_4", label: "no_data", score: null, copy: "No data" },
    { suffix: "history_5", label: "below", score: 0, copy: "▼ 0.0x Below" },
    { suffix: "history_6", label: "too_early", score: null, copy: "Too early (<48h)" },
    { suffix: "history_20", label: "small_baseline", score: null, copy: "Small baseline" },
    { suffix: "six_baseline_0", label: "outlier", score: 3, copy: "🌟 3.0x Outlier" },
  ]) {
    const id = `${account.providerId}_${verdict.suffix}`;
    const item = ownerItems.find((candidate) => candidate.mediaId === id)!;
    expect(item?.outlier).toMatchObject({ label: verdict.label, score: verdict.score });
    const row = page.getByRole("row").filter({ has: page.getByText(id, { exact: true }) });
    await expect(row.getByText(verdict.copy, { exact: true })).toBeVisible();
  }
  const ownerOriginal = ownerItems.find((item) => item.mediaId === `${account.providerId}_history_0`)!;
  expect(ownerOriginal.outlier).toMatchObject({ baselineSize: 12, baselineMedian: 100, metricBasis: "views" });
  expect(ownerItems.find((item) => item.mediaId === `${account.providerId}_six_baseline_0`)?.outlier)
    .toMatchObject({ baselineSize: 6, baselineMedian: 100, metricBasis: "interactions" });
  const shortOwnerReply = ownerResponse(7);
  await page.getByRole("button", { name: "7d", exact: true }).click();
  const shortOwnerResponse = await shortOwnerReply;
  expect(shortOwnerResponse.status()).toBe(200);
  const shortOwner: OwnerReport = await shortOwnerResponse.json();
  expect(shortOwner.media.page.items.find((item) => item.mediaId === ownerOriginal.mediaId)?.outlier).toEqual(ownerOriginal.outlier);
  expect(shortOwner.media.page.items.find((item) => item.mediaId === `${account.providerId}_six_baseline_0`)?.outlier)
    .toEqual(ownerItems.find((item) => item.mediaId === `${account.providerId}_six_baseline_0`)?.outlier);
  const ownerRow = page.getByRole("row").filter({ has: page.getByText(ownerOriginal.mediaId, { exact: true }) });
  await expect(ownerRow.getByText("Metric basis: owner organic views", { exact: true })).toBeVisible();
  const interactionsRow = page.getByRole("row").filter({ has: page.getByText(`${account.providerId}_six_baseline_0`, { exact: true }) });
  await expect(interactionsRow.getByText("Metric basis: owner organic interactions", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Toggle language", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(ownerRow.getByText("المقياس: مشاهدات الحساب العضوية", { exact: true })).toBeVisible();
  await expect(interactionsRow.getByText("المقياس: تفاعلات الحساب العضوية", { exact: true })).toBeVisible();
  expect(await providerState()).toEqual(before);
});

test("canonical historical growth preserves real intervals and refuses zero, missing, stale and changed-source baselines", async ({ page, request }) => {
  const manifest = await prepareInstagramReleaseBrowser(page, request);
  const health = await (await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`)).json();
  const headers = { Authorization: `Bearer ${await syntheticOwnerReleaseKey("service_role")}`,
    "X-Instagram-Release-Namespace": manifest.namespace, "X-Instagram-Release-Candidate": health.candidate };
  const providerState = async () => {
    const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/provider-calls`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const before = await providerState();
  await signInInstagramRelease(page, manifest, "ownerA");
  const reportResponse = page.waitForResponse((response) => response.url().endsWith("/functions/v1/competitor-tracking-report")
    && response.request().postDataJSON()?.action === "list");
  await page.goto("/analytics/instagram?tab=competitors");
  const response = await reportResponse;
  expect(response.status()).toBe(200);
  const report: CompetitorReportList = await response.json();
  const row = (username: string) => page.getByRole("row").filter({ has: page.getByText(`@${username}`, { exact: true }) });
  const entry = report.entries.find((item) => item.username === "release_competitor");
  expect(entry?.profile?.followers_count).toBe(120);
  const referenceMs = Date.parse(manifest.referenceInstant);
  for (const comparison of [
    { days: 7, growth: entry!.growth_7d, absolute: 20, percent: 20 },
    { days: 30, growth: entry!.growth_30d, absolute: 40, percent: 50 },
  ]) {
    expect(comparison.growth).toMatchObject({ absolute: comparison.absolute, percent: comparison.percent,
      interval_days: comparison.days, reason: null });
    expect(Date.parse(comparison.growth.observed_at!)).toBe(referenceMs);
    expect(Date.parse(comparison.growth.baseline_at!)).toBe(referenceMs - comparison.days * 86_400_000);
    await expect(row(entry!.username).getByText(new RegExp(`^Compared with .+ \\(${comparison.days} days\\)$`))).toBeVisible();
  }
  await expect(row(entry!.username).getByText("+20 (20.0%)", { exact: true })).toBeVisible();
  await expect(row(entry!.username).getByText("+40 (50.0%)", { exact: true })).toBeVisible();
  await expect(row(entry!.username).getByText("3 observed posts / 7 days", { exact: true })).toBeVisible();
  for (const refused of [
    { username: "release_zero", reason: "zero_baseline", copy: "No percentage: baseline was zero" },
    { username: "release_null", reason: "unavailable_metric", copy: "That metric is unavailable" },
    { username: "release_missing", reason: "missing_baseline", copy: "No comparable baseline" },
    // SQL excludes observations outside S=3 days; there is no comparable baseline to display.
    { username: "release_stale", reason: "missing_baseline", copy: "No comparable baseline" },
    { username: "release_first", reason: "missing_baseline", copy: "No comparable baseline" },
    { username: "release_source_switch", reason: "source_changed", copy: "The source changed between the two observations" },
  ]) {
    const stored = report.entries.find((item) => item.username === refused.username);
    expect(stored).toBeDefined();
    for (const growth of [stored!.growth_7d, stored!.growth_30d]) {
      expect(growth).toMatchObject({ reason: refused.reason, absolute: null, percent: null });
    }
    await expect(row(refused.username).getByText(refused.copy, { exact: true })).toHaveCount(2);
    for (const cell of [2, 3]) await expect(row(refused.username).getByRole("cell").nth(cell)).toContainText("—");
    await expect(row(refused.username).getByText(/0\.0%/)).toHaveCount(0);
  }
  const negative = report.entries.find((item) => item.username === "release_negative");
  expect(negative?.growth_7d).toMatchObject({ absolute: -20, interval_days: 7, reason: null });
  expect(negative?.growth_7d.percent).toBeCloseTo(-100 / 7);
  expect(negative?.growth_30d).toMatchObject({ absolute: -40, percent: -25, interval_days: 30, reason: null });
  await expect(row("release_negative").getByText(/^[−-]20 \(-14\.3%\)$/)).toBeVisible();
  await expect(row("release_negative").getByText(/^[−-]40 \(-25\.0%\)$/)).toBeVisible();
  await expect(row("release_partial").getByText("30 posts observed · incomplete coverage", { exact: true })).toBeVisible();
  await expect(row("release_partial").getByRole("cell").nth(4)).toContainText("—");
  await expect(row("release_legacy").getByText("3 posts observed · incomplete coverage", { exact: true })).toBeVisible();

  const detailResponse = page.waitForResponse((reply) => reply.url().endsWith("/functions/v1/competitor-tracking-report")
    && reply.request().postDataJSON()?.action === "detail");
  await row(entry!.username).getByRole("button", { name: `View report for @${entry!.username}`, exact: true }).click();
  const detailReply = await detailResponse;
  expect(detailReply.status()).toBe(200);
  const detail: CompetitorReportDetail = await detailReply.json();
  expect(detail.entry?.growth_7d).toEqual(entry!.growth_7d);
  expect(detail.entry?.growth_30d).toEqual(entry!.growth_30d);
  expect(detail.entry?.weekly).toEqual(entry!.weekly);
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("+20 (20.0%)", { exact: true })).toBeVisible();
  await expect(sheet.getByText("+40 (50.0%)", { exact: true })).toBeVisible();
  await expect(sheet.getByText("3 observed posts / 7 days", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await providerState()).toEqual(before);
});

test("canonical quota management refuses extra activations, serializes the final slot and preserves downgrade and unlimited behavior", async ({ page, request }) => {
  const manifest = await prepareInstagramReleaseBrowser(page, request);
  const health = await (await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`)).json();
  const headers = { Authorization: `Bearer ${await syntheticOwnerReleaseKey("service_role")}`,
    "X-Instagram-Release-Namespace": manifest.namespace, "X-Instagram-Release-Candidate": health.candidate };
  const read = async (table: string, owner: string) => {
    const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/rest/v1/${table}`, { headers, params: { user_id: `eq.${owner}`, order: "id.asc" } });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const providerState = async () => {
    const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/provider-calls`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const setQuota = async (limit: number) => {
    const response = await request.post(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/quota`, { headers, data: { owner: "ownerA", limit } });
    expect(response.status()).toBe(200);
  };
  const rpc = async (operations: { name: string; args: Record<string, unknown> }[]) => page.evaluate(async ({ apiUrl, operations }) => {
    const saved = Object.entries(localStorage).find(([key]) => key.endsWith("-auth-token"));
    if (!saved) throw new Error("Real owner Auth session missing");
    const token = JSON.parse(saved[1]).access_token;
    return Promise.all(operations.map(async (operation) => {
      const response = await fetch(`${apiUrl}/rest/v1/rpc/${operation.name}`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(operation.args) });
      return { status: response.status, body: await response.json() };
    }));
  }, { apiUrl: INSTAGRAM_RELEASE.apiUrl, operations });
  const logout = async () => {
    await page.locator('header button[aria-haspopup="menu"]').last().click();
    await page.getByRole("menuitem", { name: "Logout", exact: true }).click();
    await page.waitForURL("/");
  };
  await signInInstagramRelease(page, manifest, "ownerB");
  await page.goto("/analytics/instagram?tab=competitors");
  await expect(page.getByText("5 of 5 tracked", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "View plans", exact: true })).toHaveAttribute("href", "/pricing");
  const beforeRows = await read("competitor_watchlist", manifest.users.ownerB.id);
  const beforeJobs = await read("instagram_collection_jobs", manifest.users.ownerB.id);
  await page.goto("/analytics/instagram?tab=analyze");
  expect((await searchInstagramRelease(page, "release_zero")).status()).toBe(200);
  const afterDiscovery = await providerState();
  const deniedAdd = page.waitForResponse((response) => response.url().endsWith("/rpc/add_competitor_watchlist") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Track", exact: true }).click();
  expect((await deniedAdd).status()).toBe(400);
  await expect(page.getByText("Your limit is 5 active competitors.", { exact: true })).toBeVisible();
  expect(await read("competitor_watchlist", manifest.users.ownerB.id)).toEqual(beforeRows);
  expect(await read("instagram_collection_jobs", manifest.users.ownerB.id)).toEqual(beforeJobs);
  expect(await providerState()).toEqual(afterDiscovery);

  await page.goto("/analytics/instagram?tab=competitors");
  await page.getByRole("button", { name: "Remove @release_quota_4", exact: true }).click();
  const removal = page.getByRole("alertdialog", { name: "Remove @release_quota_4?", exact: true });
  await expect(removal).toContainText("History is kept for 90 days");
  await removal.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(removal).toHaveCount(0);
  await expect(page.getByText("4 of 5 tracked", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tracked competitors", exact: true })).toBeFocused();
  const competing = await rpc(["release_race_a", "release_race_b"].map((username) => ({ name: "add_competitor_watchlist", args: { p_username: username, p_label: null } })));
  expect(competing.map((result) => result.status).sort()).toEqual([200, 400]);
  expect(competing.find((result) => result.status === 400)?.body.message).toMatch(/^COMPETITOR_QUOTA_EXCEEDED:/);
  const rowsAfterRace = await read("competitor_watchlist", manifest.users.ownerB.id);
  expect(rowsAfterRace.filter((row: { is_active: boolean }) => row.is_active)).toHaveLength(5);
  expect(rowsAfterRace.filter((row: { username: string }) => row.username.startsWith("release_race_"))).toHaveLength(1);
  const removed = rowsAfterRace.find((row: { username: string }) => row.username === "release_quota_4");
  expect(removed.id).toBe(beforeRows.find((row: { username: string }) => row.username === "release_quota_4").id);
  expect(removed.is_active).toBe(false);
  expect(removed.removed_at).not.toBeNull();
  await page.reload();
  await page.getByRole("tab", { name: "Removed", exact: true }).click();
  await page.getByRole("button", { name: "Reactivate @release_quota_4", exact: true }).click();
  await expect(page.getByText("Your limit is 5 active competitors.", { exact: true })).toBeVisible();
  expect(await read("competitor_watchlist", manifest.users.ownerB.id)).toEqual(rowsAfterRace);
  expect(await read("instagram_collection_jobs", manifest.users.ownerB.id)).toEqual(beforeJobs);

  await logout();
  await signInInstagramRelease(page, manifest, "ownerA");
  const ownerRows = await read("competitor_watchlist", manifest.users.ownerA.id);
  const ownerHistory = await read("competitor_profile_snapshots", manifest.users.ownerA.id);
  try {
    await setQuota(3);
    await page.goto("/analytics/instagram?tab=competitors");
    await expect(page.getByText("11 of 3 tracked", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "View plans", exact: true })).toBeVisible();
    expect(await read("competitor_watchlist", manifest.users.ownerA.id)).toEqual(ownerRows);
    expect(await read("competitor_profile_snapshots", manifest.users.ownerA.id)).toEqual(ownerHistory);
    await page.getByRole("tab", { name: "Removed", exact: true }).click();
    await page.getByRole("button", { name: "Reactivate @release_retention_89", exact: true }).click();
    await expect(page.getByText("Your limit is 3 active competitors.", { exact: true })).toBeVisible();
    expect(await read("competitor_watchlist", manifest.users.ownerA.id)).toEqual(ownerRows);

    await setQuota(-1);
    await page.reload();
    await expect(page.getByText("Unlimited tracking", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "View plans", exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Removed", exact: true }).click();
    await page.getByRole("button", { name: "Reactivate @release_retention_89", exact: true }).click();
    await expect(page.getByText("Tracked; the first snapshot is queued.", { exact: true })).toBeVisible();
    const reactivated = (await read("competitor_watchlist", manifest.users.ownerA.id)).find((row: { username: string }) => row.username === "release_retention_89");
    expect(reactivated).toMatchObject({ id: ownerRows.find((row: { username: string }) => row.username === "release_retention_89").id, is_active: true, removed_at: null });
    expect(await read("competitor_profile_snapshots", manifest.users.ownerA.id)).toEqual(ownerHistory);
    expect((await read("instagram_collection_jobs", manifest.users.ownerA.id)).some((job: { watchlist_id: string; status: string }) => job.watchlist_id === reactivated.id && job.status === "queued")).toBe(true);
  } finally { await setQuota(20); }
  await logout();
  await signInInstagramRelease(page, manifest, "admin");
  await page.goto("/analytics/instagram?tab=competitors");
  await expect(page.getByText("Unlimited tracking", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "View plans", exact: true })).toHaveCount(0);
  const adminAdd = await rpc([{ name: "add_competitor_watchlist", args: { p_username: "release_admin_extra", p_label: null } }]);
  expect(adminAdd[0].status).toBe(200);
  expect((await read("competitor_watchlist", manifest.users.admin.id)).filter((row: { is_active: boolean }) => row.is_active)).toHaveLength(2);
  expect(await providerState()).toEqual(afterDiscovery);
});

test("canonical tracking persists a new capture through the real worker and reconciles a lost save response without replay", async ({ page, request }) => {
  const manifest = await prepareInstagramReleaseBrowser(page, request);
  const health = await (await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`)).json();
  const headers = { Authorization: `Bearer ${await syntheticOwnerReleaseKey("service_role")}`,
    "X-Instagram-Release-Namespace": manifest.namespace, "X-Instagram-Release-Candidate": health.candidate };
  const control = async (path: string, data: Record<string, unknown>) => request.post(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/${path}`, { headers, data });
  const read = async (table: string, filters: Record<string, string>) => {
    const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/rest/v1/${table}`, { headers,
      params: { user_id: `eq.${manifest.users.ownerA.id}`, order: "id.asc", ...filters } });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const target = () => read("competitor_watchlist", { username: `eq.${INSTAGRAM_RELEASE.newTarget}` });
  const syncResponse = () => page.waitForResponse((response) => response.url().endsWith("/functions/v1/competitor-snapshot-sync") && response.request().method() === "POST");
  expect((await control("admit-tracked-competitor", { username: INSTAGRAM_RELEASE.newTarget })).status()).toBe(409);
  expect((await control("admit-tracked-competitor", { username: "foreign" })).status()).toBe(400);
  await signInInstagramRelease(page, manifest, "ownerA");
  await page.goto("/analytics/instagram?tab=analyze");
  expect((await searchInstagramRelease(page, INSTAGRAM_RELEASE.newTarget)).status()).toBe(200);
  const notAdmitted = syncResponse();
  await page.getByRole("button", { name: "Track", exact: true }).click();
  expect((await notAdmitted).status()).toBe(403);
  await expect(page.getByText("Tracked; collection could not be confirmed.", { exact: true })).toBeVisible();
  const saved = await target();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ username: INSTAGRAM_RELEASE.newTarget, is_active: true, status: "pending", last_synced_at: null });
  const id = saved[0].id;
  const snapshots = () => read("competitor_profile_snapshots", { watchlist_id: `eq.${id}` });
  const media = () => read("competitor_media_snapshots", { watchlist_id: `eq.${id}` });
  const jobs = () => read("instagram_collection_jobs", { watchlist_id: `eq.${id}` });
  expect(await snapshots()).toEqual([]);
  expect(await jobs()).toEqual([]);
  // The fixture models approval of this exact saved target/viewer, without bypassing the real intake.
  for (let attempt = 0; attempt < 2; attempt++) expect((await control("admit-tracked-competitor", { username: INSTAGRAM_RELEASE.newTarget })).status()).toBe(200);
  await page.goto("/analytics/instagram?tab=competitors");
  const row = () => page.getByRole("row").filter({ has: page.getByText(`@${INSTAGRAM_RELEASE.newTarget}`, { exact: true }) });
  await expect(row()).toHaveCount(1);
  await expect(row()).toContainText("Waiting for first snapshot");
  const accepted = syncResponse();
  await row().getByRole("button", { name: "Retry collection", exact: true }).click();
  expect((await accepted).status()).toBe(202);
  await expect(page.getByText("Tracked; the first snapshot is queued.", { exact: true })).toBeVisible();
  expect((await jobs()).map((job: { status: string }) => job.status)).toEqual(["queued"]);
  expect(await snapshots()).toEqual([]);
  const drained = await control("drain", { kind: "competitor" });
  expect(drained.status()).toBe(200);
  expect((await jobs()).map((job: { status: string }) => job.status)).toEqual(["completed"]);
  const captured = await snapshots();
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ followers_count: 120, media_count: 2, source: "official", status: "ok" });
  const capturedMedia = await media();
  expect(capturedMedia).toHaveLength(2);
  expect(capturedMedia).toEqual(expect.arrayContaining([
    expect.objectContaining({ media_type: "VIDEO", media_product_type: "REELS", like_count: null, view_count: 300, source: "official" }),
    expect.objectContaining({ media_type: "VIDEO", media_product_type: "FEED", like_count: 20, view_count: null, source: "official" }),
  ]));
  await page.reload();
  await expect(row()).toContainText("120");
  await expect(row().getByText("2 posts observed · incomplete coverage", { exact: true })).toBeVisible();
  await expect(row().getByText("Official", { exact: true })).toBeVisible();
  await expect(row().getByText("No comparable baseline", { exact: true })).toHaveCount(2);
  await row().getByRole("button", { name: `View report for @${INSTAGRAM_RELEASE.newTarget}`, exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("Synthetic release media 0", { exact: true })).toBeVisible();
  await expect(detail.getByText("Synthetic release media 1", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await row().getByRole("button", { name: `Remove @${INSTAGRAM_RELEASE.newTarget}`, exact: true }).click();
  const removedResponse = page.waitForResponse((response) => response.url().endsWith("/rpc/update_competitor_watchlist")
    && response.request().method() === "POST" && response.request().postDataJSON()?.p_watchlist_id === id);
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click();
  expect((await removedResponse).status()).toBe(200);
  await expect(row()).toHaveCount(0);
  expect((await target())[0]).toMatchObject({ id, is_active: false });
  expect(await snapshots()).toEqual(captured);
  expect(await media()).toEqual(capturedMedia);
  await page.getByRole("tab", { name: "Removed", exact: true }).click();
  const reactivation = syncResponse();
  await row().getByRole("button", { name: `Reactivate @${INSTAGRAM_RELEASE.newTarget}`, exact: true }).click();
  expect((await reactivation).status()).toBe(429);
  await expect(page.getByText("Tracked; collection could not be confirmed.", { exact: true })).toBeVisible();
  expect((await target())[0]).toMatchObject({ id, is_active: true, removed_at: null });
  expect(await snapshots()).toEqual(captured);
  expect(await media()).toEqual(capturedMedia);

  await page.goto("/analytics/instagram?tab=analyze");
  expect((await searchInstagramRelease(page, INSTAGRAM_RELEASE.lostTarget)).status()).toBe(200);
  let saveCalls = 0;
  let enqueueCalls = 0;
  page.on("request", (request) => { if (request.url().endsWith("/functions/v1/competitor-snapshot-sync") && request.method() === "POST") enqueueCalls++; });
  await page.route(`${INSTAGRAM_RELEASE.apiUrl}/rest/v1/rpc/add_competitor_watchlist`, async (route) => {
    saveCalls++;
    expect(route.request().postDataJSON().p_username).toBe(INSTAGRAM_RELEASE.lostTarget);
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await response.body();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Track", exact: true }).click();
  await expect(page.getByText("Could not confirm the change. Reload to check.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tracked", exact: true })).toBeDisabled();
  const lost = await read("competitor_watchlist", { username: `eq.${INSTAGRAM_RELEASE.lostTarget}` });
  expect(lost).toHaveLength(1);
  expect(await read("instagram_collection_jobs", { watchlist_id: `eq.${lost[0].id}` })).toEqual([]);
  await page.reload();
  expect((await searchInstagramRelease(page, INSTAGRAM_RELEASE.lostTarget)).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Tracked", exact: true })).toBeDisabled();
  expect(saveCalls).toBe(1);
  expect(enqueueCalls).toBe(0);
  expect((await read("competitor_watchlist", { username: `eq.${INSTAGRAM_RELEASE.lostTarget}` })).map((entry: { id: string }) => entry.id)).toEqual([lost[0].id]);
});

test("canonical protected reconnect renews denied insights and replaces the previous generation discovery cache", async ({ page, request }) => {
  const manifest = await prepareInstagramReleaseBrowser(page, request);
  const health = await (await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`)).json();
  const headers = { Authorization: `Bearer ${await syntheticOwnerReleaseKey("service_role")}`,
    "X-Instagram-Release-Namespace": manifest.namespace, "X-Instagram-Release-Candidate": health.candidate };
  const account = manifest.accounts.find((entry) => entry.key === "otherPage")!;
  const control = (path: string, data: Record<string, unknown>) => request.post(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/${path}`, { headers, data });
  const receipts = async (path = "provider-calls") => {
    const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/${path}`, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const read = async (table: string, select: string, filters: Record<string, string>) => {
    const response = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/rest/v1/${table}`, { headers,
      params: { select, user_id: `eq.${manifest.users.ownerB.id}`, ...filters } });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const capability = () => read("instagram_account_capabilities", "credential_generation,permission_read_state,granted_scopes,scopes_read_at",
    { social_account_id: `eq.${account.id}` });
  const binding = () => read("facebook_user_credential_bindings", "credential_id,connection_version", { social_account_id: `eq.${account.id}` });
  const credential = (id: string) => read("facebook_user_credentials", "id,revision,provider_user_id,lifecycle", { id: `eq.${id}` });
  const fence = () => read("facebook_user_credential_connection_fences", "connection_version", { social_account_id: `eq.${account.id}` });
  await signInInstagramRelease(page, manifest, "ownerB");
  await page.goto("/analytics/instagram?tab=analyze");
  const initial = await searchInstagramRelease(page, "release_competitor");
  expect(initial.status()).toBe(200);
  expect((await initial.json()).posts).toEqual(expect.arrayContaining([expect.objectContaining({ mediaType: "REEL", videoViewCount: 300 })]));
  const beforeCapability = (await capability())[0];
  const beforeBinding = (await binding())[0];
  expect(await fence()).toEqual([{ connection_version: beforeBinding.connection_version }]);
  const beforeCredential = (await credential(beforeBinding.credential_id))[0];
  const before = await receipts();
  expect((await control("oauth-authorize", { url: "https://postora.cloud/" })).status()).toBe(400);
  expect((await control("deny-reconnect-permissions", { account: "pageGranted" })).status()).toBe(400);
  const denial = await control("deny-reconnect-permissions", {});
  expect(denial.status()).toBe(200);
  expect(await denial.json()).toMatchObject({ credential_generation: beforeCapability.credential_generation,
    permission_read_state: "ok", granted_scopes: ["instagram_basic"] });
  const refused = await searchInstagramRelease(page, "release_competitor");
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ error_code: "IG_INSIGHTS_SCOPE_MISSING" });
  await expect(page.getByRole("heading", { name: "Synthetic release competitor", exact: true })).toHaveCount(0);
  expect(await receipts()).toEqual(before);
  await page.getByRole("button", { name: "Reconnect Instagram", exact: true }).click();
  await page.waitForURL("**/profiles");
  const row = page.getByRole("row").filter({ hasText: account.username });
  await expect(row).toHaveCount(1);
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Reconnect", exact: true }).click();
  const flow = page.getByRole("dialog", { name: "Connect Instagram", exact: true });
  await expect(flow).toBeVisible();
  await page.route("https://www.facebook.com/v22.0/dialog/oauth?**", async (route) => {
    expect(route.request().method()).toBe("GET");
    const authorization = await control("oauth-authorize", { url: route.request().url() });
    expect(authorization.status()).toBe(200);
    const { redirect_url } = await authorization.json();
    expect(new URL(redirect_url).origin).toBe(INSTAGRAM_RELEASE.apiUrl);
    await route.fulfill({ status: 302, headers: { location: redirect_url }, body: "" });
  });
  await flow.getByRole("button", { name: /^Connect via Facebook Business/ }).click();
  const picker = page.getByRole("dialog", { name: "Choose Instagram account", exact: true });
  await expect(picker).toBeVisible();
  const savedResponse = page.waitForResponse((response) => response.url().endsWith("/functions/v1/instagram-business-oauth")
    && response.request().method() === "POST" && response.request().postDataJSON()?.action === "store_ig_account");
  await picker.getByRole("button", { name: new RegExp(`@${account.username}`) }).click();
  const saved = await savedResponse;
  expect(saved.status()).toBe(200);
  const savedBody = await saved.json();
  expect(savedBody).toMatchObject({ success: true, permissions: { status: "ok", insights_granted: true } });
  for (const token of [account.token, `${account.token}-renewed`, `${account.token}-page`]) expect(JSON.stringify(savedBody)).not.toContain(token);
  await expect(picker).toHaveCount(0);
  const afterCapability = (await capability())[0];
  expect(afterCapability.credential_generation).toBeGreaterThan(beforeCapability.credential_generation);
  expect(afterCapability.permission_read_state).toBe("ok");
  expect(afterCapability.granted_scopes).toContain("instagram_manage_insights");
  expect(Date.parse(afterCapability.scopes_read_at)).toBeGreaterThan(Date.parse(beforeCapability.scopes_read_at));
  const afterBinding = (await binding())[0];
  expect(afterBinding.credential_id).toBe(beforeBinding.credential_id);
  expect(afterBinding.connection_version).toBe(beforeBinding.connection_version + 1);
  expect(await fence()).toEqual([{ connection_version: afterBinding.connection_version }]);
  const afterCredential = (await credential(afterBinding.credential_id))[0];
  expect(afterCredential).toEqual({ ...beforeCredential, revision: beforeCredential.revision + 1 });
  const committed = await read("meta_oauth_attempt_receipts", "credential_id,credential_revision,capability_generation,connection_version",
    { attempt_id: `eq.${savedBody.attempt_id}`, social_account_id: `eq.${account.id}` });
  expect(committed).toEqual([{ credential_id: afterBinding.credential_id, credential_revision: afterCredential.revision,
    capability_generation: afterCapability.credential_generation, connection_version: afterBinding.connection_version }]);
  const accounts = await read("social_accounts", "id,platform_user_id,is_active,needs_reauth", { platform: "eq.instagram" });
  expect(accounts).toEqual([{ id: account.id, platform_user_id: account.providerId, is_active: true, needs_reauth: false }]);
  const oauth = await receipts("oauth-calls");
  expect(oauth.calls.map((call: { operation: string }) => call.operation)).toEqual([
    "authorize", "exchange_code", "exchange_long_token", "identity", "pages", "permissions",
  ]);
  await page.goto("/analytics/instagram?tab=analyze");
  const renewed = await searchInstagramRelease(page, "release_competitor");
  expect(renewed.status()).toBe(200);
  const renewedBody = await renewed.json();
  expect(renewedBody.fromCache).not.toBe(true);
  expect(renewedBody.profile.source).toBe("official");
  expect(renewedBody.posts).toEqual(expect.arrayContaining([expect.objectContaining({ mediaType: "REEL", videoViewCount: 777 })]));
  await expect(page.getByRole("heading", { name: "Synthetic release competitor", exact: true })).toBeVisible();
  const after = await receipts();
  expect(after.calls.slice(before.calls.length).map((call: { account: string; operation: string }) => ({ account: call.account, operation: call.operation })))
    .toEqual([{ account: "otherPage", operation: "discovery" }, { account: "otherPage", operation: "discovery" }]);
  expect(after.apifyCalls).toEqual(before.apifyCalls);
  expect(after.networkRefusals).toBe(0);
  const cached = await searchInstagramRelease(page, "release_competitor");
  expect(cached.status()).toBe(200);
  expect(await cached.json()).toMatchObject({ fromCache: true, posts: renewedBody.posts });
  expect(await receipts()).toEqual(after);
});
