import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { OWNER_RELEASE } from "./instagramOwnerReleaseSettings.mjs";

export async function prepareOwnerBrowser(page: Page, request: APIRequestContext) {
  const health = await request.get(`${OWNER_RELEASE.apiUrl}/__owner-release/health`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ fixture: "isolated-owner-release", authReachable: true, sqlReachable: true });
  await page.addInitScript(() => localStorage.setItem("postora.language", "en"));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) && ["8080", "65431"].includes(url.port)
      ? route.continue() : route.abort("blockedbyclient");
  });
}

export async function signInThroughBrowser(page: Page, email = OWNER_RELEASE.email) {
  await page.goto("/auth");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.locator('input[type="password"]').fill(OWNER_RELEASE.password);
  await page.getByRole("button", { name: /^Sign In$/i }).click();
  await page.waitForURL("**/dashboard");
}
