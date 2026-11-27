import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createYouTubeEditProvider } from "./editProvider.ts";

const CHANNEL = "UCfixturechannel000000001";
const VIDEO = "AbcD1234eFg";

function item() {
  return {
    id: VIDEO,
    etag: "fixture-etag",
    snippet: { channelId: CHANNEL, title: "Original", description: "Description", categoryId: "22", tags: ["a"] },
    status: { privacyStatus: "private", embeddable: false, license: "youtube", publicStatsViewable: false },
  };
}

function fetchReturning(body: unknown): typeof fetch {
  return (() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  })) as unknown as typeof fetch;
}

Deno.test("the real videos.list envelope is unwrapped before the resource is validated", async () => {
  const provider = createYouTubeEditProvider({ fetchImpl: fetchReturning({ kind: "youtube#videoListResponse", items: [item()] }) });
  const read = await provider.getVideo("token", { videoId: VIDEO, channelId: CHANNEL });
  assertEquals(read.ok, true);
  if (read.ok) {
    assertEquals(read.value.id, VIDEO);
    assertEquals(read.value.snippet.title, "Original");
    assertEquals(read.value.status.privacyStatus, "private");
  }
});

Deno.test("an envelope that does not identify exactly one owned video is not found", async () => {
  for (const items of [[], [item(), item()]]) {
    const provider = createYouTubeEditProvider({ fetchImpl: fetchReturning({ items }) });
    const read = await provider.getVideo("token", { videoId: VIDEO, channelId: CHANNEL });
    assertEquals(read.ok, false);
    if (!read.ok) assertEquals(read.code, "not_found");
  }
});

const SAMPLE_PLAN = {
  parts: ["snippet"],
  body: { snippet: { title: "Updated", description: "Description", tags: ["a"], categoryId: "22" } },
  ifMatch: '"fixture-etag-v1"',
  expectedPrivacy: "private",
};

Deno.test("updateVideo sends If-Match and makes exactly one PUT on lost answers (outcome_unknown)", async () => {
  const cases: Array<{ name: string; fetchImpl: typeof fetch }> = [
    {
      name: "thrown fetch",
      fetchImpl: (() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch,
    },
    {
      name: "timeout / abort",
      fetchImpl: (() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))) as unknown as typeof fetch,
    },
    {
      name: "non-JSON 2xx",
      fetchImpl: (() => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
      })) as unknown as typeof fetch,
    },
    {
      name: "mismatched-id 2xx",
      fetchImpl: (() => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ...item(), id: "OtherVideoId1" }),
      })) as unknown as typeof fetch,
    },
  ];

  for (const testCase of cases) {
    let putCount = 0;
    let seenIfMatch: string | null = null;
    const countingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCount += 1;
        seenIfMatch = new Headers(init.headers).get("If-Match");
      }
      return testCase.fetchImpl(input, init);
    }) as typeof fetch;

    const provider = createYouTubeEditProvider({ fetchImpl: countingFetch });
    const result = await provider.updateVideo("bound-fixture-123", { videoId: VIDEO, plan: SAMPLE_PLAN });
    assertEquals(result, { ok: false, code: "outcome_unknown" }, testCase.name);
    assertEquals(putCount, 1, `${testCase.name} must send exactly one PUT`);
    assertEquals(seenIfMatch, '"fixture-etag-v1"', `${testCase.name} must send If-Match`);
  }
});

Deno.test("updateVideo preserves explicit non-2xx error codes and sends exactly one PUT", async () => {
  const statusCases: Array<{ status: number; expectedCode: "reconnect_required" | "edit_conflict" | "upstream_unavailable" }> = [
    { status: 401, expectedCode: "reconnect_required" },
    { status: 403, expectedCode: "reconnect_required" },
    { status: 412, expectedCode: "edit_conflict" },
    { status: 500, expectedCode: "upstream_unavailable" },
  ];

  for (const { status, expectedCode } of statusCases) {
    let putCount = 0;
    let seenIfMatch: string | null = null;
    const countingFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCount += 1;
        seenIfMatch = new Headers(init.headers).get("If-Match");
      }
      return Promise.resolve({
        ok: false,
        status,
        json: () => Promise.resolve({ error: { code: status } }),
      });
    }) as unknown as typeof fetch;

    const provider = createYouTubeEditProvider({ fetchImpl: countingFetch });
    const result = await provider.updateVideo("bound-fixture-123", { videoId: VIDEO, plan: SAMPLE_PLAN });
    assertEquals(result, { ok: false, code: expectedCode }, `HTTP ${status}`);
    assertEquals(putCount, 1, `HTTP ${status} must send exactly one PUT`);
    assertEquals(seenIfMatch, '"fixture-etag-v1"', `HTTP ${status} must send If-Match`);
  }
});
