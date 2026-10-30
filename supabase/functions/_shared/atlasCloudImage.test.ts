import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkAtlasJob, pollAtlasJob, submitAtlasJob, type AtlasCheckResult } from "./atlasCloudImage.ts";

type Call = { url: string; method: string; auth: string | null; body: unknown };

/** A fake AtlasCloud: `submit` answers the POST, `polls` answer the GETs in order (the last repeats). */
function fakeAtlas(submit: () => Response | Promise<Response>, polls: Array<() => Response | Promise<Response>> = []) {
  const calls: Call[] = [];
  let pollIndex = 0;
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.method === "POST") return Promise.resolve(submit());
    const poll = polls[Math.min(pollIndex++, polls.length - 1)];
    return Promise.resolve(poll());
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const submitted = () => json({ code: 200, data: { id: "pred-1" } });
const pending = () => json({ data: { status: "processing" } });
const completed = (output: unknown = "https://cdn.example/out.png") => () => json({ data: { status: "completed", outputs: [output] } });

const base = { apiKey: "test-key" };

Deno.test("submit sends the body with the bearer key and returns the prediction id", async () => {
  const { fetchFn, calls } = fakeAtlas(submitted);
  const result = await submitAtlasJob({ ...base, body: { model: "m", image: "https://x/y.png" }, fetchFn });
  assertEquals(result, { ok: true, predictionId: "pred-1" });
  assertEquals(calls[0], {
    url: "https://api.atlascloud.ai/api/v1/model/generateImage",
    method: "POST",
    auth: "Bearer test-key",
    body: { model: "m", image: "https://x/y.png" },
  });
});

Deno.test("submit: an exhausted balance or a refused key is the operator's problem, answered as 503", async () => {
  const answers = [
    () => new Response("insufficient_balance", { status: 402 }),
    () => json({ message: "Insufficient balance" }, 400),
    () => new Response("bad key", { status: 401 }),
    () => json({ code: 400, message: "Not enough credit" }),
  ];
  for (const answer of answers) {
    const result = await submitAtlasJob({ ...base, body: {}, fetchFn: fakeAtlas(answer).fetchFn });
    assertEquals(result.ok === false && [result.kind, result.httpStatus], ["provider_rejected", 503]);
  }
});

Deno.test("submit: a rate limit is passed on as 429, an answer without an id is a bad_response", async () => {
  const limited = await submitAtlasJob({ ...base, body: {}, fetchFn: fakeAtlas(() => new Response("slow down", { status: 429 })).fetchFn });
  assertEquals(limited.ok === false && [limited.kind, limited.httpStatus], ["rate_limited", 429]);
  const noId = await submitAtlasJob({ ...base, body: {}, fetchFn: fakeAtlas(() => json({ code: 200, data: {} })).fetchFn });
  assertEquals(noId.ok === false && [noId.kind, noId.httpStatus], ["bad_response", 502]);
});

Deno.test("submit: a timeout is a 504, an unreachable provider a 502", async () => {
  const timedOut = ["Request timed out", "The signal has been aborted"].map((message) => (() => Promise.reject(new Error(message))) as typeof fetch);
  for (const fetchFn of timedOut) {
    const result = await submitAtlasJob({ ...base, body: {}, fetchFn });
    assertEquals(result.ok === false && [result.kind, result.httpStatus], ["timeout", 504]);
  }
  const abort = (() => Promise.reject(new DOMException("aborted", "AbortError"))) as typeof fetch;
  assertEquals((await submitAtlasJob({ ...base, body: {}, fetchFn: abort })).ok === false && "timeout", "timeout");

  const down = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
  const result = await submitAtlasJob({ ...base, body: {}, fetchFn: down });
  assertEquals(result.ok === false && [result.kind, result.httpStatus], ["unreachable", 502]);
});

Deno.test("check: pending, done, and a failed prediction (the reason stays in the detail)", async () => {
  const check = (answer: () => Response) => checkAtlasJob({ ...base, predictionId: "pred-1", fetchFn: fakeAtlas(submitted, [answer]).fetchFn });
  assertEquals(await check(pending), { ok: true, state: "pending" });
  assertEquals(await check(completed()), { ok: true, state: "done", outputUrl: "https://cdn.example/out.png" });
  const failed = await check(() => json({ data: { status: "failed", error: "unsupported image" } }));
  assertEquals(failed.ok === false && [failed.kind, failed.httpStatus, failed.detail.includes("unsupported image")], ["failed", 502, true]);
});

Deno.test("check: an output that is not a well-formed https URL is a bad_response", async () => {
  for (const output of ["http://internal.example/out.png", "https://", "not a url", "/relative/out.png", 42, null]) {
    const result = await checkAtlasJob({ ...base, predictionId: "p", fetchFn: fakeAtlas(submitted, [completed(output)]).fetchFn });
    assertEquals(result.ok === false && result.kind, "bad_response", String(output));
  }
});

Deno.test("check: rejections and rate limits are final at once; a missing prediction is a failure", async () => {
  const check = (status: number) =>
    checkAtlasJob({ ...base, predictionId: "p", fetchFn: fakeAtlas(submitted, [() => new Response("no", { status })]).fetchFn });
  for (const status of [401, 402, 403]) {
    const result = await check(status);
    assertEquals(result.ok === false && [result.kind, result.httpStatus], ["provider_rejected", 503], String(status));
  }
  const limited = await check(429);
  assertEquals(limited.ok === false && [limited.kind, limited.httpStatus], ["rate_limited", 429]);
  const missing = await check(404);
  assertEquals(missing.ok === false && missing.kind, "failed");
});

Deno.test("check: a server error or a network failure is transient, so it reads as pending", async () => {
  assertEquals(
    await checkAtlasJob({ ...base, predictionId: "p", fetchFn: fakeAtlas(submitted, [() => new Response("oops", { status: 503 })]).fetchFn }),
    { ok: true, state: "pending" },
  );
  const down = (() => Promise.reject(new Error("reset"))) as typeof fetch;
  assertEquals(await checkAtlasJob({ ...base, predictionId: "p", fetchFn: down }), { ok: true, state: "pending" });
});

/** A clock the fake `sleep` advances, so the polling deadline is exercised without waiting. */
function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

Deno.test("poll: keeps checking until the prediction is done", async () => {
  const clock = fakeClock();
  const { fetchFn, calls } = fakeAtlas(submitted, [pending, pending, completed()]);
  const result = await pollAtlasJob({ ...base, predictionId: "pred-1", fetchFn, deadline: clock.now() + 30_000, now: clock.now, sleep: clock.sleep });
  assertEquals(result, { ok: true, state: "done", outputUrl: "https://cdn.example/out.png" });
  assertEquals(calls.length, 3);
  assertEquals(calls[0].url, "https://api.atlascloud.ai/api/v1/model/prediction/pred-1");
});

Deno.test("poll: at the deadline a running job is still pending, never a timeout failure", async () => {
  const clock = fakeClock();
  const { fetchFn, calls } = fakeAtlas(submitted, [pending]);
  const result = await pollAtlasJob({ ...base, predictionId: "p", fetchFn, deadline: clock.now() + 5_000, intervalMs: 2_000, now: clock.now, sleep: clock.sleep });
  assertEquals(result, { ok: true, state: "pending" });
  assertEquals(clock.sleeps, [2_000, 2_000, 1_000]); // the last wait is cut to the deadline
  assertEquals(calls.length, 4); // one final look at the deadline
});

Deno.test("poll: a refused key ends the loop on the first answer instead of retrying until the deadline", async () => {
  const clock = fakeClock();
  const { fetchFn, calls } = fakeAtlas(submitted, [() => new Response("no", { status: 401 })]);
  const result: AtlasCheckResult = await pollAtlasJob({ ...base, predictionId: "p", fetchFn, deadline: clock.now() + 30_000, now: clock.now, sleep: clock.sleep });
  assertEquals(result.ok === false && result.kind, "provider_rejected");
  assertEquals(calls.length, 1);
  assertEquals(clock.sleeps, []);
});

Deno.test("poll: transient errors are retried within the deadline", async () => {
  const clock = fakeClock();
  const flaky = () => new Response("oops", { status: 500 });
  const { fetchFn } = fakeAtlas(submitted, [flaky, flaky, completed()]);
  const result = await pollAtlasJob({ ...base, predictionId: "p", fetchFn, deadline: clock.now() + 30_000, now: clock.now, sleep: clock.sleep });
  assertEquals(result.ok && result.state, "done");
});
