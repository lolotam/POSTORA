/**
 * Offline mocked-browser fixture for the Stage 3 journeys.
 *
 * Seeds a synthetic local session and answers every backend call the app
 * makes. No live account, no live YouTube, no production Supabase. Anything
 * unmocked is aborted so a journey cannot silently talk to a real stack.
 *
 * The app runs its real components and real gateway; only the HTTP boundary
 * is substituted. An edit capability is the ONLY thing that can make the
 * edit affordance appear, and it is off unless a test opts in explicitly.
 */

import type { Page, Route } from "@playwright/test";

export const OWNER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "youtube-stage3-owner@example.test",
} as const;

export const ACCOUNT = {
  id: "22222222-2222-4222-8222-222222222222",
  channelId: "UCstage3fixturechannel001",
  username: "stage3-fixture",
} as const;

export const VIDEO = {
  id: "AbcD1234eFg",
  title: "Original title",
  categoryId: "22",
  privacy: "private",
} as const;

export type EditScenario = "available" | "conflict" | "unknown" | "reconnect" | "off";

/** Mutations the browser actually sent, so a journey can assert the wire body. */
export const youtubeFixtureState = {
  updateRequests: [] as Array<{
    videoId: unknown;
    baseRevision: unknown;
    changes: Record<string, unknown>;
  }>,
};

export interface Stage3Scenario {
  locale?: "en" | "ar";
  edit?: EditScenario;
  requestedPrivacy?: "public" | "unlisted" | "private";
  followUps?: {
    thumbnail: "not_requested" | "applied" | "skipped" | "failed" | "unknown";
    first_comment: "not_requested" | "applied" | "skipped" | "failed" | "unknown";
  };
}

function requireLocalUrl(): string {
  const url = process.env.VITE_SUPABASE_URL;
  if (!url || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) {
    throw new Error(
      "Stage 3 mocked journeys require a LOCAL VITE_SUPABASE_URL, e.g. " +
        "VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_PUBLISHABLE_KEY=synthetic-key",
    );
  }
  return url;
}

function storageKey(url: string): string {
  const host = new URL(url).hostname;
  return `sb-${host.split(".")[0] || "local"}-auth-token`;
}

export async function startStage3Journey(page: Page, scenario: Stage3Scenario = {}): Promise<void> {
  youtubeFixtureState.updateRequests = [];
  const url = requireLocalUrl();
  await page.addInitScript(
    ({ key, owner, locale }) => {
      localStorage.setItem(key, JSON.stringify({
        access_token: `synthetic.${owner.id}`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: "synthetic-refresh-token-long-enough",
        user: { id: owner.id, aud: "authenticated", role: "authenticated", email: owner.email },
      }));
      localStorage.setItem("postora.language", locale);
    },
    { key: storageKey(url), owner: OWNER, locale: scenario.locale ?? "en" },
  );

  // Registered first so the specific routes below take precedence.
  await page.route(/.*/, (route) => {
    const requestUrl = route.request().url();
    if (/^http:\/\/(?:localhost|127\.0\.0\.1):(?:8080|8091)(?:\/|$)/.test(requestUrl)) {
      return route.continue();
    }
    return route.abort("blockedbyclient");
  });

  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  // App-bootstrap reads the layout makes before any feature renders. Returning
  // empty arrays keeps hooks resolved without inventing owner state.
  await page.route(/\/rest\/v1\//, (route) => json(route, 200, []));
  await page.route(/\/auth\/v1\//, (route) => json(route, 200, {}));
  await page.route(/\/functions\/v1\//, (route) => json(route, 200, {
    schema_version: 1,
    request_id: "stage3-fixture",
    freshness: { fetched_at: "2026-11-22T10:00:00.000Z", source: "database" },
    data: {},
  }));
  await page.route(/\/rest\/v1\/rpc\/get_user_role/, (route) => json(route, 200, "user"));
  const envelope = (data: unknown) => ({
    schema_version: 1,
    request_id: "stage3-fixture-request",
    freshness: { fetched_at: "2026-11-22T10:00:00.000Z", source: "provider" },
    data,
  });

  await page.route(/\/rest\/v1\/app_settings/, (route) =>
    json(route, 200, [
      { key: "feature_youtube_management", value: true },
      { key: "feature_youtube_comments", value: true },
      { key: "feature_platform_access", value: { youtube: true } },
    ]));

  await page.route(/\/rest\/v1\/profiles/, (route) =>
    json(route, 200, [{ id: OWNER.id, email: OWNER.email, full_name: "Stage 3 Owner" }]));

  await page.route(/\/rest\/v1\/social_accounts/, (route) =>
    json(route, 200, [{
      id: ACCOUNT.id,
      user_id: OWNER.id,
      platform: "youtube",
      platform_user_id: ACCOUNT.channelId,
      platform_username: ACCOUNT.username,
      auth_provider: null,
      is_active: true,
      needs_reauth: false,
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      token_expires_at: "2099-01-01T00:00:00Z",
      account_metadata: { granted_scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"] },
    }]));

  await page.route(/\/functions\/v1\/youtube-resources/, async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { operation?: string };
    const operation = body.operation;
    if (operation === "capabilities") {
      const state = scenario.edit === "reconnect"
        ? { state: "unavailable", reason: "reconnect_required" }
        : scenario.edit && scenario.edit !== "off"
          ? { state: "available" }
          : { state: "unavailable", reason: "provider_unsupported" };
      return json(route, 200, envelope({
        account_id: ACCOUNT.id,
        channel_id: ACCOUNT.channelId,
        channel_title: ACCOUNT.username,
        provider: "native",
        connection: "ok",
        scopes: { readonly: "granted", upload: "granted", force_ssl: "granted" },
        capabilities: { browse: { state: "available" }, upload: { state: "available" }, comments: { state: "available" }, edit_metadata: state },
        quota: { provider_quota: "not_tracked", unit_costs: {}, per_user_burst: { limit: 30, window_seconds: 600 }, per_user_daily: { limit: 300, window_seconds: 86400 } },
      }));
    }
    if (operation === "categories") {
      return json(route, 200, envelope({
        region: "US",
        locale: scenario.locale === "ar" ? "ar" : "en",
        source: "provider",
        categories: [
          { id: "22", name: scenario.locale === "ar" ? "الأشخاص والمدونات" : "People & Blogs", label: "⁨22⁩ (" + (scenario.locale === "ar" ? "الأشخاص والمدونات" : "People & Blogs") + ")", assignable: true },
          { id: "30", name: "Movies", label: "⁨30⁩ (Movies)", assignable: false },
        ],
      }));
    }
    if (operation === "channel") {
      return json(route, 200, envelope({
        id: ACCOUNT.channelId, title: ACCOUNT.username, description: "", custom_url: null,
        thumbnail_url: null, published_at: null, country: null, privacy_status: "public",
        statistics: { view_count: 10, subscriber_count: 5, subscriber_count_hidden: false, video_count: 1 },
      }));
    }
    if (operation === "videos") {
      return json(route, 200, envelope({ items: [{
        id: VIDEO.id, title: VIDEO.title, thumbnail_url: null, published_at: null,
        privacy_status: VIDEO.privacy, url: `https://www.youtube.com/watch?v=${VIDEO.id}`,
      }], next_page_token: null, total_results: 1 }));
    }
    if (operation === "video" || operation === "edit_snapshot") {
      return json(route, 200, envelope({
        revision: "fixture-revision-1",
        fetchedAt: "2026-11-22T10:00:00.000Z",
        id: VIDEO.id,
        channelId: ACCOUNT.channelId,
        videoId: VIDEO.id,
        title: VIDEO.title,
        description: "Fixture description",
        category_id: VIDEO.categoryId,
        categoryId: VIDEO.categoryId,
        privacy_status: VIDEO.privacy,
        values: {
          title: VIDEO.title,
          description: "Fixture description",
          tags: [],
          privacyStatus: VIDEO.privacy,
          categoryId: VIDEO.categoryId,
        },
        restrictions: { scheduleProtected: false, unknownFieldsBlocked: false },
        tags: [],
        duration_iso8601: null,
        thumbnail_url: null,
        url: `https://www.youtube.com/watch?v=${VIDEO.id}`,
        statistics: { view_count: 10, like_count: 1, comment_count: 0 },
      }));
    }
    if (operation === "update_video") {
      youtubeFixtureState.updateRequests.push({
        videoId: body.video_id,
        baseRevision: body.base_revision,
        changes: (body.changes ?? {}) as Record<string, unknown>,
      });
      if (scenario.edit === "conflict") return json(route, 409, { error: "edit_conflict", request_id: "fixture" });
      if (scenario.edit === "unknown") return json(route, 502, { error: "outcome_unknown", request_id: "fixture" });
      if (scenario.edit === "reconnect") return json(route, 409, { error: "reconnect_required", request_id: "fixture" });
      return json(route, 200, envelope({ revision: "fixture-revision-2" }));
    }
    return json(route, 400, { error: "invalid_request", request_id: "fixture" });
  });

  await page.route(/\/rest\/v1\/posts/, (route) =>
    json(route, 200, [{
      id: "44444444-4444-4444-8444-444444444444",
      user_id: OWNER.id,
      caption: "Stage 3 fixture post",
      platforms: ["youtube"],
      media_file_ids: [],
      status: "completed",
      scheduled_at: null,
      posted_at: "2026-11-22T10:00:00.000Z",
      metadata: {},
      created_at: "2026-11-22T10:00:00.000Z",
    }]));
  await page.route(/\/rest\/v1\/platform_posts/, (route) => json(route, 200, [{
    id: "33333333-3333-4333-8333-333333333333",
    post_id: "44444444-4444-4444-8444-444444444444",
    platform: "youtube",
    status: "success",
    platform_post_url: `https://www.youtube.com/watch?v=${VIDEO.id}`,
    error_message: null,
    response_data: {
      youtube_publish_evidence: {
        requested_privacy: scenario.requestedPrivacy ?? "private",
        effective_privacy: "unknown",
        thumbnail: { state: scenario.followUps?.thumbnail ?? "not_requested", reason: null },
        first_comment: { state: scenario.followUps?.first_comment ?? "not_requested", reason: null },
      },
    },
  }]));
}
