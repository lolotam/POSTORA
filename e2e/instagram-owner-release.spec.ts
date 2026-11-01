import { expect, test, type Page } from "@playwright/test";
import { OWNER_RELEASE, syntheticOwnerReleaseKey } from "./fixtures/instagramOwnerReleaseSeed";
import type { OwnerReport } from "../supabase/functions/instagram-insights-report/contracts";

test.beforeEach(async ({ page, request }) => {
  const health = await request.get(`${OWNER_RELEASE.apiUrl}/__owner-release/health`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ fixture: "isolated-owner-release", authReachable: true, sqlReachable: true });
  await page.addInitScript(() => localStorage.setItem("postora.language", "en"));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) && ["8080", "65431"].includes(url.port)
      ? route.continue() : route.abort("blockedbyclient");
  });
});

async function signInThroughBrowser(page: Page, email = OWNER_RELEASE.email) {
  await page.goto("/auth");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.locator('input[type="password"]').fill(OWNER_RELEASE.password);
  await page.getByRole("button", { name: /^Sign In$/i }).click();
  await page.waitForURL("**/dashboard");
}

test("real login, persisted report pagination, isolated chart points and durable sync", async ({ page, request }) => {
  await signInThroughBrowser(page);
  await page.goto("/analytics/instagram?tab=performance");
  await expect(page.getByText("14.2K", { exact: true })).toBeVisible();
  await expect(page.locator(".recharts-line-dots circle")).toHaveCount(6);
  await expect(page.getByText("owner-release-media-20", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Load more/i }).click();
  await expect(page.getByText("owner-release-media-20", { exact: true })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(22);
  await expect(page.getByRole("button", { name: /Load more/i })).toHaveCount(0);

  await page.getByRole("button", { name: /^7d$/ }).click();
  await expect(page.getByRole("row")).toHaveCount(5);
  await expect(page.getByText("owner-release-media-20", { exact: true })).toHaveCount(0);
  const queued = page.waitForResponse((response) => response.url().endsWith("/functions/v1/instagram-insights-sync") && response.request().method() === "POST");
  await page.getByRole("button", { name: /Sync now/i }).click();
  expect((await queued).status()).toBe(202);

  const serviceKey = await syntheticOwnerReleaseKey("service_role");
  const drained = await request.post(`${OWNER_RELEASE.apiUrl}/functions/v1/instagram-insights-sync`, {
    headers: { Authorization: `Bearer ${serviceKey}` }, data: { action: "drain" },
  });
  expect(drained.status()).toBe(200);
  const receipt = await drained.json();
  expect(receipt.completed).toBe(1);
  expect(receipt.unavailable).toBe(0);
  await page.reload();
  await expect(page.getByText("120", { exact: true })).toBeVisible();
  const calls = await request.get(`${OWNER_RELEASE.apiUrl}/__owner-release/provider-calls`, { headers: { Authorization: `Bearer ${serviceKey}` } });
  const providerCalls = await calls.json();
  expect(providerCalls.length).toBeGreaterThan(0);
  expect(providerCalls.every((call: { target: string }) => call.target === "ig-owner-release")).toBe(true);

  const off = await request.post(`${OWNER_RELEASE.apiUrl}/__owner-release/collection-off`, { headers: { Authorization: `Bearer ${serviceKey}` } });
  expect(await off.json()).toEqual({ collectionEnabled: false });
  await page.getByRole("button", { name: /Sync now/i }).click();
  await expect(page.getByText("Instagram insights collection is currently disabled. Contact support to check availability.")).toBeVisible();
  await expect(page.getByText("120", { exact: true })).toBeVisible();
});

test("account reads show loading, a safe failure and retry without claiming no connection", async ({ page }) => {
  await signInThroughBrowser(page);
  await page.goto("/analytics/instagram?tab=performance");
  await expect(page.getByText("@owner_release", { exact: true })).toBeVisible();
  let fail = true;
  let releaseRead: () => void = () => {};
  const pendingRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  await page.route(/\/rest\/v1\/social_accounts(?:\?|$)/, async (route) => {
    if (!fail || route.request().method() !== "GET") return route.fallback();
    await pendingRead;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "XX000", message: "private fixture database failure" }) });
  });
  await page.reload();
  await expect(page.getByRole("status", { name: "Loading..." })).toBeVisible();
  await expect(page.getByText("Connect Your Instagram Account", { exact: true })).toHaveCount(0);
  releaseRead();
  // PostgREST retries GET 503 three times with 1s/2s/4s backoff before surfacing the failure.
  await expect(page.getByRole("alert")).toContainText("Failed to load connected accounts. Please try again.", { timeout: 15_000 });
  await expect(page.getByText("private fixture database failure", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Connect Your Instagram Account", { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("@owner_release", { exact: true })).toBeVisible();
  await expect(page.getByText("Failed to load connected accounts. Please try again.")).toHaveCount(0);
});

test("actual Auth identities enforce identical foreign and nonexistent report refusals", async ({ request }) => {
  const login = await request.post(`${OWNER_RELEASE.apiUrl}/auth/v1/token?grant_type=password`, {
    data: { email: OWNER_RELEASE.email, password: OWNER_RELEASE.password },
  });
  expect(login.status()).toBe(200);
  const { access_token: token } = await login.json();
  const report = (account: string, userId?: string) => request.post(`${OWNER_RELEASE.apiUrl}/functions/v1/instagram-insights-report`, {
    headers: { Authorization: `Bearer ${token}` }, data: { social_account_id: account, period_days: 30, user_id: userId },
  });
  const own = await report(OWNER_RELEASE.accountId, OWNER_RELEASE.otherOwnerId);
  expect(own.status()).toBe(200);
  expect((await own.json()).scope.ownerId).toBe(OWNER_RELEASE.ownerId);
  const foreign = await report(OWNER_RELEASE.otherAccountId);
  const missing = await report("8e020000-0000-4000-8000-000000000099");
  expect(foreign.status()).toBe(404);
  expect(missing.status()).toBe(404);
  expect(await foreign.json()).toEqual(await missing.json());
});

test("Arabic RTL keeps unavailable reach explicit and period controls work with the keyboard", async ({ page }) => {
  await signInThroughBrowser(page);
  await page.goto("/analytics/instagram?tab=performance");
  await expect(page.getByText("@owner_release", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Toggle language", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByText("غير متاح", { exact: true })).toBeVisible();
  await expect(page.getByText("الوصول الفريد يتطلب إجماليًا مطابقًا للفترة من Meta.", { exact: true })).toBeVisible();
  const reportResponse = page.waitForResponse((response) => response.url().endsWith("/functions/v1/instagram-insights-report")
    && response.request().postDataJSON()?.period_days === 7);
  const periodButton = page.getByRole("button", { name: /^7d$/ });
  await periodButton.focus();
  await expect(periodButton).toBeFocused();
  await periodButton.press("Enter");
  expect((await reportResponse).status()).toBe(200);
  await expect(page.getByRole("button", { name: "زامن دلوقتي", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Toggle language", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByText("An exact period total is required for unique reach.", { exact: true })).toBeVisible();
});

test("signing out and switching real identities never reuses the previous owner's report", async ({ page }) => {
  await signInThroughBrowser(page);
  await page.goto("/analytics/instagram?tab=performance");
  await expect(page.getByText("@owner_release", { exact: true })).toBeVisible();
  await expect(page.getByText("owner-release-media-0", { exact: true })).toBeVisible();
  await page.locator("header").getByRole("button", { name: "IN", exact: true }).click();
  await page.getByRole("menuitem", { name: "Logout", exact: true }).click();
  await page.waitForURL("/");
  await signInThroughBrowser(page, "instagram-owner-release-other@example.test");
  await page.goto("/analytics/instagram?tab=performance");
  await expect(page.getByText("@other_owner_release", { exact: true })).toBeVisible();
  await expect(page.getByText("@owner_release", { exact: true })).toHaveCount(0);
  await expect(page.getByText("owner-release-media-0", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Not available", { exact: true })).toHaveCount(4);
});

test("direct report, authenticated public API and MCP preserve the complete stored report", async ({ request }) => {
  const login = await request.post(`${OWNER_RELEASE.apiUrl}/auth/v1/token?grant_type=password`, {
    data: { email: OWNER_RELEASE.email, password: OWNER_RELEASE.password },
  });
  expect(login.status()).toBe(200);
  const { access_token: token } = await login.json();
  const startedAt = Date.now();
  const direct = await request.post(`${OWNER_RELEASE.apiUrl}/functions/v1/instagram-insights-report`, {
    headers: { Authorization: `Bearer ${token}` }, data: { social_account_id: OWNER_RELEASE.accountId, period_days: 30 },
  });
  expect(direct.status()).toBe(200);
  const api = await request.get(`${OWNER_RELEASE.apiUrl}/functions/v1/n8n-api/api/v1/analytics`, {
    headers: { "x-api-key": OWNER_RELEASE.apiKey }, params: { social_account_id: OWNER_RELEASE.accountId, period_days: 30 },
  });
  expect(api.status()).toBe(200);
  const mcp = await request.post(`${OWNER_RELEASE.apiUrl}/functions/v1/mcp/read`, {
    headers: { Authorization: `Bearer ${OWNER_RELEASE.apiKey}`, Accept: "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "get_post_analytics", arguments: { social_account_id: OWNER_RELEASE.accountId, period_days: 30 },
    } },
  });
  expect(mcp.status()).toBe(200);
  const envelope = await mcp.json();
  expect(envelope.error).toBeUndefined();
  expect(envelope.result.isError).not.toBe(true);
  const mcpReport: OwnerReport = JSON.parse(envelope.result.content[0].text);
  const finishedAt = Date.now();
  const stableReport = (report: OwnerReport) => {
    const generatedAt = Date.parse(report.generatedAt);
    expect(generatedAt).toBeGreaterThanOrEqual(startedAt);
    expect(generatedAt).toBeLessThanOrEqual(finishedAt);
    expect(report.period.windowEnd).toBe(report.generatedAt);
    expect(generatedAt - Date.parse(report.period.windowStart)).toBe(30 * 86_400_000);
    // Only request-clock instants differ; all persisted data, coverage, cursors and failure reasons must match.
    return { ...report, generatedAt: "request-clock", period: { ...report.period, windowStart: "request-clock", windowEnd: "request-clock" } };
  };
  const directReport = stableReport(await direct.json());
  expect(stableReport(await api.json())).toEqual(directReport);
  expect(stableReport(mcpReport)).toEqual(directReport);
  for (const accountId of [OWNER_RELEASE.otherAccountId, "8e020000-0000-4000-8000-000000000099"]) {
    const refused = await request.get(`${OWNER_RELEASE.apiUrl}/functions/v1/n8n-api/api/v1/analytics`, {
      headers: { "x-api-key": OWNER_RELEASE.apiKey }, params: { social_account_id: accountId, period_days: 30 },
    });
    expect(refused.status()).toBe(404);
    const refusal = await refused.json();
    expect(refusal.error.code).toBe("ACCOUNT_NOT_FOUND");
    const mcpRefused = await request.post(`${OWNER_RELEASE.apiUrl}/functions/v1/mcp/read`, {
      headers: { Authorization: `Bearer ${OWNER_RELEASE.apiKey}`, Accept: "application/json" },
      data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "get_post_analytics", arguments: { social_account_id: accountId, period_days: 30 },
      } },
    });
    expect(mcpRefused.status()).toBe(200);
    const mcpRefusal = (await mcpRefused.json()).result;
    expect(mcpRefusal.isError).toBe(true);
    expect(mcpRefusal.content[0].text).toBe(`Postora API error 404: ${JSON.stringify(refusal)}`);
  }
});
