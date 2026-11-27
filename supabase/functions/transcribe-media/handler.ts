// deno-lint-ignore-file no-explicit-any no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchCategoryAiSettings } from "../_shared/ai-fallback.ts";
import { createLogger } from "../_shared/logging.ts";
import { resolveVercelKey, vercelTranscribe } from "../_shared/vercelGateway.ts";
import type { TranscriptSegment } from "../_shared/youtubeTranscriptFormats.ts";
import { sttLastResort, sttProviderFor } from "./sttProvider.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export interface TranscriptionResult {
  transcript: string;
  language: string;
  duration: number;
  segments?: TranscriptSegment[];
}

export interface TranscriptionTierResult {
  tier: string;
  model: string;
  success: boolean;
  error_code?: string;
  http_status?: number;
}

export interface TranscribeMediaLogger {
  info: (message: string, metadata?: Record<string, unknown>, user_id?: string) => Promise<void> | void;
  error: (message: string, metadata?: Record<string, unknown>, user_id?: string) => Promise<void> | void;
}

export interface TranscribeMediaDeps {
  supabaseAdmin?: any;
  fetchFn?: typeof fetch;
  logger?: TranscribeMediaLogger;
  vercelTranscribeFn?: (apiKey: string, modelId: string, audio: Uint8Array) => Promise<TranscriptionResult>;
}

const MAX_SEGMENTS = 5000;
const MAX_SEGMENT_TEXT_LENGTH = 500;

export function validateSegments(
  rawSegments: unknown,
  durationSeconds?: number,
): TranscriptSegment[] | undefined {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0 || rawSegments.length > MAX_SEGMENTS) {
    return undefined;
  }

  const checkDuration =
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0;
  const maxEnd = checkDuration ? durationSeconds + 1 : Infinity;

  const validated: TranscriptSegment[] = [];
  let prevStart = 0;

  for (const item of rawSegments) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const start = record.start;
    const end = record.end;
    const rawText = record.text;

    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      start >= end ||
      start < prevStart ||
      end > maxEnd ||
      typeof rawText !== "string"
    ) {
      return undefined;
    }

    const text = rawText.replace(/\0/g, "").trim();
    if (text.length < 1 || text.length > MAX_SEGMENT_TEXT_LENGTH) {
      return undefined;
    }

    validated.push({ start, end, text });
    prevStart = start;
  }

  return validated;
}

export function supportsOpenAiSegmentTimestamps(model: string): boolean {
  const normalized = model.trim().toLowerCase().replace(/^openai\//, "");
  return normalized === "whisper-1";
}

function classifyHttpErrorCode(httpStatus: number): string {
  if (httpStatus === 0) return "configuration_error";
  if (httpStatus === 401 || httpStatus === 403) return "auth_error";
  if (httpStatus === 404) return "not_found";
  if (httpStatus === 408 || httpStatus === 504) return "timeout";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus >= 500) return "provider_error";
  return "request_failed";
}

/** Structured error with sanitized status and code for logging (never carries URLs or response bodies). */
export class TranscriptionApiError extends Error {
  errorCode: string;
  httpStatus: number;

  constructor(message: string, errorCode: string, httpStatus: number) {
    super(message);
    this.name = "TranscriptionApiError";
    this.errorCode = errorCode;
    this.httpStatus = httpStatus;
  }
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore stream cancellation failure
  }
}

async function downloadMedia(mediaUrl: string, fetchFn: typeof fetch): Promise<Blob> {
  let res: Response;
  try {
    res = await fetchFn(mediaUrl);
  } catch {
    throw new TranscriptionApiError(
      "Failed to download media: network_error",
      "media_download_failure",
      0,
    );
  }
  if (!res.ok) {
    await discardBody(res);
    throw new TranscriptionApiError(
      `Failed to download media: ${res.status}`,
      "media_download_failure",
      res.status,
    );
  }
  return res.blob();
}

async function getOpenAIKeyFromDB(supabaseAdmin: any): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("provider_api_keys")
      .select("api_key")
      .eq("provider_code", "openai")
      .limit(1)
      .single();
    return data?.api_key || null;
  } catch {
    return null;
  }
}

const OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEEPGRAM_ENDPOINT = "https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true";
const GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

async function transcribeWithOpenAI(
  audioBlob: Blob,
  model: string,
  fetchFn: typeof fetch,
  supabaseAdmin?: any,
): Promise<TranscriptionResult> {
  let openaiKey = Deno.env.get("OPENAIAPIKEY") || Deno.env.get("OPENAI_API_KEY");

  if (!openaiKey && supabaseAdmin) {
    openaiKey = (await getOpenAIKeyFromDB(supabaseAdmin)) || undefined;
  }

  if (!openaiKey) {
    throw new TranscriptionApiError(
      "OpenAI API key not configured",
      "configuration_error",
      0,
    );
  }

  const requestSegments = supportsOpenAiSegmentTimestamps(model);
  const formData = new FormData();
  formData.append("file", audioBlob, "audio.mp4");
  formData.append("model", model);
  formData.append("response_format", "verbose_json");
  if (requestSegments) {
    formData.append("timestamp_granularities[]", "segment");
  }

  const res = await fetchFn(OPENAI_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: formData,
  });

  if (!res.ok) {
    await discardBody(res);
    const errorCode = classifyHttpErrorCode(res.status);
    console.error(`OpenAI transcription error (${model}): status=${res.status} code=${errorCode}`);
    throw new TranscriptionApiError(
      `OpenAI transcription error ${res.status}`,
      errorCode,
      res.status,
    );
  }

  const data = await res.json();
  const duration = typeof data.duration === "number" && Number.isFinite(data.duration) ? data.duration : 0;
  const segments = requestSegments ? validateSegments(data.segments, duration) : undefined;

  return {
    transcript: typeof data.text === "string" ? data.text : "",
    language: typeof data.language === "string" ? data.language : "unknown",
    duration,
    ...(segments ? { segments } : {}),
  };
}

async function transcribeWithDeepgram(
  audioBlob: Blob,
  fetchFn: typeof fetch,
): Promise<TranscriptionResult> {
  const dgKey = Deno.env.get("DEEPGRAM_API_KEY");
  if (!dgKey) {
    throw new TranscriptionApiError(
      "Deepgram API key not configured",
      "configuration_error",
      0,
    );
  }

  const res = await fetchFn(DEEPGRAM_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Token ${dgKey}`,
      "Content-Type": "audio/mp4",
    },
    body: audioBlob,
  });

  if (!res.ok) {
    await discardBody(res);
    const errorCode = classifyHttpErrorCode(res.status);
    console.error(`Deepgram error: status=${res.status} code=${errorCode}`);
    throw new TranscriptionApiError(
      `Deepgram error ${res.status}`,
      errorCode,
      res.status,
    );
  }

  const data = await res.json();
  return {
    transcript: data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "",
    language: data.results?.channels?.[0]?.detected_language || "unknown",
    duration: data.metadata?.duration || 0,
  };
}

async function transcribeWithGoogle(
  audioBlob: Blob,
  model = "gemini-3.1-flash-lite",
  fetchFn: typeof fetch,
): Promise<TranscriptionResult> {
  const googleKey = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!googleKey) {
    throw new TranscriptionApiError(
      "Google AI Studio key not configured",
      "configuration_error",
      0,
    );
  }

  const bytes = new Uint8Array(await audioBlob.arrayBuffer());
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const base64Media = btoa(binary);

  const mimeType = audioBlob.type || "audio/mp4";
  const endpoint = `${GOOGLE_ENDPOINT}/models/${model}:generateContent?key=${googleKey}`;

  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            text: "Transcribe this audio accurately. Return ONLY the transcript text, nothing else. Detect the language automatically.",
          },
          { inlineData: { mimeType, data: base64Media } },
        ],
      }],
    }),
  });

  if (!res.ok) {
    await discardBody(res);
    const errorCode = classifyHttpErrorCode(res.status);
    console.error(`Google transcription error: status=${res.status} code=${errorCode}`);
    throw new TranscriptionApiError(
      `Google transcription error ${res.status}`,
      errorCode,
      res.status,
    );
  }

  const data = await res.json();
  const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return { transcript, language: "auto", duration: 0 };
}

async function runTranscription(
  audioBlob: Blob,
  model: string,
  fetchFn: typeof fetch,
  supabaseAdmin?: any,
  provider?: string,
  vercelTranscribeFn = vercelTranscribe,
): Promise<TranscriptionResult> {
  if (provider === "vercel") {
    const apiKey = supabaseAdmin
      ? await resolveVercelKey(supabaseAdmin)
      : Deno.env.get("AI_GATEWAY_API_KEY");
    if (!apiKey) {
      throw new TranscriptionApiError(
        "Vercel AI Gateway key not configured",
        "configuration_error",
        0,
      );
    }
    return vercelTranscribeFn(apiKey, model, new Uint8Array(await audioBlob.arrayBuffer()));
  }
  if (model === "nova-3" || model === "deepgram/nova-3") {
    return transcribeWithDeepgram(audioBlob, fetchFn);
  }
  if (model.startsWith("gemini") || model.startsWith("google/")) {
    const geminiModel = model.replace(/^google\//, "");
    return transcribeWithGoogle(audioBlob, geminiModel, fetchFn);
  }
  const openaiModel = model.replace(/^openai\//, "");
  return transcribeWithOpenAI(audioBlob, openaiModel, fetchFn, supabaseAdmin);
}

function extractSanitizedErrorDetails(err: unknown): { errorCode: string; httpStatus?: number } {
  if (err instanceof TranscriptionApiError) {
    return {
      errorCode: err.errorCode,
      httpStatus: err.httpStatus,
    };
  }
  const errorName = err instanceof Error && err.name ? err.name : "unexpected_error";
  return { errorCode: errorName };
}

export async function handleTranscribeMediaRequest(
  req: Request,
  deps: TranscribeMediaDeps = {},
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  let supabaseAdmin: any = deps.supabaseAdmin ?? null;
  let userId: string | null = null;

  try {
    if (!supabaseAdmin) {
      supabaseAdmin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
    }
    const logger: TranscribeMediaLogger =
      deps.logger ?? createLogger(supabaseAdmin, "transcribe-media", "edge");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    userId = user.id;

    const { mediaUrl, model: requestedModel } = await req.json();
    if (!mediaUrl) {
      return new Response(JSON.stringify({ error: "mediaUrl required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sttSettings = await fetchCategoryAiSettings(supabaseAdmin, "stt");

    const { data: appSettingsRows } = await supabaseAdmin
      .from("app_settings")
      .select("key, value")
      .in("key", ["transcription_primary_model", "transcription_fallback_model"]);

    let primaryModel = sttSettings.primaryModel;
    let fallbackModel = sttSettings.fallbackModel;
    const { model: lastResortModel, provider: lastResortProvider } = sttLastResort(
      sttSettings.lastResortProvider,
      sttSettings.lastResortModel,
    );

    for (const row of appSettingsRows || []) {
      try {
        const val = typeof row.value === "string" ? JSON.parse(row.value as string) : row.value;
        if (row.key === "transcription_primary_model" && val) primaryModel = String(val);
        if (row.key === "transcription_fallback_model" && val) fallbackModel = String(val);
      } catch {
        /* an unreadable setting keeps the default model */
      }
    }

    if (requestedModel) primaryModel = requestedModel;

    const primaryProvider = sttProviderFor(
      primaryModel,
      sttSettings.primaryModel,
      sttSettings.primaryProvider,
    );
    const fallbackProvider = sttProviderFor(
      fallbackModel,
      sttSettings.fallbackModel,
      sttSettings.fallbackProvider,
    );

    console.log(
      `Transcription 3-tier: Primary=${primaryModel}, Fallback=${fallbackModel}, LastResort=${lastResortModel}`,
    );

    let audioBlob: Blob;
    try {
      audioBlob = await downloadMedia(mediaUrl, fetchFn);
    } catch (dlErr) {
      const details = extractSanitizedErrorDetails(dlErr);
      console.error(`Media download failed: code=${details.errorCode} status=${details.httpStatus ?? 0}`);

      await logger.error(
        `Media download failed (${details.errorCode})`,
        {
          feature: "transcription",
          error_type: "media_download_failure",
          error_code: details.errorCode,
          http_status: details.httpStatus,
          requested_model: requestedModel,
        },
        user.id,
      );

      throw dlErr;
    }

    const tiers: TranscriptionTierResult[] = [];
    let result: TranscriptionResult | null = null;

    // ── Tier 1: Primary ──
    try {
      console.log(`Tier 1 (primary): ${primaryModel}`);
      result = await runTranscription(
        audioBlob,
        primaryModel,
        fetchFn,
        supabaseAdmin,
        primaryProvider,
        deps.vercelTranscribeFn,
      );
      tiers.push({ tier: "primary", model: primaryModel, success: true });
    } catch (err) {
      const details = extractSanitizedErrorDetails(err);
      console.error(`Primary transcription failed: code=${details.errorCode} status=${details.httpStatus ?? 0}`);
      tiers.push({
        tier: "primary",
        model: primaryModel,
        success: false,
        error_code: details.errorCode,
        http_status: details.httpStatus,
      });
    }

    // ── Tier 2: Fallback ──
    if (!result && fallbackModel && fallbackModel !== primaryModel) {
      try {
        console.log(`Tier 2 (fallback): ${fallbackModel}`);
        result = await runTranscription(
          audioBlob,
          fallbackModel,
          fetchFn,
          supabaseAdmin,
          fallbackProvider,
          deps.vercelTranscribeFn,
        );
        tiers.push({ tier: "fallback", model: fallbackModel, success: true });
      } catch (err) {
        const details = extractSanitizedErrorDetails(err);
        console.error(`Fallback transcription failed: code=${details.errorCode} status=${details.httpStatus ?? 0}`);
        tiers.push({
          tier: "fallback",
          model: fallbackModel,
          success: false,
          error_code: details.errorCode,
          http_status: details.httpStatus,
        });
      }
    }

    // ── Tier 3: Last Resort (whisper-1, or the admin's Vercel model) ──
    if (!result && lastResortModel !== primaryModel && lastResortModel !== fallbackModel) {
      try {
        console.log(`Tier 3 (last_resort): ${lastResortModel}`);
        result = await runTranscription(
          audioBlob,
          lastResortModel,
          fetchFn,
          supabaseAdmin,
          lastResortProvider,
          deps.vercelTranscribeFn,
        );
        tiers.push({ tier: "last_resort", model: lastResortModel, success: true });
      } catch (err) {
        const details = extractSanitizedErrorDetails(err);
        console.error(`Last resort transcription failed: code=${details.errorCode} status=${details.httpStatus ?? 0}`);
        tiers.push({
          tier: "last_resort",
          model: lastResortModel,
          success: false,
          error_code: details.errorCode,
          http_status: details.httpStatus,
        });
      }
    }

    const tierUsed = tiers.find((t) => t.success)?.tier || "none";
    const modelUsed = tiers.find((t) => t.success)?.model || "none";

    const logFn = result ? logger.info : logger.error;
    await logFn(
      result
        ? `Transcription succeeded using ${modelUsed} (${tierUsed})`
        : `Transcription failed after all ${tiers.length} tiers`,
      {
        feature: "transcription",
        model_used: modelUsed,
        tier_used: tierUsed,
        success: !!result,
        has_segments: Boolean(result?.segments && result.segments.length > 0),
        language: result?.language,
        duration: result?.duration,
        tiers: Object.fromEntries(
          tiers.map((t) => [
            t.tier,
            {
              model: t.model,
              success: t.success,
              error_code: t.error_code,
              http_status: t.http_status,
            },
          ]),
        ),
        raw_details: {
          requested_model: requestedModel,
          primary_model: primaryModel,
          fallback_model: fallbackModel,
          last_resort_model: lastResortModel,
          tier_attempts: tiers.map((t) => ({
            tier: t.tier,
            model: t.model,
            success: t.success,
            error_code: t.error_code,
            http_status: t.http_status,
          })),
        },
      },
      user.id,
    );

    if (!result) {
      return new Response(
        JSON.stringify({ error: "All transcription tiers failed. Check API keys and models." }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        transcript: result.transcript,
        language: result.language,
        duration: result.duration,
        ...(result.segments ? { segments: result.segments } : {}),
        modelUsed,
        tierUsed,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    const details = extractSanitizedErrorDetails(error);
    console.error(`transcribe-media error: code=${details.errorCode} status=${details.httpStatus ?? 0}`);

    if (supabaseAdmin) {
      try {
        const outerLogger: TranscribeMediaLogger =
          deps.logger ?? createLogger(supabaseAdmin, "transcribe-media", "edge");
        await outerLogger.error(
          `Transcription unhandled error (${details.errorCode})`,
          {
            feature: "transcription",
            error_type: "unhandled_exception",
            error_code: details.errorCode,
            http_status: details.httpStatus,
          },
          userId || undefined,
        );
      } catch {
        console.error("CRITICAL: Failed to log transcription error to DB");
      }
    }

    const clientError =
      error instanceof TranscriptionApiError
        ? error.message
        : "Transcription failed";

    return new Response(JSON.stringify({ error: clientError }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
