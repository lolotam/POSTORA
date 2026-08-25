// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyMime,
  understandInboundMedia,
  type UnderstandingLimits,
} from "./inboundMediaUnderstanding.ts";

const LIMITS: UnderstandingLimits = { maxBytes: 1024, timeoutMs: 50 };
const AUDIO = new Uint8Array([1, 2, 3, 4]);

function geminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

Deno.test("classifyMime maps WhatsApp voice notes, which arrive with a codecs parameter", () => {
  assertEquals(classifyMime("audio/ogg; codecs=opus"), "audio");
  assertEquals(classifyMime("image/jpeg"), "image");
  assertEquals(classifyMime("application/pdf"), null);
  assertEquals(classifyMime(null), null);
});

Deno.test("audio transcribes through Gemini and returns the text verbatim", async () => {
  const outcome = await understandInboundMedia(
    AUDIO, "audio", "audio/ogg; codecs=opus", { limits: LIMITS, geminiKey: "k", fetcher: () => Promise.resolve(geminiResponse("متى موعد الدفع؟")) },
  );
  assert(outcome.ok);
  assertEquals(outcome.result.text, "متى موعد الدفع؟");
  assertEquals(outcome.result.provider, "gemini");
});

Deno.test("the bare mime type is sent upstream — Gemini rejects a codecs parameter", async () => {
  let sentMime = "";
  await understandInboundMedia(
    AUDIO, "audio", "audio/ogg; codecs=opus", { limits: LIMITS,
      geminiKey: "k",
      fetcher: (_url, init) => {
        sentMime = JSON.parse(String(init?.body)).contents[0].parts[1].inline_data.mime_type;
        return Promise.resolve(geminiResponse("ok"));
      },
    },
  );
  assertEquals(sentMime, "audio/ogg");
});

Deno.test("an image returns description plus OCR, and structured fields when present", async () => {
  const payload = JSON.stringify({
    description: "A KNET payment receipt",
    text: "KD 250.000",
    fields: { amount: "250.000", currency: "KWD" },
  });
  const outcome = await understandInboundMedia(
    new Uint8Array([9]), "image", "image/jpeg", { limits: LIMITS, geminiKey: "k", fetcher: () => Promise.resolve(geminiResponse(payload)) },
  );
  assert(outcome.ok);
  assert(outcome.result.text.includes("A KNET payment receipt"));
  assert(outcome.result.text.includes("KD 250.000"));
  assertEquals(outcome.result.extracted_data?.currency, "KWD");
});

Deno.test("a fenced JSON block is still parsed — models add fences unprompted", async () => {
  const fenced = '```json\n{"description":"a broken tap","text":"","fields":{}}\n```';
  const outcome = await understandInboundMedia(
    new Uint8Array([9]), "image", "image/png", { limits: LIMITS, geminiKey: "k", fetcher: () => Promise.resolve(geminiResponse(fenced)) },
  );
  assert(outcome.ok);
  assertEquals(outcome.result.text, "a broken tap");
  assertEquals(outcome.result.extracted_data, undefined);
});

Deno.test("non-JSON image output degrades to the prose rather than failing", async () => {
  const outcome = await understandInboundMedia(
    new Uint8Array([9]), "image", "image/png", { limits: LIMITS, geminiKey: "k", fetcher: () => Promise.resolve(geminiResponse("just a photo of a door")) },
  );
  assert(outcome.ok);
  assertEquals(outcome.result.text, "just a photo of a door");
});

Deno.test("audio falls back to Whisper when Gemini fails", async () => {
  let calls = 0;
  const outcome = await understandInboundMedia(
    AUDIO, "audio", "audio/ogg", { limits: LIMITS,
      geminiKey: "k",
      openaiKey: "o",
      fetcher: (url) => {
        calls += 1;
        if (String(url).includes("generativelanguage")) {
          return Promise.resolve(new Response("boom", { status: 500 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ text: "fallback transcript" }), { status: 200 }),
        );
      },
    },
  );
  assert(outcome.ok);
  assertEquals(outcome.result.provider, "openai");
  assertEquals(calls, 2);
});

Deno.test("images have no Whisper fallback — Whisper cannot see", async () => {
  let whisperCalled = false;
  const outcome = await understandInboundMedia(
    new Uint8Array([9]), "image", "image/jpeg", { limits: LIMITS,
      geminiKey: "k",
      openaiKey: "o",
      fetcher: (url) => {
        if (String(url).includes("audio/transcriptions")) whisperCalled = true;
        return Promise.resolve(new Response("boom", { status: 500 }));
      },
    },
  );
  assert(!outcome.ok);
  assertEquals(outcome.reason, "provider_failed");
  assert(!whisperCalled);
});

Deno.test("oversized media is refused before any provider call", async () => {
  let called = false;
  const outcome = await understandInboundMedia(
    new Uint8Array(2048), "audio", "audio/ogg", { limits: LIMITS, geminiKey: "k", fetcher: () => { called = true; return Promise.resolve(geminiResponse("x")); } },
  );
  assert(!outcome.ok);
  assertEquals(outcome.reason, "too_large");
  assert(!called, "must not spend money on media it has already rejected");
});

Deno.test("empty media is refused", async () => {
  const outcome = await understandInboundMedia(
    new Uint8Array(0), "audio", "audio/ogg", { limits: LIMITS,  geminiKey: "k" },
  );
  assert(!outcome.ok);
  assertEquals(outcome.reason, "empty_media");
});

Deno.test("documents are declined explicitly rather than silently mishandled", async () => {
  const outcome = await understandInboundMedia(
    AUDIO, "document", "application/pdf", { limits: LIMITS,  geminiKey: "k" },
  );
  assert(!outcome.ok);
  assertEquals(outcome.reason, "unsupported_type");
});

Deno.test("no configured key reports no_provider, not a failure", async () => {
  const outcome = await understandInboundMedia(
    AUDIO, "audio", "audio/ogg", { limits: LIMITS,  geminiKey: null, openaiKey: null },
  );
  assert(!outcome.ok);
  assertEquals(outcome.reason, "no_provider");
});

Deno.test("a hung provider surfaces as timeout, never as a hang", async () => {
  const outcome = await understandInboundMedia(
    AUDIO, "audio", "audio/ogg", { limits: { maxBytes: 1024, timeoutMs: 20 },
      geminiKey: "k",
      fetcher: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    },
  );
  assert(!outcome.ok);
  assertEquals(outcome.reason, "timeout");
});

Deno.test("a large payload does not blow the stack during base64 encoding", async () => {
  // Guards the chunked encoder: fromCharCode(...bytes) overflows on a real voice note.
  const big = new Uint8Array(200_000).fill(65);
  const outcome = await understandInboundMedia(
    big, "audio", "audio/ogg", { limits: { maxBytes: 1_000_000, timeoutMs: 100 }, geminiKey: "k", fetcher: () => Promise.resolve(geminiResponse("ok")) },
  );
  assert(outcome.ok);
});
