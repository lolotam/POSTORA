import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readJsonBodyCapped } from "./cappedJsonBody.ts";

function streamed(text: string): Request {
  // A stream body carries no Content-Length, so only the byte count can stop it.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Request("https://x.test", { method: "POST", body });
}

Deno.test("parses a body under the cap", async () => {
  const result = await readJsonBodyCapped(new Request("https://x.test", { method: "POST", body: '{"a":1}' }), 64);
  assertEquals(result, { ok: true, value: { a: 1 } });
});

Deno.test("refuses a declared length over the cap before reading", async () => {
  const req = new Request("https://x.test", { method: "POST", body: "{}", headers: { "content-length": "999999" } });
  assertEquals(await readJsonBodyCapped(req, 64), { ok: false, reason: "too_large" });
});

Deno.test("refuses a streamed body that grows past the cap", async () => {
  assertEquals(await readJsonBodyCapped(streamed(`"${"x".repeat(200)}"`), 64), { ok: false, reason: "too_large" });
});

Deno.test("reports invalid JSON and a missing body", async () => {
  assertEquals(await readJsonBodyCapped(streamed("{not json"), 64), { ok: false, reason: "invalid_json" });
  assertEquals(await readJsonBodyCapped(new Request("https://x.test", { method: "POST" }), 64), { ok: false, reason: "invalid_json" });
});
