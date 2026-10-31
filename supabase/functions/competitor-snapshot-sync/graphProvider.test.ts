/**
 * The Graph adapter's contract.
 *
 * WHAT THIS SUITE PINS
 *
 *   The request shape, the response validation, the usage-header reading,
 *   the bounded retry policy and the failure classification.
 *
 * THE TWO ASSERTIONS THAT CHANGED
 *
 *   The supplied draft asserted two things that were wrong, and both are
 *   corrected here rather than preserved:
 *
 *     1. It asserted that a Graph error with code 100 and subcode 33 means
 *        "the target does not exist". Meta's own message for that code
 *        names three causes, one of which is the VIEWER's permissions.
 *        The verdict "this target is unavailable, retry it in a week" is
 *        therefore NOT supported by that fixture. It is now asserted to be
 *        a retryable provider failure.
 *
 *     2. It asserted that the request used `business_discovery.fields(...)`
 *        with a separate `username` query parameter. The documented
 *        expansion is `business_discovery.username(<target>){...}`. That is
 *        request grammar only: the documented RESPONSE carries the target's
 *        fields directly on `business_discovery`. Both shapes are asserted.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  GraphCompetitorProvider,
  normalizeCompetitorHandle,
  parseUsagePercent,
  resolveGraphApiVersion,
} from "./graphProvider.ts";
import { CompetitorProviderError, CompetitorProviderPermitError } from "./types.ts";

const VIEWER = "viewer_ig_123";
const TOKEN = "EAAB_secret_token";

function targetPayload(
  overrides: Record<string, unknown> = {},
  mediaRows: unknown[] = [],
): Record<string, unknown> {
  // The documented response: the target's fields sit DIRECTLY on
  // `business_discovery`; `username` there is a plain string field.
  return {
    business_discovery: {
      id: "1784140001",
      username: "competitor_brand",
      name: "Competitor Brand",
      followers_count: 54200,
      media_count: 120,
      media: {
        data: mediaRows,
        paging: { cursors: { before: "BEFORE", after: "AFTER1" } },
      },
      ...overrides,
    },
    id: "viewer_ig_123",
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

Deno.test("the request uses the documented business_discovery.username expansion", async () => {
  const captured: string[] = [];

  const mockFetch = async (input: RequestInfo | URL) => {
    captured.push(String(input));
    return jsonResponse(targetPayload({}, []));
  };

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  await provider.fetch({
    username: "@competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
  });

  const url = new URL(captured[0]!);
  const fields = url.searchParams.get("fields") ?? "";

  assertEquals(url.origin, "https://graph.facebook.com");
  assertEquals(url.pathname, `/v22.0/${VIEWER}`);
  assertEquals(fields.includes("business_discovery.username(competitor_brand){"), true);
  assertEquals(fields.includes("business_discovery.fields("), false);
  assertEquals(fields.includes("media.limit(25){"), true);
  assertEquals(fields.includes("view_count"), true);
  assertEquals(fields.includes("media_product_type"), true);
  assertEquals(fields.includes("video_view_count"), false);
  assertEquals(url.searchParams.get("access_token"), TOKEN);
});

// ---------------------------------------------------------------------------
// The per-request admission permit
// ---------------------------------------------------------------------------

Deno.test("the permit is asked before every attempt, including every retry", async () => {
  let requests = 0;
  let permits = 0;

  const mockFetch = async () => {
    requests += 1;
    // The first attempt fails with a 500, so the retry policy runs.
    if (requests === 1) {
      return jsonResponse({}, { status: 500 });
    }
    return jsonResponse(targetPayload());
  };

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  await provider.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
    permit: async () => {
      permits += 1;
    },
  });

  // Every request that left the process asked for its own permit: the
  // retry of the 500 and the cursor request of the second page each asked
  // for their own.
  assertEquals(requests >= 2, true);
  assertEquals(permits, requests);
});

Deno.test("the permit is asked before every page, including the cursor request", async () => {
  const seen: string[] = [];
  let permits = 0;

  const mockFetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const fields = url.searchParams.get("fields") ?? "";
    seen.push(fields);

    if (fields.includes("after(AFTER1)")) {
      return jsonResponse(targetPayload({}, [{
        id: "media_2",
        media_type: "IMAGE",
        media_product_type: "FEED",
        timestamp: "2026-10-27T10:00:00Z",
      }]));
    }

    return jsonResponse(targetPayload());
  };

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  await provider.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
    permit: async () => {
      permits += 1;
    },
  });

  // Two pages were requested, and each of them asked for its own permit.
  assertEquals(seen.length, 2);
  assertEquals(permits, 2);
});

Deno.test("a refused permit stops the request before it is sent", async () => {
  let requests = 0;

  const mockFetch = async () => {
    requests += 1;
    return jsonResponse(targetPayload());
  };

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });

  let threw = false;
  try {
    await provider.fetch({
      username: "competitor_brand",
      viewerIgUserId: VIEWER,
      token: TOKEN,
      signal: new AbortController().signal,
      permit: async () => {
        throw new CompetitorProviderPermitError("refused", "collection_not_eligible");
      },
    });
  } catch (error) {
    threw = error instanceof CompetitorProviderPermitError;
  }

  assertEquals(threw, true);
  // The first excluded request is never sent at all.
  assertEquals(requests, 0);
});

Deno.test("a permit that fails in another way is unavailable, never permission", async () => {
  let requests = 0;

  const mockFetch = async () => {
    requests += 1;
    return jsonResponse(targetPayload());
  };

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });

  let thrown: unknown = null;
  try {
    await provider.fetch({
      username: "competitor_brand",
      viewerIgUserId: VIEWER,
      token: TOKEN,
      signal: new AbortController().signal,
      permit: async () => {
        throw new Error("the gate did not answer");
      },
    });
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown instanceof CompetitorProviderPermitError, true);
  assertEquals(
    thrown instanceof CompetitorProviderPermitError &&
      (thrown as CompetitorProviderPermitError).kind === "unavailable",
    true,
  );
  assertEquals(requests, 0);
});

Deno.test("the cursor is rebuilt into a second request on the trusted host", async () => {
  const seen: string[] = [];

  const mockFetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.searchParams.get("fields") ?? "");
    const fields = url.searchParams.get("fields") ?? "";

    if (fields.includes("after(AFTER1)")) {
      return jsonResponse(
        targetPayload({}, [{
          id: "media_2",
          media_type: "IMAGE",
          media_product_type: "FEED",
          timestamp: "2026-10-27T10:00:00Z",
        }]),
      );
    }

    return jsonResponse(
      targetPayload({}, [{
        id: "media_1",
        media_type: "VIDEO",
        media_product_type: "REELS",
        timestamp: "2026-10-28T12:00:00Z",
        like_count: 1500,
        comments_count: 45,
        view_count: 12000,
      }]),
    );
  };

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const result = await provider.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
  });

  assertEquals(seen.length, 2);
  assertEquals(seen[1]!.includes("media.limit(25).after(AFTER1){"), true);
  assertEquals(result.capture.media.length, 2);
  assertEquals(result.capture.truncated, true);
});

Deno.test("a repeated cursor stops the pagination instead of looping", async () => {
  let calls = 0;

  const mockFetch = async () => {
    calls += 1;
    return jsonResponse(targetPayload({}, [{
      id: `media_${calls}`,
      media_type: "IMAGE",
      media_product_type: "FEED",
      timestamp: "2026-10-28T12:00:00Z",
    }]));
  };

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const result = await provider.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
  });

  assertEquals(calls, 2);
  assertEquals(result.capture.media.length, 2);
  assertEquals(result.capture.truncated, true);
});

Deno.test("the target is read from the nested expansion", async () => {
  const mockFetch = async () =>
    jsonResponse(
      targetPayload({}, [{
        id: "media_101",
        media_type: "VIDEO",
        media_product_type: "REELS",
        timestamp: "2026-10-28T12:00:00Z",
        permalink: "https://instagram.com/p/abc",
        caption: "Reel caption",
        like_count: 1500,
        comments_count: 45,
        view_count: 12000,
      }]),
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const result = await provider.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
  });

  assertEquals(result.capture.source, "official");
  assertEquals(result.capture.profile.followers_count, 54200);
  assertEquals(result.capture.profile.media_count, 120);
  assertEquals(result.capture.media.length, 1);

  const media = result.capture.media[0]!;
  assertEquals(media.ig_media_id, "media_101");
  assertEquals(media.media_product_type, "REELS");
  assertEquals(media.media_type, "VIDEO");
  assertEquals(media.view_count, 12000);
  assertEquals(media.like_count, 1500);
  assertEquals(media.published_at, "2026-10-28T12:00:00.000Z");
});

Deno.test("a missing count is unavailable and never zero", async () => {
  const mockFetch = async () =>
    jsonResponse(
      targetPayload({}, [{
        id: "media_102",
        media_type: "IMAGE",
        media_product_type: "FEED",
        timestamp: "2026-10-27T10:00:00Z",
        comments_count: 10,
      }]),
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const result = await provider.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
  });

  const media = result.capture.media[0]!;
  assertEquals(media.like_count, null);
  assertEquals(media.view_count, null);
  assertEquals(media.comments_count, 10);
});

Deno.test("a negative count is unavailable, not negative", async () => {
  const mockFetch = async () =>
    jsonResponse(
      targetPayload({}, [{
        id: "media_103",
        media_type: "IMAGE",
        media_product_type: "FEED",
        timestamp: "2026-10-27T10:00:00Z",
        like_count: -1,
      }]),
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const result = await provider.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
  });

  assertEquals(result.capture.media[0]!.like_count, null);
});

Deno.test("a media row without a publication instant fails the capture", async () => {
  const mockFetch = async () =>
    jsonResponse(
      targetPayload({}, [{
        id: "media_104",
        media_type: "IMAGE",
        media_product_type: "FEED",
      }]),
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.kind, "provider_error");
});

Deno.test("a media row without an id fails the capture", async () => {
  const mockFetch = async () =>
    jsonResponse(
      targetPayload({}, [{
        media_type: "IMAGE",
        media_product_type: "FEED",
        timestamp: "2026-10-27T10:00:00Z",
      }]),
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.kind, "provider_error");
});

Deno.test("a malformed count fails the capture instead of becoming empty", async () => {
  const mockFetch = async () =>
    jsonResponse(
      targetPayload({}, [{
        id: "media_105",
        media_type: "IMAGE",
        media_product_type: "FEED",
        timestamp: "2026-10-27T10:00:00Z",
        like_count: "many",
      }]),
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.kind, "provider_error");
});

Deno.test("a missing or empty expansion is a malformed response, never the weekly verdict", async () => {
  // Meta documents no response or error that unambiguously means "this
  // target does not exist", so neither shape may park the competitor.
  for (const body of [{ business_discovery: null }, { id: "viewer_ig_123" }, { business_discovery: {} }]) {
    const provider = new GraphCompetitorProvider({
      fetchFn: (async () => jsonResponse(body)) as typeof fetch,
    });
    const error = await assertRejects(
      () =>
        provider.fetch({
          username: "competitor_brand",
          viewerIgUserId: VIEWER,
          token: TOKEN,
          signal: new AbortController().signal,
        }),
      CompetitorProviderError,
    );
    assertEquals(error.kind, "provider_error");
  }
});

Deno.test("a malformed media connection is not a successful empty capture", async () => {
  for (const media of [null, { data: null }, { data: {} }, "rows"]) {
    const provider = new GraphCompetitorProvider({
      fetchFn: (async () => jsonResponse(targetPayload({ media }))) as typeof fetch,
    });
    const error = await assertRejects(
      () =>
        provider.fetch({
          username: "competitor_brand",
          viewerIgUserId: VIEWER,
          token: TOKEN,
          signal: new AbortController().signal,
        }),
      CompetitorProviderError,
    );
    assertEquals(error.kind, "provider_error");
  }
});

Deno.test("only the provider's own zero media count proves an absent connection is empty", async () => {
  const empty = new GraphCompetitorProvider({
    fetchFn: (async () => jsonResponse(targetPayload({ media: undefined, media_count: 0 }))) as typeof fetch,
  });
  const result = await empty.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
  });
  assertEquals(result.capture.media.length, 0);
  assertEquals(result.capture.truncated, false);

  const posting = new GraphCompetitorProvider({
    fetchFn: (async () => jsonResponse(targetPayload({ media: undefined, media_count: 3 }))) as typeof fetch,
  });
  await assertRejects(
    () =>
      posting.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );
});

Deno.test("a count beyond the safe integer range is not accepted as exact", async () => {
  const provider = new GraphCompetitorProvider({
    fetchFn: (async () => jsonResponse(targetPayload({ followers_count: 9007199254740992 }))) as typeof fetch,
  });
  await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );
});

Deno.test("a transport that ignores the abort cannot outlive the attempt ceiling", async () => {
  const provider = new GraphCompetitorProvider({
    fetchFn: (() => new Promise<Response>(() => undefined)) as typeof fetch,
    attemptTimeoutMs: 20,
  });
  const started = Date.now();
  await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );
  assert(Date.now() - started < 2_000);
});

Deno.test("the obsolete nested-username response shape is refused, not read as a target", async () => {
  const mockFetch = async () =>
    jsonResponse({ business_discovery: { username: { id: "1784140001", followers_count: 1 } } });

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.kind, "provider_error");
});

Deno.test("a rejected credential is classified as token_invalid", async () => {
  const mockFetch = async () =>
    jsonResponse(
      {
        error: {
          message: "Error validating access token: Session has expired",
          type: "OAuthException",
          code: 190,
          error_subcode: 463,
        },
      },
      { status: 400 },
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.kind, "token_invalid");
  assertEquals(error.retryable, false);
});

Deno.test("a refused permission is classified as scope_missing", async () => {
  const mockFetch = async () =>
    jsonResponse(
      {
        error: {
          message: "Requires instagram_manage_insights permission",
          type: "OAuthException",
          code: 10,
        },
      },
      { status: 403 },
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.kind, "scope_missing");
  assertEquals(error.retryable, false);
});

Deno.test("code 100 with subcode 33 is NOT the unavailable-target verdict", async () => {
  // Meta's message for this code names three causes, one of which is the
  // VIEWER's permissions. It must stay retryable.
  const mockFetch = async () =>
    jsonResponse(
      {
        error: {
          message:
            "Unsupported get request. Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation",
          type: "GraphMethodException",
          code: 100,
          error_subcode: 33,
        },
      },
      { status: 400 },
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.kind === "target_unavailable", false);
  assertEquals(error.kind, "provider_error");
});

Deno.test("a Graph error delivered with HTTP 200 is an error", async () => {
  const mockFetch = async () =>
    jsonResponse({
      error: {
        message: "Unsupported get request",
        type: "GraphMethodException",
        code: 100,
      },
    });

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.kind === "target_unavailable", false);
});

Deno.test("a failure never carries the provider text or the token", async () => {
  const mockFetch = async () =>
    jsonResponse(
      {
        error: {
          message: `Invalid OAuth token ${TOKEN} for account 1784140001`,
          type: "OAuthException",
          code: 190,
        },
      },
      { status: 400 },
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.message.includes(TOKEN), false);
  assertEquals(error.message.includes("1784140001"), false);
  assertEquals(error.message, "The provider rejected the credential.");
});

Deno.test("both usage headers are read and the highest wins", () => {
  const headers = new Headers({
    "x-app-usage": JSON.stringify({ call_count: 40, total_time: 10, total_cputime: 5 }),
    "x-business-use-case-usage": JSON.stringify([
      { type: "instagram_basic", call_count: 85, total_time: 10 },
    ]),
  });

  assertEquals(parseUsagePercent(headers), 85);
});

Deno.test("a nested business usage object is read too", () => {
  const headers = new Headers({
    "x-business-use-case-usage": JSON.stringify([
      {
        type: "instagram_basic",
        call_count: 10,
        usage: { call_count: 91, total_time: 12 },
      },
    ]),
  });

  assertEquals(parseUsagePercent(headers), 91);
});

Deno.test("a second header is not ignored when the first one is present", () => {
  const headers = new Headers({
    "x-app-usage": JSON.stringify({ call_count: 12 }),
    "x-business-use-case-usage": JSON.stringify({ call_count: 77 }),
  });

  assertEquals(parseUsagePercent(headers), 77);
});

Deno.test("a nearly spent budget stops the pagination but keeps the capture", async () => {
  let calls = 0;

  const mockFetch = async () => {
    calls += 1;
    return jsonResponse(targetPayload({}, [{
      id: `media_${calls}`,
      media_type: "IMAGE",
      media_product_type: "FEED",
      timestamp: "2026-10-28T12:00:00Z",
    }]), {
      headers: {
        "Content-Type": "application/json",
        "x-app-usage": JSON.stringify({ call_count: 85 }),
      },
    });
  };

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const result = await provider.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
  });

  // The capture that already happened is kept, and no further request is
  // made for it.
  assertEquals(calls, 1);
  assertEquals(result.usagePercent, 85);
  assertEquals(result.capture.media.length, 1);
  assertEquals(result.capture.truncated, true);
});

Deno.test("a throttle is read from the headers of an error response too", async () => {
  const mockFetch = async () =>
    jsonResponse(
      { error: { message: "boom", code: 1 } },
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "x-app-usage": JSON.stringify({ call_count: 91 }),
        },
      },
    );

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.kind, "rate_limited");
  assertEquals(error.usagePercent, 91);
});

Deno.test("a 5xx is retried at most twice and a 4xx is not retried", async () => {
  let serverCalls = 0;
  const serverMock = async () => {
    serverCalls += 1;
    return jsonResponse({ error: { message: "boom", code: 2 } }, { status: 500 });
  };

  const provider = new GraphCompetitorProvider({ fetchFn: serverMock as typeof fetch });
  await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );
  assertEquals(serverCalls, 3);

  let clientCalls = 0;
  const clientMock = async () => {
    clientCalls += 1;
    return jsonResponse({ error: { message: "boom", code: 1 } }, { status: 400 });
  };

  const second = new GraphCompetitorProvider({ fetchFn: clientMock as typeof fetch });
  await assertRejects(
    () =>
      second.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );
  assertEquals(clientCalls, 1);
});

Deno.test("the attempt ceiling covers the body, not only the headers", async () => {
  const stalled = new ReadableStream<Uint8Array>({
    pull() {
      // Never closes: the body read has to be bounded by the same abort.
      return new Promise<void>(() => undefined);
    },
  });

  const mockFetch = async () =>
    new Response(stalled, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const provider = new GraphCompetitorProvider({
    fetchFn: mockFetch as typeof fetch,
    attemptTimeoutMs: 60,
  });

  const error = await assertRejects(
    () =>
      provider.fetch({
        username: "competitor_brand",
        viewerIgUserId: VIEWER,
        token: TOKEN,
        signal: new AbortController().signal,
      }),
    CompetitorProviderError,
  );

  assertEquals(error.kind, "provider_error");
});

Deno.test("the configured version is validated and defaults to v22.0", () => {
  assertEquals(resolveGraphApiVersion(null), "v22.0");
  assertEquals(resolveGraphApiVersion(""), "v22.0");
  assertEquals(resolveGraphApiVersion("v21.0"), "v21.0");
});

Deno.test("a malformed configured version is refused", () => {
  let threw = false;
  try {
    resolveGraphApiVersion("v22.0; DROP");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("a handle that could inject the field grammar is refused", () => {
  assertEquals(normalizeCompetitorHandle("competitor_brand"), "competitor_brand");
  assertEquals(normalizeCompetitorHandle("@Competitor_Brand"), "competitor_brand");
  assertEquals(normalizeCompetitorHandle("bad..handle"), null);
  assertEquals(normalizeCompetitorHandle("a".repeat(31)), null);
  assertEquals(normalizeCompetitorHandle("brand){id}"), null);
  assertEquals(normalizeCompetitorHandle("brand,other"), null);
});

Deno.test("a cursor that could change the request stops the pagination", async () => {
  let calls = 0;

  const mockFetch = async () => {
    calls += 1;
    return jsonResponse({
      business_discovery: {
        id: "1",
        followers_count: 10,
        media: {
          data: [{
            id: `media_${calls}`,
            media_type: "IMAGE",
            media_product_type: "FEED",
            timestamp: "2026-10-28T12:00:00Z",
          }],
          paging: { cursors: { after: "abc){id}" } },
        },
      },
    });
  };

  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch as typeof fetch });
  const result = await provider.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
  });

  // The cursor is not usable, so it is never sent and the pagination
  // stops after the first page.
  assertEquals(calls, 1);
  assertEquals(result.capture.truncated, true);
});

Deno.test("the shared throttle bucket key is a stable 64 character digest", async () => {
  const provider = new GraphCompetitorProvider({
    fetchFn: (async () => jsonResponse(targetPayload({}, []))) as typeof fetch,
    appId: "1234567890",
  });

  const first = await provider.bucketKey(VIEWER);
  const second = await provider.bucketKey(VIEWER);
  const other = await provider.bucketKey("another_viewer");

  assertEquals(first.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(first), true);
  assertEquals(first, second);
  assertEquals(first === other, false);
  assertEquals(first.includes(TOKEN), false);
});

// ---------------------------------------------------------------------------
// The capture coverage.
//
// A successful capture is NOT evidence of a complete weekly inventory, so
// the adapter reports what it actually saw while walking the feed. These
// tests pin that evidence, and they pin that reporting it costs NO extra
// request.
// ---------------------------------------------------------------------------

/** One media row of the feed. */
function feedRow(index: number, publishedAt: string): Record<string, unknown> {
  return {
    id: `feed_${index}`,
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: publishedAt,
  };
}

/** A target whose media connection carries the given rows and cursor. */
function pagedTarget(
  rows: unknown[],
  cursor: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const media: Record<string, unknown> = { data: rows };
  if (cursor !== null) {
    media.paging = { cursors: { before: "BEFORE", after: cursor } };
  }

  return {
    business_discovery: {
      id: "1784140001",
      username: "competitor_brand",
      name: "Competitor Brand",
      followers_count: 54200,
      media_count: 120,
      media,
      ...overrides,
    },
  };
}

async function fetchWith(
  mockFetch: typeof fetch,
): Promise<Awaited<ReturnType<GraphCompetitorProvider["fetch"]>>> {
  const provider = new GraphCompetitorProvider({ fetchFn: mockFetch });
  return await provider.fetch({
    username: "competitor_brand",
    viewerIgUserId: VIEWER,
    token: TOKEN,
    signal: new AbortController().signal,
  });
}

Deno.test("a clean capture reports an exhausted, uncapped and UNVERIFIED feed", async () => {
  const result = await fetchWith(
    (async () =>
      jsonResponse(
        pagedTarget([feedRow(1, "2026-10-28T12:00:00Z")], null),
      )) as typeof fetch,
  );

  const coverage = result.capture.coverage;

  assertEquals(coverage.exhausted, true);
  assertEquals(coverage.truncated, false);
  assertEquals(coverage.gapReason, null);
  assertEquals(coverage.cursorPresent, false);
  // The provider's order is NOT a verified contract, so the capture never
  // claims that it is.
  assertEquals(coverage.orderingVerified, false);
  assertEquals(coverage.oldestReturnedAt, "2026-10-28T12:00:00.000Z");
  assert(
    Date.parse(coverage.captureStartedAt) <= Date.parse(coverage.captureEndedAt),
    "the capture window does not end before it starts",
  );
});

Deno.test("thirty lifetime posts of which three are recent exhaust the feed", async () => {
  // Twenty-seven old posts and three recent ones, over two pages, and the
  // provider offers no third page: the feed really ended.
  const old = Array.from({ length: 27 }, (_, index) =>
    feedRow(index + 1, "2026-09-01T12:00:00Z"));
  const recent = Array.from({ length: 3 }, (_, index) =>
    feedRow(index + 28, "2026-10-28T12:00:00Z"));

  let calls = 0;
  const result = await fetchWith((async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(pagedTarget(old.slice(0, 25), "AFTER1"));
    }
    return jsonResponse(pagedTarget([...old.slice(25), ...recent], null));
  }) as typeof fetch);

  const coverage = result.capture.coverage;

  assertEquals(calls, 2);
  assertEquals(result.capture.media.length, 30);
  // The feed ENDED at thirty posts, so this is not a capped capture: a full
  // page is not automatically an incomplete inventory.
  assertEquals(coverage.exhausted, true);
  assertEquals(coverage.truncated, false);
  assertEquals(coverage.gapReason, null);
  assertEquals(coverage.cursorPresent, false);
  // The oldest instant the capture returned reaches back past the week.
  assertEquals(coverage.oldestReturnedAt, "2026-09-01T12:00:00.000Z");
});

Deno.test("thirty recent posts with more to come are capped and name the cap", async () => {
  const first = Array.from({ length: 25 }, (_, index) =>
    feedRow(index + 1, "2026-10-28T12:00:00Z"));
  const second = Array.from({ length: 25 }, (_, index) =>
    feedRow(index + 26, "2026-10-28T12:00:00Z"));

  let calls = 0;
  const result = await fetchWith((async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(pagedTarget(first, "AFTER1"));
    return jsonResponse(pagedTarget(second, "AFTER2"));
  }) as typeof fetch);

  const coverage = result.capture.coverage;

  // The coverage costs no extra request.
  assertEquals(calls, 2);
  assertEquals(result.capture.media.length, 30);
  assertEquals(coverage.exhausted, false);
  assertEquals(coverage.truncated, true);
  assertEquals(coverage.gapReason, "media_cap_reached");
  assertEquals(coverage.cursorPresent, true);
});

Deno.test("a repeated media id compromises the feed and says so", async () => {
  const result = await fetchWith((async () =>
    jsonResponse(
      pagedTarget([
        feedRow(1, "2026-10-28T12:00:00Z"),
        feedRow(1, "2026-10-27T12:00:00Z"),
      ], null),
    )) as typeof fetch);

  const coverage = result.capture.coverage;

  assertEquals(result.capture.media.length, 1);
  assertEquals(coverage.exhausted, false);
  assertEquals(coverage.truncated, true);
  assertEquals(coverage.gapReason, "duplicate_media");
});

Deno.test("a repeated cursor stops the walk and says so", async () => {
  let calls = 0;
  const result = await fetchWith((async () => {
    calls += 1;
    return jsonResponse(pagedTarget([feedRow(calls, "2026-10-28T12:00:00Z")], "AFTER1"));
  }) as typeof fetch);

  const coverage = result.capture.coverage;

  assertEquals(calls, 2);
  assertEquals(coverage.exhausted, false);
  assertEquals(coverage.truncated, true);
  assertEquals(coverage.gapReason, "cursor_loop");
});

Deno.test("a cursor that cannot be sent stops the walk and says so", async () => {
  let calls = 0;
  const result = await fetchWith((async () => {
    calls += 1;
    return jsonResponse(
      pagedTarget([feedRow(calls, "2026-10-28T12:00:00Z")], "abc){id}"),
    );
  }) as typeof fetch);

  const coverage = result.capture.coverage;

  assertEquals(calls, 1);
  assertEquals(coverage.exhausted, false);
  assertEquals(coverage.truncated, true);
  assertEquals(coverage.gapReason, "cursor_unusable");
});

Deno.test("the page budget of one capture names the page cap", async () => {
  let calls = 0;
  const result = await fetchWith((async () => {
    calls += 1;
    return jsonResponse(
      pagedTarget([feedRow(calls, "2026-10-28T12:00:00Z")], `AFTER${calls}`),
    );
  }) as typeof fetch);

  const coverage = result.capture.coverage;

  // The capture walked its page budget and the provider was still offering
  // pages: the feed was not exhausted.
  assertEquals(calls, 2);
  assertEquals(coverage.exhausted, false);
  assertEquals(coverage.truncated, true);
  assertEquals(coverage.gapReason, "page_cap_reached");
});

Deno.test("the usage budget stops the walk and says so", async () => {
  let calls = 0;
  const result = await fetchWith((async () => {
    calls += 1;
    return jsonResponse(pagedTarget([feedRow(calls, "2026-10-28T12:00:00Z")], "AFTER1"), {
      headers: {
        "Content-Type": "application/json",
        "x-app-usage": JSON.stringify({ call_count: 85 }),
      },
    });
  }) as typeof fetch);

  const coverage = result.capture.coverage;

  assertEquals(calls, 1);
  assertEquals(coverage.exhausted, false);
  assertEquals(coverage.truncated, true);
  assertEquals(coverage.gapReason, "usage_budget_stop");
});

Deno.test("an empty feed is exhausted and has no oldest instant", async () => {
  const result = await fetchWith((async () =>
    jsonResponse(
      pagedTarget([], null, { media_count: 0, media: undefined }),
    )) as typeof fetch);

  const coverage = result.capture.coverage;

  assertEquals(result.capture.media.length, 0);
  assertEquals(coverage.exhausted, true);
  assertEquals(coverage.truncated, false);
  assertEquals(coverage.gapReason, null);
  // A genuinely empty feed has no oldest instant, and that is null rather
  // than a substitute.
  assertEquals(coverage.oldestReturnedAt, null);
});
