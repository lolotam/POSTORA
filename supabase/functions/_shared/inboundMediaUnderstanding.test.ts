// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyMime,
  DEFAULT_LIMITS,
  looksLikePdf,
  timeoutFor,
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
  assertEquals(classifyMime(null), null);
});

Deno.test("PDFs classify as documents; other office formats stay unsupported", () => {
  assertEquals(classifyMime("application/pdf"), "document");
  assertEquals(classifyMime("APPLICATION/PDF"), "document");
  // Word and PowerPoint are ZIP containers Gemini does not open. Admitting them would
  // trade a clear refusal for a confident answer about a document nothing read.
  assertEquals(classifyMime("application/msword"), null);
  assertEquals(
    classifyMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    null,
  );
  assertEquals(classifyMime("application/zip"), null);
});

Deno.test("only documents get the widened model deadline", () => {
  assertEquals(timeoutFor("document", DEFAULT_LIMITS), 20_000);
  assertEquals(timeoutFor("audio", DEFAULT_LIMITS), 10_000);
  assertEquals(timeoutFor("image", DEFAULT_LIMITS), 10_000);
  // Falls back rather than throwing when a caller supplies limits without the field.
  assertEquals(timeoutFor("document", { maxBytes: 1, timeoutMs: 7 }), 7);
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

Deno.test("a PDF is read by Gemini and its structured fields are kept", async () => {
  const outcome = await understandInboundMedia(
    AUDIO,
    "document",
    "application/pdf",
    {
      limits: LIMITS,
      geminiKey: "k",
      fetcher: () =>
        Promise.resolve(geminiResponse(JSON.stringify({
          description: "A rental invoice from Danat Al Mustaqbal.",
          text: "Invoice 1448O — KWD 250 due 2026-09-01",
          fields: { amount: 250, currency: "KWD", invoice_number: "1448O" },
        }))),
    },
  );
  assert(outcome.ok);
  assertEquals(outcome.result.kind, "document");
  assertEquals(outcome.result.provider, "gemini");
  // The OCR half is labelled for a document, not "Text in image".
  assert(outcome.result.text.includes("Document text: Invoice 1448O"));
  assertEquals(outcome.result.extracted_data?.invoice_number, "1448O");
});

Deno.test("a transcription-only ladder cannot claim a document", async () => {
  // ElevenLabs and Whisper are speech models. If they were allowed to consume a rung, a
  // configured STT ladder would starve the only provider that can actually read a PDF.
  const outcome = await understandInboundMedia(
    AUDIO,
    "document",
    "application/pdf",
    {
      limits: LIMITS,
      tiers: [
        { provider: "elevenlabs", model: "scribe_v2", apiKey: "e" },
        { provider: "openai", model: "whisper-1", apiKey: "o" },
      ],
      geminiKey: null,
      openaiKey: null,
      fetcher: () => Promise.reject(new Error("no provider should have been called")),
    },
  );
  assert(!outcome.ok);
  assertEquals(outcome.reason, "no_provider");
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

Deno.test("the admin ladder is honoured in order, ElevenLabs first", async () => {
  const hit: string[] = [];
  const outcome = await understandInboundMedia(AUDIO, "audio", "audio/ogg", {
    limits: LIMITS,
    tiers: [
      { provider: "elevenlabs", model: "eleven_scribe_v1", apiKey: "e" },
      { provider: "gemini", model: "gemini-2.5-flash-preview-native-audio", apiKey: "g" },
      { provider: "openai", model: "whisper-1", apiKey: "o" },
    ],
    fetcher: (url) => {
      hit.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ text: "من إيلفن لابس" }), { status: 200 }));
    },
  });
  assert(outcome.ok);
  assertEquals(outcome.result.provider, "elevenlabs");
  assertEquals(outcome.result.model, "eleven_scribe_v1");
  assertEquals(hit.length, 1, "must not call the lower tiers after a success");
  assert(hit[0].includes("elevenlabs.io"));
});

Deno.test("a failing primary falls through to gemini, then to whisper", async () => {
  const hit: string[] = [];
  const outcome = await understandInboundMedia(AUDIO, "audio", "audio/ogg", {
    limits: LIMITS,
    tiers: [
      { provider: "elevenlabs", model: "eleven_scribe_v1", apiKey: "e" },
      { provider: "gemini", model: "gem-audio", apiKey: "g" },
      { provider: "openai", model: "whisper-1", apiKey: "o" },
    ],
    fetcher: (url) => {
      hit.push(String(url));
      if (String(url).includes("openai.com")) {
        return Promise.resolve(new Response(JSON.stringify({ text: "last resort" }), { status: 200 }));
      }
      return Promise.resolve(new Response("boom", { status: 500 }));
    },
  });
  assert(outcome.ok);
  assertEquals(outcome.result.provider, "openai");
  assertEquals(hit.length, 3);
});

Deno.test("an image skips speech-only tiers instead of burning the ladder on them", async () => {
  // ElevenLabs and Whisper cannot see. If they consumed rungs, a receipt photo would fail
  // even though Gemini further down could read it.
  const hit: string[] = [];
  const payload = JSON.stringify({ description: "a KNET receipt", text: "KD 12", fields: {} });
  const outcome = await understandInboundMedia(new Uint8Array([9]), "image", "image/jpeg", {
    limits: LIMITS,
    tiers: [
      { provider: "elevenlabs", model: "eleven_scribe_v1", apiKey: "e" },
      { provider: "gemini", model: "gemini-2.5-flash", apiKey: "g" },
      { provider: "openai", model: "whisper-1", apiKey: "o" },
    ],
    fetcher: (url) => {
      hit.push(String(url));
      return Promise.resolve(geminiResponse(payload));
    },
  });
  assert(outcome.ok);
  assertEquals(outcome.result.provider, "gemini");
  assertEquals(hit.length, 1);
  assert(hit[0].includes("generativelanguage"));
});

Deno.test("a tier with no API key is dropped, not counted as a failure", async () => {
  const outcome = await understandInboundMedia(AUDIO, "audio", "audio/ogg", {
    limits: LIMITS,
    tiers: [
      { provider: "elevenlabs", model: "eleven_scribe_v1", apiKey: "" },
      { provider: "openai", model: "whisper-1", apiKey: "o" },
    ],
    fetcher: () => Promise.resolve(new Response(JSON.stringify({ text: "ok" }), { status: 200 })),
  });
  assert(outcome.ok);
  assertEquals(outcome.result.provider, "openai");
});

Deno.test("ElevenLabs sends the documented parameters and captures its metadata", async () => {
  let sentModel = "", tagEvents = "", granularity = "";
  const outcome = await understandInboundMedia(AUDIO, "audio", "audio/ogg; codecs=opus", {
    limits: LIMITS,
    tiers: [{ provider: "elevenlabs", model: "scribe_v2", apiKey: "e" }],
    fetcher: (_url, init) => {
      const form = init?.body as FormData;
      sentModel = String(form.get("model_id"));
      tagEvents = String(form.get("tag_audio_events"));
      granularity = String(form.get("timestamps_granularity"));
      return Promise.resolve(new Response(JSON.stringify({
        language_code: "ara",
        language_probability: 0.9955,
        audio_duration_secs: 6.1335,
        text: "كنت عايز أعرف الخدمات",
      }), { status: 200 }));
    },
  });
  assert(outcome.ok);
  assertEquals(sentModel, "scribe_v2");
  // Audio-event tags would reach the agent as if the customer had said them.
  assertEquals(tagEvents, "false");
  assertEquals(granularity, "none");
  assertEquals(outcome.result.language_code, "ara");
  assertEquals(outcome.result.confidence, 0.9955);
  assertEquals(outcome.result.duration_seconds, 6.1335);
});

Deno.test("a multi-channel ElevenLabs response is read rather than treated as empty", async () => {
  const outcome = await understandInboundMedia(AUDIO, "audio", "audio/ogg", {
    limits: LIMITS,
    tiers: [{ provider: "elevenlabs", model: "scribe_v2", apiKey: "e" }],
    fetcher: () =>
      Promise.resolve(new Response(JSON.stringify({
        transcripts: [{ text: "channel one", language_code: "eng", language_probability: 0.9 }],
      }), { status: 200 })),
  });
  assert(outcome.ok);
  assertEquals(outcome.result.text, "channel one");
});

Deno.test("looksLikePdf reads the bytes, not a label", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assert(looksLikePdf(enc("%PDF-1.7\n1 0 obj")));
  // A .docx and a .pptx are ZIP containers.
  assert(!looksLikePdf(new Uint8Array([0x50, 0x4b, 0x03, 0x04])));
  assert(!looksLikePdf(enc("<!doctype html>")));
  assert(!looksLikePdf(new Uint8Array()));
  // Truncated magic must not match.
  assert(!looksLikePdf(enc("%PDF")));
  // The magic anywhere but offset zero does not count. Five ordinary bytes are trivial for
  // a sender to place inside a ZIP directory, and the point of this check is that the
  // sender has no say in it.
  assert(!looksLikePdf(enc(" %PDF-1.4")));
  assert(!looksLikePdf(enc(`${" ".repeat(200)}%PDF-1.4`)));
  const zipCarryingTheMagic = new Uint8Array([
    0x50, 0x4b, 0x03, 0x04,
    ...enc("%PDF-1.7"),
  ]);
  assert(!looksLikePdf(zipCarryingTheMagic));
});
