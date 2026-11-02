/** Browser-only adapter; the canonical backend never imports Playwright or presentation stubs. */
import type { APIRequestContext, Page } from "@playwright/test";
import {
  INSTAGRAM_RELEASE, assertInstagramReleaseManifest, assertInstagramReleaseNetworkUrl,
  requireInstagramReleaseHealth, requireInstagramReleaseLogin, type InstagramReleaseManifest, type ReleaseUserKey,
} from "./instagramRelease.ts";

// Task 8 keeps its presentation truth model. These names cannot be mistaken for SQL evidence.
export {
  installCompetitorTrackingMocks as installPresentationOnlyCompetitorMocks,
  createCompetitorMockStore as createPresentationOnlyCompetitorStore,
} from "./competitorTracking.ts";

export async function prepareInstagramReleaseBrowser(page: Page, request: APIRequestContext): Promise<InstagramReleaseManifest> {
  const health = await request.get(`${INSTAGRAM_RELEASE.apiUrl}/__instagram-release/health`);
  const manifest = await requireInstagramReleaseHealth(new Response(await health.body(), { status: health.status() }));
  await page.route("**/*", async (route) => {
    try { assertInstagramReleaseNetworkUrl(route.request().url(), "browser"); }
    catch { await route.abort("blockedbyclient"); throw new Error("Instagram release browser refused unexpected network access"); }
    await route.continue();
  });
  await page.routeWebSocket("**/*", (socket) => {
    if (!socket.url().startsWith("ws://127.0.0.1:8080/")) throw new Error("Instagram release browser refused unexpected WebSocket");
    socket.connectToServer();
  });
  await page.clock.setFixedTime(new Date(manifest.referenceInstant));
  await page.addInitScript(() => localStorage.setItem("postora.language", "en"));
  return manifest;
}

export async function signInInstagramRelease(page: Page, manifest: InstagramReleaseManifest, key: ReleaseUserKey): Promise<void> {
  assertInstagramReleaseManifest(manifest);
  await page.goto("/auth");
  await page.getByPlaceholder("you@example.com").fill(manifest.users[key].email);
  await page.locator('input[type="password"]').fill(INSTAGRAM_RELEASE.password);
  const response = page.waitForResponse((reply) => reply.url().startsWith(`${INSTAGRAM_RELEASE.apiUrl}/auth/v1/token?`));
  await page.getByRole("button", { name: /^Sign In$/i }).click();
  const login = await response;
  await requireInstagramReleaseLogin(new Response(await login.body(), { status: login.status() }), manifest.users[key].id);
  await page.waitForURL("**/dashboard");
}
