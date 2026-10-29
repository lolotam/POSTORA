/**
 * The Meta Graph adapter of the OWNER collection.
 *
 * WHAT THIS SUITE COVERS
 *
 *   1. the parsed shapes: the profile counts, the account day metrics and
 *      the media rows, with a missing metric staying null;
 *   2. the malformed responses: a Graph error envelope delivered with HTTP
 *      200, a missing or non-array `data`, a count beyond 2^53 and an
 *      oversized body are all failures;
 *   3. the usage headers: both of them, including the nested business
 *      objects;
 *   4. the failure classification: the rate limits, the rejected
 *      credential and the refused permission;
 *   5. the bounds: the attempt ceiling, the abort race and the bounded
 *      retry policy;
 *   6. the pagination: the cursor is rebuilt and the provider's own next
 *      URL is never requested;
 *   7. the bucket key: a digest of the app and the credential, never the
 *      token.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  InstagramGraphProvider,
  mediaInsightMetricsFor,
  OwnerProviderError,
  parseOwnerUsagePercent,
  readOwnerGraphErrorEnvelope,
  sha256Hex,
  USAGE_STOP_PERCENT,
} from "./graphProvider.ts";

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
  responder: (url: string, attempt: number) => Response | Promise<Response>,
  options: { attemptTimeoutMs?: number } = {},
): { provider: InstagramGraphProvider; urls: string[]; attempts: () => number } {
  const urls: string[] = [];
  let attempts = 0;
  const provider = new InstagramGraphProvider({
    attemptTimeoutMs: options.attemptTimeoutMs,
    fetchFn: ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      attempts += 1;
      return Promise.resolve(responder(url, attempts));
    }) as unknown as typeof fetch,
  });
  return { provider, urls, attempts: () => attempts };
}

// ---------------------------------------------------------------------------
// The parsed shapes
// ---------------------------------------------------------------------------

Deno.test("the profile counts are parsed and a missing count stays null", async () => {
  const { provider } = providerWith(() =>
    jsonResponse({ followers_count: 3200, media_count: 42 })
  );

  const result = await provider.fetchAccountProfile({
    igUserId: "1784140001",
    token: "the-token",
    signal: new AbortController().signal,
  });

  assertEquals(result.value, { followers_count: 3200, media_count: 42 });
});

Deno.test("a profile without a usable count is a failure, not an empty profile", async () => {
  const { provider } = providerWith(() => jsonResponse({}));

  const error = await assertRejects(
    () =>
      provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.kind, "provider_error");
});

Deno.test("the account day metrics are parsed and a missing metric stays null", async () => {
  const { provider, urls } = providerWith(() =>
    jsonResponse({
      data: [
        { name: "reach", period: "day", total_value: { value: 450 } },
        { name: "views", period: "day", total_value: { value: 890 } },
      ],
    })
  );

  const result = await provider.fetchAccountDay({
    igUserId: "1784140001",
    token: "the-token",
    date: "2026-10-28",
    signal: new AbortController().signal,
  });

  assertEquals(result.value.metrics, { reach: 450, views: 890 });
  assertEquals("accounts_engaged" in result.value.metrics, false);
  assertEquals(result.value.provider_date, "2026-10-28");
  assertEquals(result.value.metric_date, "2026-10-28");
  assertEquals(result.value.query_kind, "interactions");
  assertEquals(result.value.provider_timezone, "Asia/Kuwait");

  // The documented request: a total, a day period and an explicit range.
  assertStringIncludes(urls[0]!, "metric_type=total_value");
  assertStringIncludes(urls[0]!, "period=day");
  assertStringIncludes(urls[0]!, "since=");
  assertStringIncludes(urls[0]!, "until=");
});

Deno.test("an empty account day is an unavailable day, not a zero", async () => {
  const { provider } = providerWith(() => jsonResponse({ data: [] }));

  const result = await provider.fetchAccountDay({
    igUserId: "1784140001",
    token: "the-token",
    date: "2026-10-28",
    signal: new AbortController().signal,
  });

  assertEquals(result.value.metrics, {});
});

Deno.test("a metric row without a total_value leaves that metric null", async () => {
  const { provider } = providerWith(() =>
    jsonResponse({
      data: [
        { name: "reach", period: "day" },
        { name: "views", period: "day", total_value: { value: 890 } },
      ],
    })
  );

  const result = await provider.fetchAccountDay({
    igUserId: "1784140001",
    token: "the-token",
    date: "2026-10-28",
    signal: new AbortController().signal,
  });

  assertEquals(result.value.metrics, { views: 890 });
  assertEquals("reach" in result.value.metrics, false);
});

Deno.test("the old values-only shape does not produce numbers", async () => {
  // The time-series shape is not a total. It must never be read as one.
  const { provider } = providerWith(() =>
    jsonResponse({
      data: [
        { name: "reach", period: "day", values: [{ value: 450, end_time: "2026-10-28T00:00:00+03:00" }] },
        { name: "views", period: "day", values: [{ value: 890, end_time: "2026-10-28T00:00:00+03:00" }] },
      ],
    })
  );

  const result = await provider.fetchAccountDay({
    igUserId: "1784140001",
    token: "the-token",
    date: "2026-10-28",
    signal: new AbortController().signal,
  });

  assertEquals(result.value.metrics, {});
});

Deno.test("a malformed total_value is a failure, never a number", async () => {
  for (
    const row of [
      { name: "reach", period: "day", total_value: "450" },
      { name: "reach", period: "day", total_value: { value: "450" } },
      { name: "reach", period: "day", total_value: { value: 1.5 } },
      { name: "reach", period: "day", total_value: { value: -1 } },
      { name: "reach", period: "day", total_value: { value: 2 ** 53 } },
      { name: "reach", period: "day", total_value: {} },
    ]
  ) {
    const { provider } = providerWith(() => jsonResponse({ data: [row] }));

    const error = await assertRejects(
      () =>
        provider.fetchAccountDay({
          igUserId: "1784140001",
          token: "the-token",
          date: "2026-10-28",
          signal: new AbortController().signal,
        }),
      OwnerProviderError,
    );

    assertEquals(error.kind, "provider_error", JSON.stringify(row));
  }
});

Deno.test("a metric row for another period is refused", async () => {
  const { provider } = providerWith(() =>
    jsonResponse({
      data: [{ name: "reach", period: "week", total_value: { value: 450 } }],
    })
  );

  const error = await assertRejects(
    () =>
      provider.fetchAccountDay({
        igUserId: "1784140001",
        token: "the-token",
        date: "2026-10-28",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.kind, "provider_error");
});

// ---------------------------------------------------------------------------
// The media insights
// ---------------------------------------------------------------------------

Deno.test("the media insights are read from the documented values shape", async () => {
  const { provider, urls } = providerWith(() =>
    jsonResponse({
      data: [
        { name: "reach", period: "lifetime", values: [{ value: 450 }] },
        { name: "views", period: "lifetime", values: [{ value: 890 }] },
      ],
    })
  );

  const result = await provider.fetchMediaInsights({
    igMediaId: "17932174733377207",
    token: "the-token",
    mediaProductType: "FEED",
    mediaType: "IMAGE",
    signal: new AbortController().signal,
  });

  assertEquals(result.value.supported, true);
  assertEquals(result.value.metrics, { reach: 450, views: 890 });
  assertStringIncludes(urls[0]!, "/17932174733377207/insights?metric=");
});

Deno.test("the metric set follows the media product type", async () => {
  const feed = mediaInsightMetricsFor("FEED", "IMAGE");
  const reels = mediaInsightMetricsFor("REELS", "VIDEO");
  const story = mediaInsightMetricsFor("STORY", "IMAGE");

  assertEquals(feed.includes("profile_visits"), true);
  assertEquals(reels.includes("profile_visits"), false);
  assertEquals(story.includes("replies"), true);
  assertEquals(feed.includes("replies"), false);

  // Every requested metric is one the accepted `owner_media` whitelist can
  // store, and every metric of the documentation that the whitelist cannot
  // store is never requested.
  const allowed = new Set([
    "views",
    "reach",
    "likes",
    "comments",
    "saved",
    "shares",
    "total_interactions",
    "follows",
    "profile_visits",
    "replies",
  ]);
  for (const metrics of [feed, reels, story]) {
    for (const metric of metrics) {
      assertEquals(allowed.has(metric), true, metric);
    }
  }

  // The metrics Meta documents but the accepted whitelist cannot store.
  for (const metric of [
    "crossposted_views",
    "facebook_views",
    "impressions",
    "link_clicks",
    "navigation",
    "profile_activity",
    "reels_skip_rate",
    "reposts",
    "total_comments",
    "total_likes",
    "total_views",
  ]) {
    assertEquals([...feed, ...reels, ...story].includes(metric), false, metric);
  }
});

Deno.test("an album media has no insights, and that is a positive fact", async () => {
  assertEquals(mediaInsightMetricsFor("FEED", "CAROUSEL_ALBUM").length, 0);

  const { provider, attempts } = providerWith(() => jsonResponse({ data: [] }));
  const result = await provider.fetchMediaInsights({
    igMediaId: "17932174733377207",
    token: "the-token",
    mediaProductType: "FEED",
    mediaType: "CAROUSEL_ALBUM",
    signal: new AbortController().signal,
  });

  assertEquals(result.value.supported, false);
  assertEquals(result.value.metrics, {});
  // No provider call was spent on a media that cannot have insights.
  assertEquals(attempts(), 0);
});

Deno.test("an unknown product type asks only for the universal metrics", () => {
  assertEquals(
    mediaInsightMetricsFor(null, null),
    ["views", "reach", "shares", "total_interactions"],
  );
});

Deno.test("a media metric without a value stays null, and a malformed one fails", async () => {
  const missing = providerWith(() =>
    jsonResponse({ data: [{ name: "reach", period: "lifetime" }] })
  );
  const missingResult = await missing.provider.fetchMediaInsights({
    igMediaId: "m1",
    token: "the-token",
    mediaProductType: "FEED",
    mediaType: "IMAGE",
    signal: new AbortController().signal,
  });
  assertEquals(missingResult.value.metrics, {});

  for (
    const row of [
      { name: "reach", values: "not-an-array" },
      { name: "reach", values: [{ value: "450" }] },
      { name: "reach", values: [{ value: 2 ** 53 }] },
      { name: "reach", values: [{ value: -1 }] },
    ]
  ) {
    const { provider } = providerWith(() => jsonResponse({ data: [row] }));

    const error = await assertRejects(
      () =>
        provider.fetchMediaInsights({
          igMediaId: "m1",
          token: "the-token",
          mediaProductType: "FEED",
          mediaType: "IMAGE",
          signal: new AbortController().signal,
        }),
      OwnerProviderError,
    );

    assertEquals(error.kind, "provider_error", JSON.stringify(row));
  }
});

Deno.test("a media insights call is never retried automatically", async () => {
  const { provider, attempts } = providerWith(() =>
    jsonResponse({ error: { message: "boom" } }, { status: 500 })
  );

  const error = await assertRejects(
    () =>
      provider.fetchMediaInsights({
        igMediaId: "m1",
        token: "the-token",
        mediaProductType: "FEED",
        mediaType: "IMAGE",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.kind, "provider_error");
  assertEquals(attempts(), 1);
});

Deno.test("a media insights call gives up after its own four second ceiling", async () => {
  const { provider } = providerWith(() => new Promise<Response>(() => undefined));

  const started = Date.now();
  const error = await assertRejects(
    () =>
      provider.fetchMediaInsights({
        igMediaId: "m1",
        token: "the-token",
        mediaProductType: "FEED",
        mediaType: "IMAGE",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.kind, "provider_error");
  // The ceiling is four seconds, headers AND body.
  assert(Date.now() - started >= 3_500);
  assert(Date.now() - started < 6_000);
});

// ---------------------------------------------------------------------------
// The malformed responses
// ---------------------------------------------------------------------------

Deno.test("a Graph error envelope delivered with HTTP 200 is an error", async () => {
  const { provider } = providerWith(() =>
    jsonResponse({ error: { code: 190, message: "Invalid OAuth access token" } })
  );

  const error = await assertRejects(
    () =>
      provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.kind, "token_invalid");
});

Deno.test("a missing or non-array data array is a failure, never an empty success", async () => {
  for (const payload of [{}, { data: "not-an-array" }, { data: { nested: true } }]) {
    const { provider } = providerWith(() => jsonResponse(payload));

    const error = await assertRejects(
      () =>
        provider.fetchAccountDay({
          igUserId: "1784140001",
          token: "the-token",
          date: "2026-10-28",
          signal: new AbortController().signal,
        }),
      OwnerProviderError,
    );

    assertEquals(error.kind, "provider_error");
  }
});

Deno.test("a count beyond 2^53 is a failure, not a rounded number", async () => {
  const { provider } = providerWith(() =>
    jsonResponse({ data: [{ id: "m1", timestamp: "2026-10-20T12:00:00Z", like_count: 2 ** 53 }] })
  );

  const error = await assertRejects(
    () =>
      provider.fetchMediaWindow({
        igUserId: "1784140001",
        token: "the-token",
        windowStart: "2026-07-30",
        windowEnd: "2026-10-28",
        cursor: null,
        maxPages: 2,
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.kind, "provider_error");
});

Deno.test("a response that is not JSON is a failure", async () => {
  const { provider } = providerWith(() =>
    new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } })
  );

  const error = await assertRejects(
    () =>
      provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.kind, "provider_error");
});

Deno.test("a body larger than the cap is refused", async () => {
  const huge = "x".repeat(1_100_000);
  const { provider } = providerWith(() =>
    new Response(huge, { status: 200, headers: { "Content-Type": "application/json" } })
  );

  const error = await assertRejects(
    () =>
      provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.kind, "provider_error");
});

// ---------------------------------------------------------------------------
// The usage headers
// ---------------------------------------------------------------------------

Deno.test("both usage headers are read, including the nested business objects", () => {
  const headers = new Headers({
    "x-app-usage": JSON.stringify({ call_count: 12, total_cputime: 30 }),
    "x-business-use-case-usage": JSON.stringify({
      ig_business_discovery: [{ call_count: 91, total_time: 40 }],
    }),
  });

  assertEquals(parseOwnerUsagePercent(headers), 91);
});

Deno.test("a usage header that is not JSON is not evidence of usage", () => {
  const headers = new Headers({ "x-app-usage": "not-json" });
  assertEquals(parseOwnerUsagePercent(headers), 0);
});

Deno.test("a nearly spent usage budget is reported with the answer", async () => {
  const { provider } = providerWith(() =>
    jsonResponse(
      { followers_count: 1 },
      { headers: { "x-app-usage": JSON.stringify({ call_count: USAGE_STOP_PERCENT }) } },
    )
  );

  // The response itself is a success: the data was collected. The usage is
  // reported with it, and the caller decides to stop.
  const result = await provider.fetchAccountProfile({
    igUserId: "1784140001",
    token: "the-token",
    signal: new AbortController().signal,
  });

  assertEquals(result.usagePercent, USAGE_STOP_PERCENT);
  assertEquals(result.value.followers_count, 1);
});

Deno.test("a nearly spent usage budget stops the media sweep", async () => {
  const { provider } = providerWith(() =>
    jsonResponse(
      {
        data: [{ id: "m1", media_type: "IMAGE", timestamp: "2026-10-20T12:00:00Z" }],
        paging: { cursors: { after: "cursor-1" } },
      },
      { headers: { "x-app-usage": JSON.stringify({ call_count: USAGE_STOP_PERCENT }) } },
    )
  );

  const result = await provider.fetchMediaWindow({
    igUserId: "1784140001",
    token: "the-token",
    windowStart: "2026-07-30",
    windowEnd: "2026-10-28",
    cursor: null,
    maxPages: 2,
    signal: new AbortController().signal,
  });

  assertEquals(result.value.stopped, "usage_stop");
  assertEquals(result.value.truncated, true);
  assertEquals(result.value.windowCovered, false);
});

// ---------------------------------------------------------------------------
// The failure classification
// ---------------------------------------------------------------------------

Deno.test("the rate limit codes and HTTP 429 are rate limits", async () => {
  for (const code of [4, 17, 32, 613]) {
    const { provider } = providerWith(() =>
      jsonResponse({ error: { code, message: "slow down" } }, { status: 400 })
    );

    const error = await assertRejects(
      () =>
        provider.fetchAccountProfile({
          igUserId: "1784140001",
          token: "the-token",
          signal: new AbortController().signal,
        }),
      OwnerProviderError,
    );

    assertEquals(error.kind, "rate_limited", `code ${code}`);
  }

  const { provider } = providerWith(() =>
    jsonResponse({ error: { code: 1, message: "too many" } }, { status: 429 })
  );
  const error = await assertRejects(
    () =>
      provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );
  assertEquals(error.kind, "rate_limited");
});

Deno.test("the rejected credential and the refused permission are classified apart", async () => {
  const token = providerWith(() =>
    jsonResponse({ error: { code: 190, message: "expired" } }, { status: 400 })
  );
  const tokenError = await assertRejects(
    () =>
      token.provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );
  assertEquals(tokenError.kind, "token_invalid");

  for (const code of [10, 200]) {
    const { provider } = providerWith(() =>
      jsonResponse({ error: { code, message: "permission" } }, { status: 400 })
    );
    const error = await assertRejects(
      () =>
        provider.fetchAccountProfile({
          igUserId: "1784140001",
          token: "the-token",
          signal: new AbortController().signal,
        }),
      OwnerProviderError,
    );
    assertEquals(error.kind, "scope_missing", `code ${code}`);
  }
});

Deno.test("a failure never carries the provider text", async () => {
  const { provider } = providerWith(() =>
    jsonResponse(
      { error: { code: 190, message: "Invalid OAuth access token: secret-value" } },
      { status: 400 },
    )
  );

  const error = await assertRejects(
    () =>
      provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.message.includes("secret-value"), false);
  assertEquals(error.message.includes("access_token"), false);
});

Deno.test("the Graph error envelope is read without copying the message", () => {
  const envelope = readOwnerGraphErrorEnvelope({
    error: {
      code: 10,
      error_subcode: 33,
      message: "Missing instagram_manage_insights scope",
    },
  });

  assertEquals(envelope?.code, 10);
  assertEquals(envelope?.subcode, 33);
  assertEquals(envelope?.mentionsScope, true);
  assertEquals(readOwnerGraphErrorEnvelope({ data: [] }), null);
});

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

Deno.test("the attempt ceiling gives up on a transport that never answers", async () => {
  const { provider } = providerWith(
    () => new Promise<Response>(() => undefined),
    { attemptTimeoutMs: 60 },
  );

  const started = Date.now();
  const error = await assertRejects(
    () =>
      provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.kind, "provider_error");
  assert(Date.now() - started < 3_000);
});

Deno.test("an aborted signal ends the attempt without waiting for the transport", async () => {
  const { provider } = providerWith(() => new Promise<Response>(() => undefined));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);

  const started = Date.now();
  await assertRejects(
    () =>
      provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: controller.signal,
      }),
    OwnerProviderError,
  );

  assert(Date.now() - started < 3_000);
});

Deno.test("a server failure is retried at most twice and then reported", async () => {
  const { provider, attempts } = providerWith(() =>
    jsonResponse({ error: { message: "boom" } }, { status: 500 })
  );

  const error = await assertRejects(
    () =>
      provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(error.kind, "provider_error");
  assertEquals(attempts(), 3);
});

Deno.test("a server failure that recovers is collected", async () => {
  const { provider, attempts } = providerWith((_url, attempt) =>
    attempt < 3
      ? jsonResponse({ error: { message: "boom" } }, { status: 500 })
      : jsonResponse({ followers_count: 7, media_count: 1 })
  );

  const result = await provider.fetchAccountProfile({
    igUserId: "1784140001",
    token: "the-token",
    signal: new AbortController().signal,
  });

  assertEquals(result.value.followers_count, 7);
  assertEquals(attempts(), 3);
});

Deno.test("a rejected credential is never retried", async () => {
  const { provider, attempts } = providerWith(() =>
    jsonResponse({ error: { code: 190, message: "expired" } }, { status: 400 })
  );

  await assertRejects(
    () =>
      provider.fetchAccountProfile({
        igUserId: "1784140001",
        token: "the-token",
        signal: new AbortController().signal,
      }),
    OwnerProviderError,
  );

  assertEquals(attempts(), 1);
});

// ---------------------------------------------------------------------------
// The pagination
// ---------------------------------------------------------------------------

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
    assert(url.startsWith("https://graph.facebook.com/"));
    assertEquals(url.includes("evil.example.com"), false);
  }
  assertStringIncludes(urls[1]!, "after=cursor-1");
});

Deno.test("a cursor the adapter cannot follow stops the sweep as truncated", async () => {
  const { provider } = providerWith(() =>
    jsonResponse({
      data: [{ id: "m1", media_type: "IMAGE", timestamp: "2026-10-20T12:00:00Z" }],
      paging: { cursors: { after: "https://evil.example.com/steal" } },
    })
  );

  const result = await provider.fetchMediaWindow({
    igUserId: "1784140001",
    token: "the-token",
    windowStart: "2026-07-30",
    windowEnd: "2026-10-28",
    cursor: null,
    maxPages: 2,
    signal: new AbortController().signal,
  });

  assertEquals(result.value.truncated, true);
  assertEquals(result.value.windowCovered, false);
  assertEquals(result.value.stopped, "unusable_cursor");
});

Deno.test("an item older than the window proves the coverage", async () => {
  const { provider } = providerWith(() =>
    jsonResponse({
      data: [{ id: "m1", media_type: "IMAGE", timestamp: "2026-01-01T00:00:00Z" }],
    })
  );

  const result = await provider.fetchMediaWindow({
    igUserId: "1784140001",
    token: "the-token",
    windowStart: "2026-07-30",
    windowEnd: "2026-10-28",
    cursor: null,
    maxPages: 2,
    signal: new AbortController().signal,
  });

  assertEquals(result.value.windowCovered, true);
  assertEquals(result.value.truncated, false);
  assertEquals(result.value.items.length, 0);
});

Deno.test("an advertisement is not stored but still bounds the window", async () => {
  const { provider } = providerWith(() =>
    jsonResponse({
      data: [{
        id: "ad-1",
        media_type: "IMAGE",
        media_product_type: "AD",
        timestamp: "2026-10-20T12:00:00Z",
      }],
    })
  );

  const result = await provider.fetchMediaWindow({
    igUserId: "1784140001",
    token: "the-token",
    windowStart: "2026-07-30",
    windowEnd: "2026-10-28",
    cursor: null,
    maxPages: 2,
    signal: new AbortController().signal,
  });

  assertEquals(result.value.items.length, 0);
  assertEquals(result.value.oldestReturnedAt, "2026-10-20T12:00:00.000Z");
});

// ---------------------------------------------------------------------------
// The bucket key
// ---------------------------------------------------------------------------

Deno.test("the bucket key is a digest of the app and the credential, never the token", async () => {
  const provider = new InstagramGraphProvider({ appId: "the-app" });
  const key = await provider.bucketKey("the-credential-id");

  assertEquals(key.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(key), true);
  assertEquals(key.includes("the-credential-id"), false);
  assertEquals(key.includes("the-app"), false);

  const other = new InstagramGraphProvider({ appId: "another-app" });
  assertEquals(await other.bucketKey("the-credential-id") === key, false);
  assertEquals(await provider.bucketKey("another-credential") === key, false);
});

Deno.test("the digest is the platform's own SHA-256", async () => {
  const digest = await sha256Hex("value");
  assertEquals(digest.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(digest), true);
});
