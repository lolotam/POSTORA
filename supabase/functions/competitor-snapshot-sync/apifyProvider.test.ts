/**
 * The bounded paid adapter's contract.
 *
 * WHAT THIS SUITE PINS
 *
 *   The actor input contract, the actor id validation, the header
 *   authentication, the results cap, and - the point of the whole adapter -
 *   that a lost run-start response is INDETERMINATE and is never retried.
 *
 * NOTHING HERE STARTS A PAID RUN.
 *
 *   The transport is injected. No request reaches Apify, and the suite
 *   proves that a start is sent exactly once even when its response is
 *   lost.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  ApifyCompetitorProvider,
  buildApifyActorInput,
  resolveApifyActorId,
  DEFAULT_APIFY_ACTOR_ID,
  MAX_PAID_MEDIA_ROWS,
} from "./apifyProvider.ts";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

function recorder(): {
  calls: RecordedCall[];
  fetchFn: typeof fetch;
} {
  const calls: RecordedCall[] = [];

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "string") headers[key] = value;
      }
    }

    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });

    if ((init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ data: { id: "run-1", status: "READY" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify([
      {
        id: "post-1",
        shortCode: "abc",
        type: "Video",
        displayUrl: "https://example.invalid/1.jpg",
        caption: "caption",
        likesCount: 10,
        commentsCount: 2,
        videoViewCount: 100,
        timestamp: "2026-10-28T12:00:00Z",
        followersCount: 500,
        postsCount: 12,
      },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  return { calls, fetchFn };
}

Deno.test("the actor input is the existing contract with a capped limit", () => {
  const input = buildApifyActorInput("competitor_brand", 500);

  assertEquals(input.directUrls, ["https://www.instagram.com/competitor_brand/"]);
  assertEquals(input.resultsType, "posts");
  assertEquals(input.resultsLimit, MAX_PAID_MEDIA_ROWS);
  assertEquals(input.addParentData, true);
});

Deno.test("the actor id is validated and defaults to the interactive path's actor", () => {
  assertEquals(resolveApifyActorId(null), DEFAULT_APIFY_ACTOR_ID);
  assertEquals(resolveApifyActorId(""), DEFAULT_APIFY_ACTOR_ID);
  assertEquals(resolveApifyActorId("apify~instagram-scraper"), "apify~instagram-scraper");

  let threw = false;
  try {
    resolveApifyActorId("not a valid actor id");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("the credential travels in a header and never in the URL", async () => {
  const { calls, fetchFn } = recorder();

  const provider = new ApifyCompetitorProvider({
    apiToken: "apify-secret-token",
    fetchFn,
  });

  const outcome = await provider.capture({
    username: "competitor_brand",
    signal: new AbortController().signal,
  });

  assertEquals(outcome.status, "completed");
  assertEquals(calls.length, 2);
  assertEquals(calls[0]!.method, "POST");
  assertEquals(calls[0]!.url.includes("apify-secret-token"), false);
  assertEquals(calls[0]!.headers["Authorization"], "Bearer apify-secret-token");
  assertEquals(calls[0]!.url.startsWith("https://api.apify.com/"), true);
  assertEquals(calls[1]!.url.startsWith("https://api.apify.com/"), true);
  assertEquals(calls[1]!.url.includes("apify-secret-token"), false);
  assertEquals(calls[1]!.headers["Authorization"], "Bearer apify-secret-token");
});

Deno.test("a completed paid capture carries the typed source and the counts", async () => {
  const { fetchFn } = recorder();

  const provider = new ApifyCompetitorProvider({
    apiToken: "apify-secret-token",
    fetchFn,
  });

  const outcome = await provider.capture({
    username: "competitor_brand",
    signal: new AbortController().signal,
  });

  assertEquals(outcome.status, "completed");
  if (outcome.status !== "completed") return;

  assertEquals(outcome.capture.source, "apify");
  assertEquals(outcome.capture.profile.followers_count, 500);
  assertEquals(outcome.capture.profile.media_count, 12);
  assertEquals(outcome.capture.media.length, 1);

  const media = outcome.capture.media[0]!;
  assertEquals(media.ig_media_id, "post-1");
  assertEquals(media.media_type, "VIDEO");
  assertEquals(media.media_product_type, null);
  assertEquals(media.view_count, 100);
  assertEquals(media.like_count, 10);
  assertEquals(media.published_at, "2026-10-28T12:00:00.000Z");
});

Deno.test("a lost run-start response is indeterminate and is never repeated", async () => {
  let starts = 0;

  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      starts += 1;
      // The request reached the provider and the response was lost.
      throw new TypeError("network error after the request was sent");
    }
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new ApifyCompetitorProvider({
    apiToken: "apify-secret-token",
    fetchFn,
  });

  const outcome = await provider.capture({
    username: "competitor_brand",
    signal: new AbortController().signal,
  });

  assertEquals(outcome.status, "indeterminate");
  assertEquals(starts, 1);
});

Deno.test("an adapter without a credential refuses instead of calling out", async () => {
  let calls = 0;

  const fetchFn = (async () => {
    calls += 1;
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new ApifyCompetitorProvider({ fetchFn });

  const outcome = await provider.capture({
    username: "competitor_brand",
    signal: new AbortController().signal,
  });

  assertEquals(outcome.status, "failed");
  assertEquals(calls, 0);
});

Deno.test("a refused run start is a failure, not an indeterminate submission", async () => {
  let calls = 0;

  const fetchFn = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 });
  }) as unknown as typeof fetch;

  const provider = new ApifyCompetitorProvider({
    apiToken: "apify-secret-token",
    fetchFn,
  });

  const outcome = await provider.capture({
    username: "competitor_brand",
    signal: new AbortController().signal,
  });

  assertEquals(outcome.status, "failed");
  // The start was refused, so nothing was billed and nothing is repeated.
  assertEquals(calls, 1);
});

Deno.test("a dataset row without a publication instant is a failure", async () => {
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ data: { id: "run-1" } }), { status: 201 });
    }
    return new Response(JSON.stringify([{ id: "post-1" }]), { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new ApifyCompetitorProvider({
    apiToken: "apify-secret-token",
    fetchFn,
  });

  const outcome = await provider.capture({
    username: "competitor_brand",
    signal: new AbortController().signal,
  });

  assertEquals(outcome.status, "failed");
});

Deno.test("a handle that could change the target is refused before any request", async () => {
  let calls = 0;

  const fetchFn = (async () => {
    calls += 1;
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new ApifyCompetitorProvider({
    apiToken: "apify-secret-token",
    fetchFn,
  });

  const outcome = await provider.capture({
    username: "bad..handle",
    signal: new AbortController().signal,
  });

  assertEquals(outcome.status, "failed");
  assertEquals(calls, 0);
});
