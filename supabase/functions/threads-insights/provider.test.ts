import { assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadPostMetrics, ThreadsInsightsProvider } from "./provider.ts";

const TOKEN = "fixture-token";
function provider(fetcher: typeof fetch, options: { requestTimeoutMs?: number; maxCalls?: number; startedAt?: number; budgetMs?: number; signal?: AbortSignal } = {}) {
  return new ThreadsInsightsProvider({ token: TOKEN, startedAt: Date.now(), signal: new AbortController().signal, fetch: fetcher, ...options });
}

Deno.test("all provider calls use fixed origin, bearer headers, redirect refusal and preserve numeric zero", async () => {
  const requests: Request[] = [];
  const client = provider(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    assertEquals(init?.redirect, "error");
    return Response.json({ data: [{ name: "views", total_value: { value: 0 }, values: [{ value: 0 }, { value: 5 }] }] });
  });
  const response = await client.profile({ userId: "thread_owner", metrics: ["views"], since: 1, until: 2, metricType: "time_series" });
  assertEquals(response.error, null);
  assertEquals(response.data?.data[0].total_value?.value, 0);
  assertEquals(response.data?.data[0].values?.map((point) => point.value), [0, 5]);
  const url = new URL(requests[0].url);
  assertEquals(url.origin, "https://graph.threads.net");
  assertEquals(url.pathname, "/v1.0/thread_owner/threads_insights");
  assertEquals(url.searchParams.get("metric_type"), "time_series");
  assertFalse(requests[0].url.includes(TOKEN));
  assertEquals(requests[0].headers.get("Authorization"), `Bearer ${TOKEN}`);
});

Deno.test("malformed and oversized HTTP-200 responses are failed reads, never empty metric sets", async (test) => {
  const malformed = [
    {}, { data: "not-an-array" }, { data: [null] }, { data: [], error: "malformed error" },
    { data: [{ name: "views", total_value: { value: "0" } }] },
  ];
  for (const payload of malformed) {
    await test.step(JSON.stringify(payload), async () => {
      const client = provider(async () => Response.json(payload));
      const response = await client.postInsights("post_1");
      assertEquals(response.status, 200);
      assertEquals(response.error?.kind, "invalid_response");
      assertEquals(response.data, null);
    });
  }
  for (const body of ["not-json", "x".repeat(1_048_577)]) {
    const client = provider(async () => new Response(body));
    assertEquals((await client.postInsights("post_1")).error?.kind, "invalid_response");
  }
  const validEmpty = provider(async () => Response.json({ data: [] }));
  assertEquals((await validEmpty.postInsights("post_1")).data, { data: [] });
});

Deno.test("deadline resolves an uncooperative HTTP call and an uncooperative body", async (test) => {
  await test.step("fetch ignores cancellation", async () => {
    const client = provider(() => new Promise(() => undefined), { requestTimeoutMs: 20 });
    const response = await client.identity();
    assertEquals(response.error?.kind, "transport");
    assertEquals(response.data, null);
  });
  await test.step("response body never resolves", async () => {
    const client = provider(async () => new Response(new ReadableStream({ pull: () => new Promise(() => undefined) })), { requestTimeoutMs: 20 });
    const response = await client.identity();
    assertEquals(response.error?.kind, "transport");
    assertEquals(response.data, null);
  });
});

Deno.test("cancelled, expired and exhausted requests never perform another HTTP call", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ id: "owner" }); };
  const controller = new AbortController();
  controller.abort();
  assertEquals((await provider(fetcher, { signal: controller.signal }).identity()).error?.kind, "aborted");
  assertEquals((await provider(fetcher, { startedAt: Date.now() - 100, budgetMs: 10 }).identity()).error?.kind, "budget");
  assertEquals(calls, 0);
  const client = provider(fetcher, { maxCalls: 2 });
  assertEquals((await client.identity()).error, null);
  assertEquals((await client.identity()).error, null);
  assertEquals((await client.identity()).error?.kind, "budget");
  assertEquals(calls, 2);
  const races = new AbortController();
  const racing = provider(() => { races.abort(); return Promise.reject(new Error(TOKEN)); }, { signal: races.signal });
  assertEquals((await racing.identity()).error?.kind, "aborted");
});

Deno.test("a provider throttle parks later calls and never returns raw provider credentials", async () => {
  let calls = 0;
  const client = provider(async () => {
    calls++;
    return Response.json({ error: { code: 4, message: `private URL access_token=${TOKEN}`, error_subcode: 99 } }, { status: 429, headers: { "Retry-After": "120" } });
  });
  const first = await client.identity();
  assertEquals(first.error?.reason, "rate_limited");
  assertEquals(first.error?.subcode, 99);
  assertEquals(typeof first.retryAt, "string");
  const second = await client.postInsights("post1");
  assertEquals(second.retryAt, first.retryAt);
  assertEquals(calls, 1);
  assertFalse(JSON.stringify([first, second]).includes(TOKEN));
});

Deno.test("HTTP 429 without valid JSON still parks later calls", async () => {
  let calls = 0;
  const client = provider(async () => { calls++; return new Response("not-json", { status: 429, headers: { "Retry-After": "120" } }); });
  const first = await client.identity();
  assertEquals(first.error?.reason, "rate_limited");
  assertEquals(typeof first.retryAt, "string");
  assertEquals((await client.identity()).retryAt, first.retryAt);
  assertEquals(calls, 1);
});

Deno.test("HTTP-date backoff and malformed error bodies retain authoritative throttling", async () => {
  const retryAt = new Date(Date.now() + 120_000).toUTCString();
  const client = provider(async () => Response.json({ error: "invalid envelope" }, { status: 429, headers: { "Retry-After": retryAt } }));
  const response = await client.identity();
  assertEquals(response.error?.reason, "rate_limited");
  assertEquals(response.retryAt, new Date(retryAt).toISOString());
});

Deno.test("credential, permission and server errors remain distinct without their raw messages", async (test) => {
  for (const [status, code, subcode, reason] of [
    [400, 190, 463, "expired_token"], [400, 190, 0, "invalid_token"],
    [403, 10, 0, "missing_scope"], [403, 200, 0, "missing_scope"], [503, 2, 0, "transient"],
  ] as const) {
    await test.step(reason, async () => {
      const client = provider(async () => Response.json({ error: { code, error_subcode: subcode, message: TOKEN } }, { status }));
      const response = await client.identity();
      assertEquals(response.error?.reason, reason);
      assertFalse(JSON.stringify(response).includes(TOKEN));
    });
  }
});

Deno.test("post insights cap parallel HTTP requests at three and retain listing order", async () => {
  let active = 0;
  let peak = 0;
  const client = provider(async (input) => {
    active++;
    peak = Math.max(peak, active);
    const url = new URL(String(input));
    await new Promise((resolve) => setTimeout(resolve, url.pathname.includes("post0") ? 10 : 0));
    active--;
    return Response.json({ data: [{ name: "views", total_value: { value: Number(url.pathname.split("/")[2].slice(4)) } }] });
  });
  const posts = Array.from({ length: 8 }, (_unused, index) => ({ id: `post${index}` }));
  const responses = await loadPostMetrics(client, posts);
  assertEquals(peak, 3);
  assertEquals(responses.map((entry) => entry.post.id), posts.map((post) => post.id));
  assertEquals(responses.map((entry) => entry.insights.data?.data[0].total_value?.value), [0, 1, 2, 3, 4, 5, 6, 7]);
});

Deno.test("a failed body stream remains a sanitized failure", async () => {
  const client = provider(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(TOKEN)); } })));
  const response = await client.identity();
  assertEquals(response.data, null);
  assertEquals(response.error?.kind, "transport");
  assertFalse(JSON.stringify(response).includes(TOKEN));
});
