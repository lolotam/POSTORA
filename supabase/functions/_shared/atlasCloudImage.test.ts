import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runAtlasImageModel } from "./atlasCloudImage.ts";

type Call = { url: string; method: string; auth: string | null; body: unknown };

/** A fake AtlasCloud: `submit` answers the POST, `polls` answer the GETs in order (the last repeats). */
function fakeAtlas(submit: () => Response | Promise<Response>, polls: Array<() => Response>) {
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
const completed = () => json({ data: { status: "completed", outputs: ["https://cdn.example/out.png"] } });
const noSleep = () => Promise.resolve();

const base = { apiKey: "atlas-secret", body: { model: "m", image: "https://x/y.png" }, sleep: noSleep, pollIntervalMs: 1 };

Deno.test("submits the body with the bearer key, polls the prediction, returns the first output", async () => {
  const { fetchFn, calls } = fakeAtlas(submitted, [pending, pending, completed]);
  const result = await runAtlasImageModel({ ...base, fetchFn });
  assertEquals(result, { ok: true, outputUrl: "https://cdn.example/out.png", predictionId: "pred-1" });
  assertEquals(calls[0], {
    url: "https://api.atlascloud.ai/api/v1/model/generateImage",
    method: "POST",
    auth: "Bearer atlas-secret",
    body: { model: "m", image: "https://x/y.png" },
  });
  assertEquals(calls.slice(1).map((c) => c.url), Array(3).fill("https://api.atlascloud.ai/api/v1/model/prediction/pred-1"));
  assertEquals(calls[1].auth, "Bearer atlas-secret");
});

Deno.test("an exhausted balance is the operator's problem: provider_rejected, answered as 503", async () => {
  for (const response of [() => new Response("insufficient_balance", { status: 402 }), () => json({ message: "Insufficient balance" }, 400)]) {
    const result = await runAtlasImageModel({ ...base, fetchFn: fakeAtlas(response, []).fetchFn });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.kind, "provider_rejected");
      assertEquals(result.httpStatus, 503);
    }
  }
});

Deno.test("a rejected provider key is provider_rejected (503), never a 401 for the caller", async () => {
  const result = await runAtlasImageModel({ ...base, fetchFn: fakeAtlas(() => new Response("bad key", { status: 401 }), []).fetchFn });
  assertEquals(result.ok === false && [result.kind, result.httpStatus], ["provider_rejected", 503]);
});

Deno.test("a rate limit is passed on as 429", async () => {
  const result = await runAtlasImageModel({ ...base, fetchFn: fakeAtlas(() => new Response("slow down", { status: 429 }), []).fetchFn });
  assertEquals(result.ok === false && [result.kind, result.httpStatus], ["rate_limited", 429]);
});

Deno.test("a balance message inside an HTTP 200 body is also provider_rejected", async () => {
  const result = await runAtlasImageModel({ ...base, fetchFn: fakeAtlas(() => json({ code: 400, message: "Not enough credit" }), []).fetchFn });
  assertEquals(result.ok === false && result.kind, "provider_rejected");
});

Deno.test("a submit answer without a prediction id is a bad_response", async () => {
  const result = await runAtlasImageModel({ ...base, fetchFn: fakeAtlas(() => json({ code: 200, data: {} }), []).fetchFn });
  assertEquals(result.ok === false && [result.kind, result.httpStatus], ["bad_response", 502]);
});

Deno.test("a failed prediction reports failed (502) and keeps the provider's reason for the log only", async () => {
  const failed = () => json({ data: { status: "failed", error: "unsupported image" } });
  const result = await runAtlasImageModel({ ...base, fetchFn: fakeAtlas(submitted, [pending, failed]).fetchFn });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals([result.kind, result.httpStatus], ["failed", 502]);
    assertEquals(result.detail.includes("unsupported image"), true);
  }
});

Deno.test("a prediction that never finishes times out (504) after the poll budget", async () => {
  const { fetchFn, calls } = fakeAtlas(submitted, [pending]);
  const result = await runAtlasImageModel({ ...base, fetchFn, maxPolls: 4 });
  assertEquals(result.ok === false && [result.kind, result.httpStatus], ["timeout", 504]);
  assertEquals(calls.filter((c) => c.method === "GET").length, 4);
});

Deno.test("a poll that errors is retried instead of failing the job", async () => {
  const flaky = () => new Response("oops", { status: 500 });
  const result = await runAtlasImageModel({ ...base, fetchFn: fakeAtlas(submitted, [flaky, completed]).fetchFn });
  assertEquals(result.ok, true);
});

Deno.test("a completed prediction whose output is not an https URL is a bad_response", async () => {
  const insecure = () => json({ data: { status: "completed", outputs: ["http://internal.example/out.png"] } });
  const result = await runAtlasImageModel({ ...base, fetchFn: fakeAtlas(submitted, [insecure]).fetchFn });
  assertEquals(result.ok === false && result.kind, "bad_response");
});

Deno.test("an unreachable provider is unreachable (502), not a crash", async () => {
  const fetchFn = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
  const result = await runAtlasImageModel({ ...base, fetchFn });
  assertEquals(result.ok === false && [result.kind, result.httpStatus], ["unreachable", 502]);
});
