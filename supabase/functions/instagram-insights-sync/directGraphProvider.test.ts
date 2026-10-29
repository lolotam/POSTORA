/**
 * The Instagram-login Graph adapter of the OWNER collection.
 *
 * WHAT THIS SUITE COVERS
 *
 *   1. the HOST: every call goes to graph.instagram.com, never to
 *      graph.facebook.com, and never to a host the adapter did not build;
 *   2. the FIELDS: the media request asks for the fields Meta documents for
 *      the Instagram API with Instagram Login, and it does NOT ask for the
 *      two fields Meta documents as Facebook-login only;
 *   3. the ACCOUNT DAY: the documented `metric_type=total_value` request
 *      and the documented `total_value.value` answer, with a missing metric
 *      staying null;
 *   4. the MEDIA INSIGHTS: the documented `values[].value` answer, the
 *      documented metric set, and the ALBUM - which IS asked, because the
 *      media the reference excludes are the media WITHIN an album;
 *   5. the PAGINATION: a page without a next-page URL is the last page, and
 *      the provider's own URL is never requested;
 *   6. the THROTTLE BUCKET: a digest of the app, the account and the
 *      credential generation, and never of the token;
 *   7. the APP NAMESPACE: the Instagram-login app id and never the
 *      Facebook-login app id, with a stable unconfigured namespace when the
 *      Instagram app id is not set.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  directMediaInsightMetrics,
  InstagramDirectGraphProvider,
  resolveDirectAppId,
  UNCONFIGURED_DIRECT_APP_NAMESPACE,
} from "./directGraphProvider.ts";
import { sha256Hex } from "./providerTransport.ts";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function providerWith(
  responder: (url: string) => Response | Promise<Response>,
  options: { appId?: string } = {},
): { provider: InstagramDirectGraphProvider; urls: string[] } {
  const urls: string[] = [];
  const provider = new InstagramDirectGraphProvider({
    appId: options.appId ?? "the-app",
    fetchFn: ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      return Promise.resolve(responder(url));
    }) as unknown as typeof fetch,
  });
  return { provider, urls };
}

/** The documented account day answer, in the documented `total_value` shape. */
function accountDayAnswer(
  metrics: Readonly<Record<string, number>>,
): Record<string, unknown> {
  return {
    data: Object.entries(metrics).map(([name, value]) => ({
      name,
      period: "day",
      total_value: { value },
    })),
  };
}

/** The documented media insights answer, in the documented `values` shape. */
function mediaInsightAnswer(
  metrics: Readonly<Record<string, number>>,
): Record<string, unknown> {
  return {
    data: Object.entries(metrics).map(([name, value]) => ({
      name,
      period: "lifetime",
      values: [{ value }],
    })),
  };
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

Deno.test("every call goes to the Instagram login host", async () => {
  const { provider, urls } = providerWith(() =>
    jsonResponse({ followers_count: 3200, media_count: 42 })
  );

  await provider.fetchAccountProfile({
    igUserId: "1784140001",
    token: "the-token",
    signal: new AbortController().signal,
  });

  assertEquals(urls.length, 1);
  assert(urls[0]!.startsWith("https://graph.instagram.com/"));
  assertEquals(urls[0]!.includes("graph.facebook.com"), false);
});

Deno.test("the version is pinned and it is the Instagram API version", async () => {
  const { provider, urls } = providerWith(() => jsonResponse({ data: [] }));

  await provider.fetchAccountDay({
    igUserId: "1784140001",
    token: "the-token",
    date: "2026-10-27",
    signal: new AbortController().signal,
  });

  assertStringIncludes(urls[0]!, "https://graph.instagram.com/v22.0/");
});

Deno.test("a malformed configured version is a configuration refusal", () => {
  let refused = false;
  try {
    new InstagramDirectGraphProvider({ apiVersion: "not-a-version" });
  } catch {
    refused = true;
  }
  assertEquals(refused, true);
});

// ---------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------

Deno.test("the media request asks only for the fields this login documents", async () => {
  const { provider, urls } = providerWith(() => jsonResponse({ data: [] }));

  await provider.fetchMediaWindow({
    igUserId: "1784140001",
    token: "the-token",
    windowStart: "2026-07-30",
    windowEnd: "2026-10-28",
    cursor: null,
    maxPages: 1,
    signal: new AbortController().signal,
  });

  const url = urls[0]!;
  assertStringIncludes(url, "fields=");
  // The documented Instagram-login fields are asked for.
  assertStringIncludes(decodeURIComponent(url), "media_type");
  assertStringIncludes(decodeURIComponent(url), "timestamp");
  assertStringIncludes(decodeURIComponent(url), "permalink");
  assertStringIncludes(decodeURIComponent(url), "thumbnail_url");
  assertStringIncludes(decodeURIComponent(url), "like_count");
  assertStringIncludes(decodeURIComponent(url), "comments_count");
  // The two Facebook-login-only fields are NOT asked for.
  assertEquals(decodeURIComponent(url).includes("caption"), false);
  assertEquals(decodeURIComponent(url).includes("media_product_type"), false);
});

Deno.test("a media row of this login carries no caption and no surface", async () => {
  const { provider } = providerWith(() =>
    jsonResponse({
      data: [{
        id: "media-1",
        media_type: "VIDEO",
        timestamp: "2026-10-20T12:00:00Z",
        permalink: "https://instagram.com/p/1",
        like_count: 55,
        comments_count: 3,
      }],
    })
  );

  const sweep = await provider.fetchMediaWindow({
    igUserId: "1784140001",
    token: "the-token",
    windowStart: "2026-07-30",
    windowEnd: "2026-10-28",
    cursor: null,
    maxPages: 1,
    signal: new AbortController().signal,
  });

  const item = sweep.value.items[0]!;
  assertEquals(item.ig_media_id, "media-1");
  assertEquals(item.media_type, "VIDEO");
  assertEquals(item.media_product_type, null);
  assertEquals(item.caption, null);
  assertEquals(item.like_count_public, 55);
  assertEquals(item.comments_count_public, 3);
});

// ---------------------------------------------------------------------------
// The account day
// ---------------------------------------------------------------------------

Deno.test("the account day is the documented total_value request", async () => {
  const { provider, urls } = providerWith(() =>
    jsonResponse(accountDayAnswer({ reach: 450, views: 890 }))
  );

  const answer = await provider.fetchAccountDay({
    igUserId: "1784140001",
    token: "the-token",
    date: "2026-10-27",
    signal: new AbortController().signal,
  });

  const url = urls[0]!;
  assertStringIncludes(url, "metric_type=total_value");
  assertStringIncludes(url, "period=day");
  assertStringIncludes(url, "since=");
  assertStringIncludes(url, "until=");
  assertStringIncludes(decodeURIComponent(url), "accounts_engaged");
  assertStringIncludes(decodeURIComponent(url), "total_interactions");

  assertEquals(answer.value.metrics, { reach: 450, views: 890 });
  assertEquals(answer.value.provider_date, "2026-10-27");
  assertEquals(answer.value.metric_date, "2026-10-27");
  assertEquals(answer.value.query_kind, "interactions");
});

Deno.test("a metric the provider did not report stays null", async () => {
  const { provider } = providerWith(() =>
    jsonResponse(accountDayAnswer({ reach: 450 }))
  );

  const answer = await provider.fetchAccountDay({
    igUserId: "1784140001",
    token: "the-token",
    date: "2026-10-27",
    signal: new AbortController().signal,
  });

  assertEquals(answer.value.metrics, { reach: 450 });
  assertEquals("views" in answer.value.metrics, false);
});

// ---------------------------------------------------------------------------
// The media insights
// ---------------------------------------------------------------------------

Deno.test("the media insights are read from the documented values shape", async () => {
  const { provider, urls } = providerWith(() =>
    jsonResponse(mediaInsightAnswer({ views: 200, reach: 100 }))
  );

  const answer = await provider.fetchMediaInsights({
    igMediaId: "media-1",
    token: "the-token",
    mediaProductType: null,
    mediaType: "VIDEO",
    signal: new AbortController().signal,
  });

  assertEquals(answer.value.metrics, { views: 200, reach: 100 });
  assertStringIncludes(urls[0]!, "/media-1/insights");
});

Deno.test("the media insights ask only for the metrics every surface has", async () => {
  const { provider, urls } = providerWith(() =>
    jsonResponse(mediaInsightAnswer({ views: 200 }))
  );

  await provider.fetchMediaInsights({
    igMediaId: "media-1",
    token: "the-token",
    mediaProductType: null,
    mediaType: "VIDEO",
    signal: new AbortController().signal,
  });

  const metric = decodeURIComponent(urls[0]!);
  assertStringIncludes(metric, "views");
  assertStringIncludes(metric, "reach");
  assertStringIncludes(metric, "shares");
  assertStringIncludes(metric, "total_interactions");
  // The Facebook-login-only and the surface-specific metrics are not asked
  // for, because the surface cannot be named with this login.
  assertEquals(metric.includes("follows"), false);
  assertEquals(metric.includes("profile_visits"), false);
  assertEquals(metric.includes("ig_reels_avg_watch_time"), false);
});

/**
 * An ALBUM has insights.
 *
 * The media insights reference says, under "Album metrics": "Insights data
 * is not available for any media WITHIN an Instagram Media album"
 * (https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights).
 *
 * The sentence is about the CHILDREN of an album. The album itself is a
 * FEED media, and this login asks with the documented intersection for every
 * media - an album included.
 */
Deno.test("an album media is asked with the documented intersection", () => {
  assertEquals(directMediaInsightMetrics().length, 4);
  assertEquals(directMediaInsightMetrics().includes("views"), true);
  assertEquals(directMediaInsightMetrics().includes("reach"), true);
  assertEquals(directMediaInsightMetrics().includes("shares"), true);
  assertEquals(directMediaInsightMetrics().includes("total_interactions"), true);
});

Deno.test("an album media is asked about, and the answer is read", async () => {
  const { provider, urls } = providerWith(() =>
    jsonResponse(mediaInsightAnswer({ views: 200, reach: 100 }))
  );

  const answer = await provider.fetchMediaInsights({
    igMediaId: "media-1",
    token: "the-token",
    mediaProductType: null,
    mediaType: "CAROUSEL_ALBUM",
    signal: new AbortController().signal,
  });

  assertEquals(urls.length, 1);
  assertStringIncludes(urls[0]!, "/media-1/insights");
  assertEquals(answer.value.metrics, { views: 200, reach: 100 });
});

// ---------------------------------------------------------------------------
// The pagination
// ---------------------------------------------------------------------------

Deno.test("a page without a next URL is the last page", async () => {
  const { provider, urls } = providerWith(() =>
    jsonResponse({
      data: [{ id: "m1", media_type: "IMAGE", timestamp: "2026-10-20T12:00:00Z" }],
      paging: { cursors: { after: "cursor-1" } },
    })
  );

  const sweep = await provider.fetchMediaWindow({
    igUserId: "1784140001",
    token: "the-token",
    windowStart: "2026-07-30",
    windowEnd: "2026-10-28",
    cursor: null,
    maxPages: 2,
    signal: new AbortController().signal,
  });

  assertEquals(urls.length, 1);
  assertEquals(sweep.value.windowCovered, true);
  assertEquals(sweep.value.truncated, false);
  assertEquals(sweep.value.stopped, "feed_exhausted");
});

Deno.test("the next page is requested on the trusted host with a rebuilt cursor", async () => {
  const { provider, urls } = providerWith(() =>
    jsonResponse({
      data: [{ id: "m1", media_type: "IMAGE", timestamp: "2026-10-20T12:00:00Z" }],
      paging: {
        cursors: { after: "cursor-1" },
        next: "https://evil.example.com/steal?access_token=secret",
      },
    })
  );

  await provider.fetchMediaWindow({
    igUserId: "1784140001",
    token: "the-token",
    windowStart: "2026-07-30",
    windowEnd: "2026-10-28",
    cursor: null,
    maxPages: 2,
    signal: new AbortController().signal,
  });

  assertEquals(urls.length, 2);
  for (const url of urls) {
    assert(url.startsWith("https://graph.instagram.com/"));
    assertEquals(url.includes("evil.example.com"), false);
  }
  assertStringIncludes(urls[1]!, "after=cursor-1");
});

// ---------------------------------------------------------------------------
// The throttle bucket
// ---------------------------------------------------------------------------

Deno.test("the bucket key is a digest of the app, the account and the generation", async () => {
  const provider = new InstagramDirectGraphProvider({ appId: "the-app" });
  const key = await provider.bucketKey("the-social-account", 7);

  assertEquals(key.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(key), true);
  assertEquals(key.includes("the-app"), false);
  assertEquals(key.includes("the-social-account"), false);
  assertEquals(key.includes("instagram-login"), false);

  // A different app, a different account and a different generation are
  // different buckets. A direct account has no Facebook credential id, so
  // the generation is part of its identity.
  const other = new InstagramDirectGraphProvider({ appId: "another-app" });
  assertEquals(await other.bucketKey("the-social-account", 7) === key, false);
  assertEquals(await provider.bucketKey("another-account", 7) === key, false);
  assertEquals(await provider.bucketKey("the-social-account", 8) === key, false);
});

// ---------------------------------------------------------------------------
// The app namespace
// ---------------------------------------------------------------------------

Deno.test("the direct namespace is read from the Instagram app id and from nothing else", () => {
  // The reader answers for EVERY name, so the test proves which name is
  // asked for: the Instagram-login app, never the Facebook-login app.
  const asked: string[] = [];
  const appId = resolveDirectAppId((name) => {
    asked.push(name);
    return name === "INSTAGRAM_APP_ID" ? "the-instagram-app" : "the-facebook-app";
  });

  assertEquals(appId, "the-instagram-app");
  assertEquals(asked.includes("FACEBOOK_APP_ID"), false);
  assertEquals(asked.length, 1);
});

Deno.test("an unconfigured Instagram app id keeps a stable namespace and never the Facebook one", () => {
  // A missing or empty value is a missing value: the namespace falls back to
  // the documented unconfigured one, NEVER to the Facebook app id.
  assertEquals(resolveDirectAppId(() => undefined), null);
  assertEquals(resolveDirectAppId(() => ""), null);
  assertEquals(resolveDirectAppId(() => "   "), null);

  // The Facebook app id is set and the Instagram one is not: the direct
  // namespace still does not borrow it.
  assertEquals(
    resolveDirectAppId((name) => (name === "INSTAGRAM_APP_ID" ? undefined : "the-facebook-app")),
    null,
  );
});

Deno.test("the unconfigured direct bucket is stable and is not the Facebook bucket", async () => {
  const provider = new InstagramDirectGraphProvider({ appId: null });
  const key = await provider.bucketKey("the-social-account", 7);

  // The documented namespace is stable: the same inputs always name the same
  // bucket, so an unconfigured deployment keeps ONE bucket.
  assertEquals(
    key,
    await sha256Hex(
      `instagram-login:${UNCONFIGURED_DIRECT_APP_NAMESPACE}:the-social-account:7`,
    ),
  );
  assertEquals(
    await provider.bucketKey("the-social-account", 7) === key,
    true,
  );

  // It is not the Facebook-login bucket: the two logins are metered
  // separately, so the direct namespace never carries the Facebook app id.
  const facebook = await sha256Hex(
    `instagram_owner:the-app:the-social-account:7`,
  );
  assertEquals(key === facebook, false);
});

Deno.test("the composition root builds the direct provider from the Instagram app id", async () => {
  // The composition root is not importable (it serves the route), so the
  // wiring is checked where the finding was: the direct provider must not be
  // built from the Facebook app id.
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

  const directFactory = factorySource(source, "createDirectGraphProvider");
  assert(directFactory.includes("resolveDirectAppId"));
  assertEquals(directFactory.includes("FACEBOOK_APP_ID"), false);

  // The Facebook provider keeps the Facebook app id.
  const facebookFactory = factorySource(source, "createGraphProvider");
  assert(facebookFactory.includes("FACEBOOK_APP_ID"));
});

/** The source of one factory of the composition root. */
function factorySource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} is not in the composition root`);
  const end = source.indexOf("\n}", start);
  assert(end > start, `${name} is not a closed function`);
  return source.slice(start, end);
}
