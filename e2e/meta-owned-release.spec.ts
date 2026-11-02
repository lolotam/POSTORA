import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { OWNER_RELEASE, syntheticOwnerReleaseKey } from "./fixtures/instagramOwnerReleaseSeed";
import { META_ACCOUNTS, META_PLATFORMS, type MetaFixturePlatform } from "./fixtures/metaOwnedRelease";
import { prepareOwnerBrowser, signInThroughBrowser } from "./fixtures/ownerReleaseBrowser";

test.beforeEach(async ({ page, request }) => { await prepareOwnerBrowser(page, request); });
const account = (platform: MetaFixturePlatform, kind: string) => META_ACCOUNTS.find((entry) => entry.platform === platform && entry.kind === kind)!;
const route = (platform: MetaFixturePlatform) => `/analytics/${platform}?tab=${platform === "facebook" ? "performance" : "insights"}`;
const performance = (page: Page) => page.getByRole("region", { name: "Connected account performance" });
const reportReply = (page: Page, platform: MetaFixturePlatform, status = 200) => page.waitForResponse((response) =>
  response.url().endsWith("/functions/v1/meta-owned-analytics-report") && response.status() === status
    && response.request().postDataJSON()?.platform === platform);

async function control(request: APIRequestContext, platform?: MetaFixturePlatform, action?: string) {
  const headers = { Authorization: `Bearer ${await syntheticOwnerReleaseKey("service_role")}` };
  const response = action ? await request.post(`${OWNER_RELEASE.apiUrl}/__owner-release/meta-owned`, { headers, data: { platform, action } })
    : await request.get(`${OWNER_RELEASE.apiUrl}/__owner-release/meta-owned`, { headers });
  expect(response.status()).toBe(200);
  return await response.json();
}

for (const platform of META_PLATFORMS) {
  test(`${platform} saved browser selects accounts and periods, paginates without duplicates and recovers revision conflicts`, async ({ page, request }) => {
    const before = await control(request);
    await signInThroughBrowser(page);
    const initial = reportReply(page, platform);
    await page.goto(route(platform));
    const first = await (await initial).json();
    expect(first.accountId).toBe(account(platform, "active").id);
    const region = performance(page);
    await expect(region.getByLabel("Account")).toHaveValue(account(platform, "active").id);
    const summary = region.getByRole("article").filter({ has: page.getByRole("heading", { name: platform === "facebook" ? "Views" : "Profile views", exact: true }) });
    await expect(summary.locator("div.tabular-nums")).toHaveText("0");
    const reach = region.getByRole("article").filter({ has: page.getByRole("heading", { name: "Reach", exact: true }) });
    await expect(reach).toContainText("Not available");
    await expect(reach.locator("div.tabular-nums")).not.toHaveText("0");
    const savedPosts = region.getByText(new RegExp(`^Saved ${platform} active post \\d{2}$`));
    await expect(savedPosts).toHaveCount(25);
    await region.getByRole("checkbox", { name: "Rank loaded posts by lifetime views" }).check();
    await expect(region.getByText(/Ranking covers loaded posts only/)).toBeVisible();
    const continued = reportReply(page, platform);
    await region.getByRole("button", { name: "Load more posts" }).click();
    await continued;
    await expect(savedPosts).toHaveCount(26);
    expect(new Set(await savedPosts.allTextContents()).size).toBe(26);
    await expect(region.getByRole("button", { name: "Load more posts" })).toHaveCount(0);
    const period = reportReply(page, platform);
    await region.getByLabel("Period").selectOption("14");
    expect((await (await period).json()).period.days).toBe(14);
    await expect(savedPosts).toHaveCount(25);
    const archived = reportReply(page, platform);
    await region.getByLabel("Account").selectOption(account(platform, "archived").id);
    expect((await (await archived).json()).accountId).toBe(account(platform, "archived").id);
    await expect(region.getByText(`Saved ${platform} archived post 00`, { exact: true })).toBeVisible();
    await expect(region.getByText("Reconnect the account to resume collection.", { exact: true })).toBeVisible();
    await region.getByLabel("Account").selectOption(account(platform, "active").id);
    await expect(region.getByRole("button", { name: "Load more posts" })).toBeVisible();
    await control(request, platform, "revision");
    const conflict = reportReply(page, platform, 409);
    await region.getByRole("button", { name: "Load more posts" }).click();
    expect((await (await conflict).json()).reason).toBe("history_revision_changed");
    const alert = region.getByRole("alert");
    await expect(alert).toContainText("Saved history changed");
    const refreshed = reportReply(page, platform);
    await alert.getByRole("button", { name: "Refresh report" }).click();
    await refreshed;
    await expect(alert).toHaveCount(0);
    expect((await control(request)).calls.length).toBe(before.calls.length);
  });

  test(`${platform} actual worker refresh preserves saved data and exposes permission and credential failures`, async ({ page, request }) => {
    const before = await control(request);
    await signInThroughBrowser(page);
    await page.goto(route(platform));
    const region = performance(page);
    await expect(region.getByText(`Saved ${platform} active post 00`, { exact: true })).toBeVisible();
    for (let visit = 0; visit < 2; visit++) {
      const receipt = await control(request, platform, "drain");
      expect(receipt.enqueue.ok).toBe(true);
      expect(receipt.drain.ok).toBe(true);
      expect(receipt.drain.status).not.toBe("unavailable");
    }
    const refreshed = reportReply(page, platform);
    await region.getByRole("button", { name: "Refresh report" }).click();
    await refreshed;
    const collected = region.getByRole("article").filter({ has: page.getByText(`Collected ${platform} active post 00`, { exact: true }) });
    await expect(collected).toBeVisible();
    await expect(collected.locator("dd").first()).toContainText("42");
    for (const [kind, reason] of [["permission", "A required permission is missing."], ["expired", "Reconnect the account to resume collection."]]) {
      const reply = reportReply(page, platform);
      await region.getByLabel("Account").selectOption(account(platform, kind).id);
      const report = await (await reply).json();
      expect(report.sync.status).toBe("failed");
      expect(report.sync.reason).toBe(kind === "permission" ? "permission_missing" : "reauth_required");
      await expect(region.getByText(reason, { exact: true }).first()).toBeVisible();
      await expect(region.getByText(`Saved ${platform} ${kind} post 24`, { exact: true })).toBeVisible();
    }
    await control(request, platform, "disconnect");
    await page.reload();
    await region.getByLabel("Account").selectOption(account(platform, "active").id);
    await expect(region.getByText("Reconnect the account to resume collection.", { exact: true }).first()).toBeVisible();
    await expect(region.getByText(`Collected ${platform} active post 00`, { exact: true })).toBeVisible();
    const after = await control(request);
    expect(after.fingerprints).toEqual(before.fingerprints);
    const calls = after.calls.slice(before.calls.length);
    expect(calls.some((call: { platform: string; kind: string }) => call.platform === platform && call.kind === "metric")).toBe(true);
    expect(calls.some((call: { account: string }) => ["foreign", "archived"].includes(call.account))).toBe(false);
  });

  test(`${platform} real identity switch and direct requests cannot reuse another owner history or cursor`, async ({ page, request }) => {
    const login = await request.post(`${OWNER_RELEASE.apiUrl}/auth/v1/token?grant_type=password`, { data: { email: OWNER_RELEASE.email, password: OWNER_RELEASE.password } });
    expect(login.status()).toBe(200);
    const token = (await login.json()).access_token;
    const read = (id: string) => request.post(`${OWNER_RELEASE.apiUrl}/functions/v1/meta-owned-analytics-report`, {
      headers: { Authorization: `Bearer ${token}` }, data: { platform, accountId: id, periodDays: 7, analyticsContractVersion: 1, user_id: OWNER_RELEASE.otherOwnerId },
    });
    const foreign = await read(account(platform, "foreign").id);
    const missing = await read("8e099999-0000-4000-8000-000000000099");
    expect(foreign.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    await signInThroughBrowser(page);
    await page.goto(route(platform));
    const region = performance(page);
    await region.getByLabel("Account").selectOption(account(platform, "active").id);
    await expect(region.getByRole("button", { name: "Load more posts" })).toBeVisible();
    await region.getByRole("button", { name: "Load more posts" }).click();
    await expect(region.getByRole("button", { name: "Load more posts" })).toHaveCount(0);
    await page.locator("header").getByRole("button", { name: "IN", exact: true }).click();
    await page.getByRole("menuitem", { name: "Logout", exact: true }).click();
    await page.waitForURL("/");
    const requests: { accountId: string; cursor?: string | null }[] = [];
    page.on("request", (outgoing) => { if (outgoing.url().endsWith("/functions/v1/meta-owned-analytics-report")) requests.push(outgoing.postDataJSON()); });
    await signInThroughBrowser(page, "instagram-owner-release-other@example.test");
    await page.goto(route(platform));
    await expect(region.getByLabel("Account")).toHaveValue(account(platform, "foreign").id);
    await expect(region.getByText(`Saved ${platform} foreign post 00`, { exact: true })).toBeVisible();
    await expect(region.getByText(new RegExp(`^(Saved|Collected) ${platform} active post`))).toHaveCount(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((entry) => entry.accountId === account(platform, "foreign").id && entry.cursor === null)).toBe(true);
  });
}
