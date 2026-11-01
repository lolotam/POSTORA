import { expect, test } from "@playwright/test";
import { OWNER_RELEASE, syntheticOwnerReleaseKey } from "./fixtures/instagramOwnerReleaseSeed";

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

test("real login, persisted report pagination, isolated chart points and durable sync", async ({ page, request }) => {
  await page.goto("/auth");
  await page.getByPlaceholder("you@example.com").fill(OWNER_RELEASE.email);
  await page.locator('input[type="password"]').fill(OWNER_RELEASE.password);
  await page.getByRole("button", { name: /^Sign In$/i }).click();
  await page.waitForURL("**/dashboard");
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
