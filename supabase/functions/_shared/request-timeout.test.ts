import { assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
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
