import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchCategoryAiSettings, logAiCall } from "../_shared/ai-fallback.ts";
import { createLogger } from "../_shared/logging.ts";
import { resolveVercelKey, vercelTranscribe } from "../_shared/vercelGateway.ts";
import { sttLastResort, sttProviderFor } from "./sttProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface TranscriptionResult {
  transcript: string;
  language: string;
  duration: number;
}

interface TranscriptionTierResult {
  tier: string;
  model: string;
  success: boolean;
  error?: string;
  api_endpoint?: string;
  http_status?: number;
  error_response_body?: string;
}

/** Structured error with API details for logging */
class TranscriptionApiError extends Error {
  endpoint: string;
  httpStatus: number;
  responseBody: string;
  
  constructor(message: string, endpoint: string, httpStatus: number, responseBody: string) {
    super(message);
    this.name = "TranscriptionApiError";
    this.endpoint = endpoint;
    this.httpStatus = httpStatus;
    this.responseBody = responseBody.substring(0, 500);
  }
}

async function downloadMedia(mediaUrl: string): Promise<Blob> {
  const res = await fetch(mediaUrl);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TranscriptionApiError(
      `Failed to download media: ${res.status}`,
      mediaUrl,
      res.status,
      body
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

let _cachedDbOpenAIKey: string | null | undefined = undefined;

const OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEEPGRAM_ENDPOINT = "https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true";
const GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

async function transcribeWithOpenAI(audioBlob: Blob, model: string, supabaseAdmin?: any): Promise<TranscriptionResult> {
  let openaiKey = Deno.env.get("OPENAIAPIKEY") || Deno.env.get("OPENAI_API_KEY");
  
  if (!openaiKey && supabaseAdmin) {
    if (_cachedDbOpenAIKey === undefined) {
      _cachedDbOpenAIKey = await getOpenAIKeyFromDB(supabaseAdmin);
    }
    openaiKey = _cachedDbOpenAIKey || undefined;
  }
  
  if (!openaiKey) {
    throw new TranscriptionApiError(
      "OpenAI API key not configured (env + DB)",
      OPENAI_ENDPOINT,
      0,
      "No API key found in environment variables or provider_api_keys table"
    );
  }

  const formData = new FormData();
  formData.append("file", audioBlob, "audio.mp4");
  formData.append("model", model);
  formData.append("response_format", "verbose_json");

  const res = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`OpenAI transcription error (${model}):`, res.status, errText.substring(0, 200));
    throw new TranscriptionApiError(
      `OpenAI transcription error ${res.status}: ${errText.substring(0, 100)}`,
      OPENAI_ENDPOINT,
      res.status,
      errText
    );
  }

  const data = await res.json();
  return { transcript: data.text, language: data.language, duration: data.duration || 0 };
}

async function transcribeWithDeepgram(audioBlob: Blob): Promise<TranscriptionResult> {
  const dgKey = Deno.env.get("DEEPGRAM_API_KEY");
  if (!dgKey) {
    throw new TranscriptionApiError(
      "Deepgram API key not configured",
      DEEPGRAM_ENDPOINT,
      0,
      "No DEEPGRAM_API_KEY found in environment variables"
    );
  }

  const res = await fetch(DEEPGRAM_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Token ${dgKey}`,
      "Content-Type": "audio/mp4",
    },
    body: audioBlob,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Deepgram error:", res.status, errText.substring(0, 200));
    throw new TranscriptionApiError(
      `Deepgram error ${res.status}: ${errText.substring(0, 100)}`,
      DEEPGRAM_ENDPOINT,
      res.status,
      errText
    );
  }

  const data = await res.json();
  return {
    transcript: data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "",
    language: data.results?.channels?.[0]?.detected_language || "unknown",
    duration: data.metadata?.duration || 0,
  };
}

async function transcribeWithGoogle(audioBlob: Blob, model = "gemini-3.1-flash-lite"): Promise<TranscriptionResult> {
  const googleKey = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!googleKey) {
    throw new TranscriptionApiError(
      "Google AI Studio key not configured",
      GOOGLE_ENDPOINT,
      0,
      "No GOOGLE_AI_STUDIO_KEY found in environment variables"
    );
  }

  // Chunked base64 encoding to avoid stack overflow on large files
  const bytes = new Uint8Array(await audioBlob.arrayBuffer());
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const base64Media = btoa(binary);

  // Detect MIME type from blob or default to audio/mp4
  const mimeType = audioBlob.type || "audio/mp4";
  const endpoint = `${GOOGLE_ENDPOINT}/models/${model}:generateContent?key=${googleKey}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: "Transcribe this audio accurately. Return ONLY the transcript text, nothing else. Detect the language automatically." },
          { inlineData: { mimeType, data: base64Media } },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Google transcription error:", res.status, errText.substring(0, 200));
    throw new TranscriptionApiError(
      `Google transcription error ${res.status}: ${errText.substring(0, 100)}`,
      endpoint,
      res.status,
      errText
    );
  }

  const data = await res.json();
  const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return { transcript, language: "auto", duration: 0 };
}

/** Run transcription for a specific model name, optionally routed through a named provider */
async function runTranscription(audioBlob: Blob, model: string, supabaseAdmin?: any, provider?: string): Promise<TranscriptionResult> {
  if (provider === "vercel") {
    const apiKey = supabaseAdmin ? await resolveVercelKey(supabaseAdmin) : Deno.env.get("AI_GATEWAY_API_KEY");
    if (!apiKey) {
      throw new TranscriptionApiError(
        "Vercel AI Gateway key not configured",
        "https://ai-gateway.vercel.sh",
        0,
        "No AI_GATEWAY_API_KEY found in environment variables or provider_api_keys table"
      );
    }
    return vercelTranscribe(apiKey, model, new Uint8Array(await audioBlob.arrayBuffer()));
  }
  if (model === "nova-3" || model === "deepgram/nova-3") {
    return transcribeWithDeepgram(audioBlob);
  }
  if (model.startsWith("gemini") || model.startsWith("google/")) {
    const geminiModel = model.replace(/^google\//, "");
    return transcribeWithGoogle(audioBlob, geminiModel);
  }
  const openaiModel = model.replace(/^openai\//, "");
  return transcribeWithOpenAI(audioBlob, openaiModel, supabaseAdmin);
}

/** Extract structured error info from a caught error */
function extractErrorDetails(err: unknown): { message: string; endpoint?: string; httpStatus?: number; responseBody?: string } {
  if (err instanceof TranscriptionApiError) {
    return {
      message: err.message,
      endpoint: err.endpoint,
      httpStatus: err.httpStatus,
      responseBody: err.responseBody,
    };
  }
  return { message: (err as Error).message || String(err) };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // We need supabaseAdmin in the outer catch for logging, so declare early
  let supabaseAdmin: any = null;
  let userId: string | null = null;

  try {
    supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const logger = createLogger(supabaseAdmin, "transcribe-media", "edge");

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

    // Fetch STT category settings from system_settings (3-tier: primary, fallback, last_resort)
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
      } catch { /* an unreadable setting keeps the default model */ }
    }

    if (requestedModel) primaryModel = requestedModel;

    // Only forward a provider when the resolved model is still the one sttSettings configured —
    // an app_settings or requestedModel override changes `model` away from `settingsModel`, and
    // sttProviderFor treats that as "no provider" so today's model-name-only routing is unchanged.
    const primaryProvider = sttProviderFor(primaryModel, sttSettings.primaryModel, sttSettings.primaryProvider);
    const fallbackProvider = sttProviderFor(fallbackModel, sttSettings.fallbackModel, sttSettings.fallbackProvider);

    console.log(`Transcription 3-tier: Primary=${primaryModel}, Fallback=${fallbackModel}, LastResort=${lastResortModel}`);

    // Download media with dedicated error logging
    let audioBlob: Blob;
    try {
      audioBlob = await downloadMedia(mediaUrl);
    } catch (dlErr) {
      const details = extractErrorDetails(dlErr);
      console.error("Media download failed:", details.message);
      
      // Log download failure to system_logs
      await logger.error(`Media download failed: ${details.message}`, {
        feature: "transcription",
        error_type: "media_download_failure",
        media_url: mediaUrl,
        requested_model: requestedModel,
        raw_details: {
          error_message: details.message,
          api_endpoint: details.endpoint || mediaUrl,
          http_status: details.httpStatus,
          error_response_body: details.responseBody,
        },
      }, user.id);
      
      throw dlErr;
    }

    const tiers: TranscriptionTierResult[] = [];
    let result: TranscriptionResult | null = null;

    // ── Tier 1: Primary ──
    try {
      console.log(`Tier 1 (primary): ${primaryModel}`);
      result = await runTranscription(audioBlob, primaryModel, supabaseAdmin, primaryProvider);
      tiers.push({ tier: "primary", model: primaryModel, success: true });
    } catch (err) {
      const details = extractErrorDetails(err);
      console.error("Primary transcription failed:", details.message);
      tiers.push({
        tier: "primary",
        model: primaryModel,
        success: false,
        error: details.message,
        api_endpoint: details.endpoint,
        http_status: details.httpStatus,
        error_response_body: details.responseBody,
      });
    }

    // ── Tier 2: Fallback ──
    if (!result && fallbackModel && fallbackModel !== primaryModel) {
      try {
        console.log(`Tier 2 (fallback): ${fallbackModel}`);
        result = await runTranscription(audioBlob, fallbackModel, supabaseAdmin, fallbackProvider);
        tiers.push({ tier: "fallback", model: fallbackModel, success: true });
      } catch (err) {
        const details = extractErrorDetails(err);
        console.error("Fallback transcription failed:", details.message);
        tiers.push({
          tier: "fallback",
          model: fallbackModel,
          success: false,
          error: details.message,
          api_endpoint: details.endpoint,
          http_status: details.httpStatus,
          error_response_body: details.responseBody,
        });
      }
    }

    // ── Tier 3: Last Resort (whisper-1, or the admin's Vercel model) ──
    if (!result && lastResortModel !== primaryModel && lastResortModel !== fallbackModel) {
      try {
        console.log(`Tier 3 (last_resort): ${lastResortModel}`);
        result = await runTranscription(audioBlob, lastResortModel, supabaseAdmin, lastResortProvider);
        tiers.push({ tier: "last_resort", model: lastResortModel, success: true });
      } catch (err) {
        const details = extractErrorDetails(err);
        console.error("Last resort transcription failed:", details.message);
        tiers.push({
          tier: "last_resort",
          model: lastResortModel,
          success: false,
          error: details.message,
          api_endpoint: details.endpoint,
          http_status: details.httpStatus,
          error_response_body: details.responseBody,
        });
      }
    }

    const tierUsed = tiers.find((t) => t.success)?.tier || "none";
    const modelUsed = tiers.find((t) => t.success)?.model || "none";

    // Log to system_logs using createLogger (proven pattern from brand-scrape)
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
        media_url: mediaUrl,
        language: result?.language,
        duration: result?.duration,
        tiers: Object.fromEntries(tiers.map((t) => [t.tier, {
          model: t.model,
          success: t.success,
          error: t.error,
          api_endpoint: t.api_endpoint,
          http_status: t.http_status,
        }])),
        raw_details: {
          media_url: mediaUrl,
          requested_model: requestedModel,
          primary_model: primaryModel,
          fallback_model: fallbackModel,
          last_resort_model: lastResortModel,
          tier_attempts: tiers.map((t) => ({
            tier: t.tier,
            model: t.model,
            success: t.success,
            error_message: t.error,
            api_endpoint: t.api_endpoint,
            http_status: t.http_status,
            error_response_body: t.error_response_body,
          })),
        },
      },
      user.id
    );

    if (!result) {
      return new Response(JSON.stringify({ error: "All transcription tiers failed. Check API keys and models." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      ...result,
      modelUsed,
      tierUsed,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const errMessage = (error as Error).message || String(error);
    const errStack = (error as Error).stack || "";
    console.error("transcribe-media error:", errMessage);

    // Log outer catch errors using createLogger
    if (supabaseAdmin) {
      try {
        const outerLogger = createLogger(supabaseAdmin, "transcribe-media", "edge");
        await outerLogger.error(`Transcription unhandled error: ${errMessage.substring(0, 200)}`, {
          feature: "transcription",
          error_type: "unhandled_exception",
          raw_details: {
            error_message: errMessage,
            error_stack: errStack.substring(0, 1000),
            error_name: (error as Error).name,
            ...(error instanceof TranscriptionApiError ? {
              api_endpoint: error.endpoint,
              http_status: error.httpStatus,
              error_response_body: error.responseBody,
            } : {}),
          },
        }, userId || undefined);
      } catch (logErr) {
        console.error("CRITICAL: Failed to log transcription error to DB:", JSON.stringify({
          original_error: errMessage,
          log_error: (logErr as Error).message,
        }));
      }
    }

    return new Response(JSON.stringify({ error: errMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
