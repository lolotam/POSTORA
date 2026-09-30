import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchWithTimeout } from "./request-timeout.ts";

Deno.test("fetchWithTimeout aborts a stalled Meta request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;

  try {
    await assertRejects(
      () => fetchWithTimeout("https://graph.facebook.com/stalled", {}, 1),
      Error,
      "Request timed out",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("stalled injected fetcher with small timeout rejects Request timed out and aborts signal", async () => {
  let capturedInit: RequestInit | undefined;
  const stalledFetcher: typeof fetch = (_url, init) => {
    capturedInit = init;
    return new Promise<Response>(() => {});
  };

  await assertRejects(
    () =>
      fetchWithTimeout(
        "https://api.example.com/stalled",
        { method: "POST" },
        10,
        stalledFetcher,
      ),
    Error,
    "Request timed out",
  );

  assertEquals(capturedInit?.signal?.aborted, true);
});
