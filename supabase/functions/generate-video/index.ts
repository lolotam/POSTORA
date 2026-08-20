import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders } from "../_shared/cors.ts";
import { HiggsfieldAuthError, resolveHiggsfieldCredential } from "../_shared/higgsfield-oauth.ts";
import { HiggsfieldMcpClient, findJobId } from "../_shared/higgsfield-mcp.ts";
import {
  mergeModelSpec,
  sanitizeParams,
  missingRequiredParams,
  resolveAspectRatio,
  resolveDuration,
} from "../_shared/higgsfield-model-spec.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
const admin = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  // Hoisted so the catch can release a reservation made inside the try.
  const supabase = admin();
  let reserved = false;
  let userId: string | null = null;
  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(authHeader.slice(7));
    if (error || !user) return json({ error: "Unauthorized" }, 401);
    userId = user.id;
    const body = await req.json();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json({ error: "Prompt is required" }, 400);
    const modelId = String(body.model_id || "cinematic_studio_3_0");
    const { data: model } = await supabase
      .from("ai_models")
      .select("model_id, metadata, is_active, capabilities, ai_providers!inner(provider_code)")
      .eq("model_id", modelId)
      .eq("ai_providers.provider_code", "higgsfield")
      .maybeSingle();
    if (!model || !model.is_active || !(model.capabilities || []).includes("video"))
      return json({ error: "Invalid Higgsfield video model" }, 400);
    const cred = await resolveHiggsfieldCredential(supabase, user.id);
    if (cred.source === "byo") {
      const hour = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const [{ count: recent }, { count: running }] = await Promise.all([
        supabase
          .from("ai_generation_jobs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .gte("created_at", hour),
        supabase
          .from("ai_generation_jobs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .in("status", ["queued", "running"]),
      ]);
      if ((recent ?? 0) >= 10) return json({ error: "BYO generation hourly limit reached" }, 429);
      if ((running ?? 0) >= 2) return json({ error: "Too many concurrent generations" }, 429);
    }
    if (cred.source === "platform") {
      const { data } = await supabase.rpc("reserve_ai_generation_quota", { p_user_id: user.id });
      const quota = Array.isArray(data) ? data[0] : data;
      if (!quota?.allowed)
        return json(
          { error: "Daily AI generation limit reached", limit: quota?.daily_limit ?? null },
          402,
        );
      reserved = true;
    }
    const spec = mergeModelSpec(modelId, model.metadata, "video");
    const params = sanitizeParams(spec, typeof body.params === "object" ? body.params : {});
    const ratio = resolveAspectRatio(spec, body.aspectRatio);
    if (ratio) params.aspect_ratio = ratio;
    const duration = resolveDuration(spec, body.duration);
    if (duration !== null) params.duration = duration;
    const missing = missingRequiredParams(spec, params);
    if (missing.length) return json({ error: `Missing parameters: ${missing.join(", ")}` }, 400);
    // Pass `cred` through untouched: it carries the connection-scoped refresh()
    // that keeps a mid-session 401 on the SAME account. Stripping it would make a
    // BYO retry fall back to the platform token and bill the admin.
    const mcp = HiggsfieldMcpClient.fromCredential(cred, supabase);
    const submission = await mcp.callTool("generate_video", {
      params: { model: modelId, prompt, ...params },
    });
    const providerJobId = findJobId(submission);
    if (!providerJobId) throw new Error("Higgsfield returned no job id");
    const { data: job, error: insertError } = await supabase
      .from("ai_generation_jobs")
      .insert({
        user_id: user.id,
        provider: "higgsfield",
        model_id: modelId,
        modality: "video",
        credential_source: cred.source,
        status: "running",
        provider_job_id: providerJobId,
        params: { prompt, ...params, reservation: reserved },
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    return json({ success: true, jobId: job.id, status: "running", pollAfterSeconds: 10 });
  } catch (err) {
    // Quota was reserved before dispatch. Reaching here means the job never
    // started — the MCP call threw, Higgsfield returned no job id, or the job row
    // failed to insert — so the reservation must be released or the user is
    // charged for a generation that never ran. Releasing is safe precisely
    // because we only get here on a definitive failure; an indeterminate outcome
    // returns a running job instead and stays charged.
    if (reserved && userId) {
      const { error: releaseError } = await supabase.rpc("release_ai_generation_quota", {
        p_user_id: userId,
      });
      if (releaseError) {
        console.error("[generate-video] quota release failed:", releaseError.message);
      }
    }
    if (err instanceof HiggsfieldAuthError)
      return json({ error: err.message, code: err.code }, 409);
    console.error("[generate-video]", err);
    return json({ error: err instanceof Error ? err.message : "Generation failed" }, 500);
  }
});
