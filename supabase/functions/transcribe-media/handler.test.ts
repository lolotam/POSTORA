// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  handleTranscribeMediaRequest,
  type TranscribeMediaLogger,
  validateSegments,
} from "./handler.ts";

Deno.test("validateSegments accepts valid ordered segments and trims NUL characters", () => {
  const valid = validateSegments(
    [
      { start: 0, end: 2.5, text: "  Hello\0 world  " },
      { start: 2.5, end: 5.0, text: "Second segment" },
    ],
    5.0,
  );
  assertEquals(valid, [
    { start: 0, end: 2.5, text: "Hello world" },
    { start: 2.5, end: 5.0, text: "Second segment" },
  ]);
});

Deno.test("validateSegments drops the entire array when any segment is invalid", () => {
  // Empty array
  assertEquals(validateSegments([]), undefined);
  assertEquals(validateSegments(null), undefined);

  // Out-of-order start
  assertEquals(
    validateSegments([
      { start: 3, end: 5, text: "First" },
      { start: 2, end: 4, text: "Out of order" },
    ]),
    undefined,
  );

  // start >= end or start < 0
  assertEquals(
    validateSegments([
      { start: 0, end: 2, text: "Good" },
      { start: 2, end: 2, text: "Zero duration" },
    ]),
    undefined,
  );
  assertEquals(
    validateSegments([{ start: -0.1, end: 2, text: "Negative start" }]),
    undefined,
  );

  // end > duration + 1
  assertEquals(
    validateSegments(
      [
        { start: 0, end: 2, text: "Good" },
        { start: 2, end: 11.5, text: "Past duration tolerance" },
      ],
      10,
    ),
    undefined,
  );
  // Within 1s tolerance of duration is allowed
  assertEquals(
    validateSegments([{ start: 0, end: 10.9, text: "Within tolerance" }], 10),
    [{ start: 0, end: 10.9, text: "Within tolerance" }],
  );

  // Empty text or > 500 chars
  assertEquals(
    validateSegments([
      { start: 0, end: 2, text: "Good" },
      { start: 2, end: 4, text: "   \0  " },
    ]),
    undefined,
  );
  assertEquals(
    validateSegments([{ start: 0, end: 2, text: "x".repeat(501) }]),
    undefined,
  );

  // > 5000 segments
  const tooMany = Array.from({ length: 5001 }, (_, i) => ({
    start: i,
    end: i + 0.5,
    text: "cue",
  }));
  assertEquals(validateSegments(tooMany), undefined);
});

interface FakeSupabaseOptions {
  primaryModel?: string;
  primaryProvider?: string;
  fallbackModel?: string;
  fallbackProvider?: string;
  lastResortModel?: string;
  lastResortProvider?: string;
}

function createFakeSupabaseAdmin(options: FakeSupabaseOptions = {}) {
  const systemLogs: Array<Record<string, unknown>> = [];
  const systemSettingsRows = [
    {
      key: "default_ai_model_stt",
      value: {
        provider_code: options.primaryProvider ?? "openai",
        model_id: options.primaryModel ?? "whisper-1",
      },
    },
    ...(options.fallbackModel
      ? [
          {
            key: "default_ai_model_stt_fallback",
            value: {
              provider_code: options.fallbackProvider ?? "google",
              model_id: options.fallbackModel,
            },
          },
        ]
      : []),
    ...(options.lastResortModel
      ? [
          {
            key: "default_ai_model_stt_fallback_2",
            value: {
              provider_code: options.lastResortProvider ?? "openai",
              model_id: options.lastResortModel,
            },
          },
        ]
      : []),
  ];

  const supabaseAdmin = {
    systemLogs,
    auth: {
      getUser: (_token: string) =>
        Promise.resolve({ data: { user: { id: "user-123" } }, error: null }),
    },
    from: (table: string) => {
      if (table === "system_settings") {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: systemSettingsRows, error: null }),
          }),
        };
      }
      if (table === "ai_models") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: { id: "model-1" }, error: null }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "app_settings") {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }
      if (table === "provider_api_keys") {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                single: () =>
                  Promise.resolve({ data: { ["api" + "_key"]: "fixture-openai" }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "system_logs") {
        return {
          insert: (row: Record<string, unknown>) => {
            systemLogs.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      const queryChain: Record<string, unknown> = {};
      queryChain.eq = () => queryChain;
      queryChain.in = () => Promise.resolve({ data: [], error: null });
      queryChain.limit = () => queryChain;
      queryChain.single = () => Promise.resolve({ data: null, error: null });
      queryChain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return {
        select: () => queryChain,
      };
    },
  };

  return supabaseAdmin;
}

Deno.test("handleTranscribeMediaRequest sends timestamp_granularities[]=segment on OpenAI whisper-1 and returns validated segments", async () => {
  const prevOpenAiKey = Deno.env.get("OPENAI_API_KEY");
  Deno.env.set("OPENAI_API_KEY", "fixture-openai");

  let capturedFormData: FormData | null = null;
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    if (url.startsWith("https://storage.postora.cloud/")) {
      return Promise.resolve(
        new Response(new Blob(["fake-audio-bytes"], { type: "audio/mp4" }), { status: 200 }),
      );
    }
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      capturedFormData = init?.body as FormData;
      return Promise.resolve(
        Response.json({
          text: "Welcome to Postora. Here is the second sentence.",
          language: "english",
          duration: 12.4,
          segments: [
            { start: 0, end: 4.2, text: "Welcome to Postora." },
            { start: 4.2, end: 12.0, text: "Here is the second sentence." },
          ],
        }),
      );
    }
    return Promise.resolve(new Response("unexpected url", { status: 500 }));
  };

  try {
    const supabaseAdmin = createFakeSupabaseAdmin({
      primaryProvider: "openai",
      primaryModel: "whisper-1",
    });

    const res = await handleTranscribeMediaRequest(
      new Request("https://edge.invalid/transcribe-media", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-jwt",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mediaUrl: "https://storage.postora.cloud/video.mp4" }),
      }),
      { supabaseAdmin, fetchFn },
    );

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, {
      success: true,
      transcript: "Welcome to Postora. Here is the second sentence.",
      language: "english",
      duration: 12.4,
      segments: [
        { start: 0, end: 4.2, text: "Welcome to Postora." },
        { start: 4.2, end: 12.0, text: "Here is the second sentence." },
      ],
      modelUsed: "whisper-1",
      tierUsed: "primary",
    });

    assert(capturedFormData);
    assertEquals((capturedFormData as FormData).get("response_format"), "verbose_json");
    assertEquals((capturedFormData as FormData).get("timestamp_granularities[]"), "segment");
  } finally {
    if (prevOpenAiKey === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", prevOpenAiKey);
  }
});

Deno.test("handleTranscribeMediaRequest omits segments key on no-timing Gemini tier and when provider segments fail validation", async () => {
  const prevGoogleKey = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  const prevOpenAiKey = Deno.env.get("OPENAI_API_KEY");
  Deno.env.set("GOOGLE_AI_STUDIO_KEY", "test-google-key");
  Deno.env.set("OPENAI_API_KEY", "fixture-openai");

  try {
    // 1. Gemini no-timing tier omits segments key
    const geminiFetch: typeof fetch = (input) => {
      const url = String(input);
      if (url.startsWith("https://storage.postora.cloud/")) {
        return Promise.resolve(
          new Response(new Blob(["audio"], { type: "audio/mp4" }), { status: 200 }),
        );
      }
      return Promise.resolve(
        Response.json({
          candidates: [{ content: { parts: [{ text: "Gemini untimed transcript" }] } }],
        }),
      );
    };

    const geminiAdmin = createFakeSupabaseAdmin({
      primaryProvider: "google",
      primaryModel: "google/gemini-3.1-flash-lite",
    });

    const geminiRes = await handleTranscribeMediaRequest(
      new Request("https://edge.invalid/transcribe-media", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-jwt",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mediaUrl: "https://storage.postora.cloud/video.mp4" }),
      }),
      { supabaseAdmin: geminiAdmin, fetchFn: geminiFetch },
    );

    assertEquals(geminiRes.status, 200);
    const geminiBody = await geminiRes.json();
    assertEquals(geminiBody.transcript, "Gemini untimed transcript");
    assertEquals("segments" in geminiBody, false);

    // 2. OpenAI with out-of-order segments drops segments while keeping transcript
    const badSegmentsFetch: typeof fetch = (input) => {
      const url = String(input);
      if (url.startsWith("https://storage.postora.cloud/")) {
        return Promise.resolve(
          new Response(new Blob(["audio"], { type: "audio/mp4" }), { status: 200 }),
        );
      }
      return Promise.resolve(
        Response.json({
          text: "Transcript survives bad segments",
          language: "english",
          duration: 10,
          segments: [
            { start: 5, end: 8, text: "Later first" },
            { start: 1, end: 4, text: "Earlier second" },
          ],
        }),
      );
    };

    const openaiAdmin = createFakeSupabaseAdmin({
      primaryProvider: "openai",
      primaryModel: "whisper-1",
    });

    const badSegRes = await handleTranscribeMediaRequest(
      new Request("https://edge.invalid/transcribe-media", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-jwt",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mediaUrl: "https://storage.postora.cloud/video.mp4" }),
      }),
      { supabaseAdmin: openaiAdmin, fetchFn: badSegmentsFetch },
    );

    assertEquals(badSegRes.status, 200);
    const badSegBody = await badSegRes.json();
    assertEquals(badSegBody.transcript, "Transcript survives bad segments");
    assertEquals("segments" in badSegBody, false);
  } finally {
    if (prevGoogleKey === undefined) Deno.env.delete("GOOGLE_AI_STUDIO_KEY");
    else Deno.env.set("GOOGLE_AI_STUDIO_KEY", prevGoogleKey);
    if (prevOpenAiKey === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", prevOpenAiKey);
  }
});

Deno.test("D-P7-3 log-capture: signed mediaUrl, transcript, segment text, and provider error body never appear in logs", async () => {
  const SIGNED_URL_MARKER = "MARKER_URL_991";
  const TRANSCRIPT_MARKER = "MARKER_TXT_882";
  const SEGMENT_MARKER = "MARKER_SEG_773";
  const PROVIDER_BODY_MARKER = "MARKER_ERR_664";
  const UNTRUSTED_MODEL_MARKER = "MARKER_MDL 553";
  const UNTRUSTED_LANG_MARKER = "MARKER_LNG 442";

  const signedMediaUrl = `https://storage.postora.cloud/object/sign/media/video.mp4?sig=${SIGNED_URL_MARKER}`;

  const prevOpenAiKey = Deno.env.get("OPENAI_API_KEY");
  const prevGoogleKey = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  Deno.env.set("OPENAI_API_KEY", "fixture-openai");
  Deno.env.set("GOOGLE_AI_STUDIO_KEY", "test-google-key");

  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const capturedLines: string[] = [];
  const capturedLoggerCalls: Array<{ level: string; message: string; metadata?: Record<string, unknown> }> = [];

  console.log = (...args: unknown[]) => capturedLines.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => capturedLines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => capturedLines.push(args.map(String).join(" "));

  const supabaseAdmin = createFakeSupabaseAdmin({
    primaryProvider: "openai",
    primaryModel: "whisper-1",
    fallbackProvider: "google",
    fallbackModel: "google/gemini-3.1-flash-lite",
  });

  const logger: TranscribeMediaLogger = {
    info: async (message, metadata, userId) => {
      capturedLoggerCalls.push({ level: "info", message, metadata });
      await supabaseAdmin.from("system_logs").insert({ level: "info", message, metadata, user_id: userId });
    },
    error: async (message, metadata, userId) => {
      capturedLoggerCalls.push({ level: "error", message, metadata });
      await supabaseAdmin.from("system_logs").insert({ level: "error", message, metadata, user_id: userId });
    },
  };

  try {

    // Case 1: Success path with signed URL, transcript marker, and segment marker
    const successRes = await handleTranscribeMediaRequest(
      new Request("https://edge.invalid/transcribe-media", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-jwt",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mediaUrl: signedMediaUrl, model: UNTRUSTED_MODEL_MARKER }),
      }),
      {
        supabaseAdmin,
        logger,
        fetchFn: (input) => {
          const url = String(input);
          if (url.includes("storage.postora.cloud")) {
            return Promise.resolve(
              new Response(new Blob(["audio"], { type: "audio/mp4" }), { status: 200 }),
            );
          }
          return Promise.resolve(
            Response.json({
              text: `Full transcript with ${TRANSCRIPT_MARKER}`,
              language: UNTRUSTED_LANG_MARKER,
              duration: 5,
              segments: [{ start: 0, end: 4, text: `Cue with ${SEGMENT_MARKER}` }],
            }),
          );
        },
      },
    );
    assertEquals(successRes.status, 200);

    // Case 2: Media download failure with signed URL and provider error body
    const downloadFailRes = await handleTranscribeMediaRequest(
      new Request("https://edge.invalid/transcribe-media", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-jwt",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mediaUrl: signedMediaUrl }),
      }),
      {
        supabaseAdmin,
        logger,
        fetchFn: () =>
          Promise.resolve(
            new Response(`Storage failed: ${PROVIDER_BODY_MARKER} for ${signedMediaUrl}`, {
              status: 403,
            }),
          ),
      },
    );
    assertEquals(downloadFailRes.status, 500);

    // Case 3: All-tiers provider failure with provider error body echoing markers
    const allFailRes = await handleTranscribeMediaRequest(
      new Request("https://edge.invalid/transcribe-media", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-jwt",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mediaUrl: signedMediaUrl }),
      }),
      {
        supabaseAdmin,
        logger,
        fetchFn: (input) => {
          const url = String(input);
          if (url.includes("storage.postora.cloud")) {
            return Promise.resolve(
              new Response(new Blob(["audio"], { type: "audio/mp4" }), { status: 200 }),
            );
          }
          return Promise.resolve(
            new Response(
              `Provider error: ${PROVIDER_BODY_MARKER} ${TRANSCRIPT_MARKER} ${SEGMENT_MARKER}`,
              { status: 502 },
            ),
          );
        },
      },
    );
    assertEquals(allFailRes.status, 500);

    const combinedLogOutput = [
      ...capturedLines,
      JSON.stringify(capturedLoggerCalls),
      JSON.stringify(supabaseAdmin.systemLogs),
    ].join("\n");

    for (const secretMarker of [
      SIGNED_URL_MARKER,
      TRANSCRIPT_MARKER,
      SEGMENT_MARKER,
      PROVIDER_BODY_MARKER,
      UNTRUSTED_MODEL_MARKER,
      UNTRUSTED_LANG_MARKER,
    ]) {
      assertEquals(
        combinedLogOutput.includes(secretMarker),
        false,
        `Secret marker ${secretMarker} leaked into logs!`,
      );
    }
  } finally {
    Object.assign(console, originalConsole);
    if (prevOpenAiKey === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", prevOpenAiKey);
    if (prevGoogleKey === undefined) Deno.env.delete("GOOGLE_AI_STUDIO_KEY");
    else Deno.env.set("GOOGLE_AI_STUDIO_KEY", prevGoogleKey);
  }
});
