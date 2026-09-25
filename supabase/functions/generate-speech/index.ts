// deno-lint-ignore-file no-explicit-any no-import-prefix
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import { fetchCategoryAiSettings } from "../_shared/ai-fallback.ts";
import { resolveVercelKey, vercelGenerateSpeech } from "../_shared/vercelGateway.ts";
import { redactProviderError } from "../_shared/ai-routing-errors.ts";
import { createLogger } from "../_shared/logging.ts";
import { tierTimeout } from "./budget.ts";

const RequestSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  voice: z.string().max(64).optional(),
});

// Total wall-clock budget shared across every Vercel tier attempt, kept below the
// platform's ~60s edge-worker ceiling. Without this, three failing tiers at 45s each
// (PER_TIER_MAX_MS) could sum to 135s and get killed with no response and no log row.
const SPEECH_BUDGET_MS = 50_000;
const PER_TIER_MAX_MS = 45_000;

serve(async (req) => {
  const cors = restrictedCorsHeaders(req);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let userId: string;
  try {
    userId = (await authenticateCaller(req)).userId;
  } catch {
    return json({ error: "Unauthorized" }, 401);
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: role } = await admin.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (!role) return json({ error: "Admin required" }, 403);

  const parsed = RequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "text must be 1-1000 characters" }, 400);
  const { text, voice } = parsed.data;

  const logger = createLogger(admin, "generate-speech");
  // Every refusal leaves a durable row, not just a toast the admin may never report.
  const refuse = async (reason: string, message: string, detail?: Record<string, unknown>) => {
    await logger.warn(`Speech refused: ${message}`, { event: "speech_refused", reason, ...detail }, userId);
    return json({ error: message });
  };
  try {
    const s = await fetchCategoryAiSettings(admin, "tts");
    const tiers = [[s.primaryProvider, s.primaryModel], [s.fallbackProvider, s.fallbackModel], [s.lastResortProvider, s.lastResortModel]]
      .filter(([p, m]) => p === "vercel" && m);
    if (!tiers.length) return await refuse("no_vercel_tts_tier", "No Vercel TTS model selected in Text to Speech settings");
    const apiKey = await resolveVercelKey(admin);
    if (!apiKey) return await refuse("gateway_key_missing", "Vercel AI Gateway key not configured");
    const errors: string[] = [];
    const startedAt = Date.now();
    for (const [, model] of tiers) {
      const timeoutMs = tierTimeout(startedAt, Date.now(), SPEECH_BUDGET_MS, PER_TIER_MAX_MS);
      if (timeoutMs === null) {
        errors.push("time budget exhausted before trying remaining tiers");
        break;
      }
      try {
        const out = await vercelGenerateSpeech(apiKey, model, text, voice, "mp3", timeoutMs);
        return json({ audio: out.base64, mediaType: out.mediaType, provider: "vercel", model });
      } catch (e) {
        console.error("[generate-speech] tier failed", model, redactProviderError(e instanceof Error ? e.message : String(e), apiKey));
        errors.push(`${model}: ${sanitizeErrorMessage(e)}`);
      }
    }
    return await refuse("all_tiers_failed", errors.join("; "), { models: tiers.map(([, m]) => m) });
  } catch (e) {
    console.error("[generate-speech]", e);
    await logger.error("Speech generation failed", { event: "speech_failed", error: sanitizeErrorMessage(e) }, userId);
    return json({ error: sanitizeErrorMessage(e) }, 500);
  }
});
