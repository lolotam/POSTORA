import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders } from "../_shared/cors.ts";
import { HiggsfieldAuthError, resolveHiggsfieldCredential } from "../_shared/higgsfield-oauth.ts";
import { HiggsfieldMcpClient, readJobSnapshot } from "../_shared/higgsfield-mcp.ts";
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
const admin = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const h = req.headers.get("Authorization") || "";
    if (!h.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const supabase = admin();
    const {
      data: { user },
    } = await supabase.auth.getUser(h.slice(7));
    if (!user) return json({ error: "Unauthorized" }, 401);
    const { jobId } = await req.json();
    const { data: job } = await supabase
      .from("ai_generation_jobs")
      .select("*")
      .eq("id", jobId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!job) return json({ error: "Job not found" }, 404);
    if (["succeeded", "failed", "timeout"].includes(job.status))
      return json({ success: true, status: job.status, videoUrl: job.modality === "video" ? job.result_url : null, imageUrl: job.modality === "image" ? job.result_url : null, url: job.result_url, error: job.error });
    if (Date.now() - Date.parse(job.created_at) > 30 * 60_000) {
      const { data: transitioned, error: transitionError } = await supabase
        .from("ai_generation_jobs")
        .update({ status: "timeout", error: "Generation timed out" })
        .eq("id", job.id)
        .eq("user_id", user.id);
      return json({ success: true, status: "timeout" });
    }
    const cred = await resolveHiggsfieldCredential(supabase, user.id);
    if (cred.source !== job.credential_source)
      return json({
        success: true,
        status: "failed",
        error: "The original Higgsfield connection is no longer available",
      });
    const payload = await HiggsfieldMcpClient.fromCredential(cred, supabase).callTool(
      "job_status",
      { jobId: job.provider_job_id },
    );
    const snap = readJobSnapshot(payload);
    if (snap.state === "running")
      return json({
        success: true,
        status: "running",
        providerStatus: snap.status,
        pollAfterSeconds: snap.pollAfterSeconds,
      });
    if (snap.state === "failed") {
      await supabase
        .from("ai_generation_jobs")
        .update({ status: "failed", error: snap.error })
        .eq("id", job.id)
        .eq("user_id", user.id)
        .in("status", ["queued", "running"])
        .select("id");
      if (transitionError) throw transitionError;
      if (job.credential_source === "platform" && transitioned?.length)
        await supabase.rpc("release_ai_generation_quota", { p_user_id: user.id });
      return json({ success: true, status: "failed", error: snap.error });
    }
    const uploadUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/cloudinary-upload`;
    const archived = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: h, "Content-Type": "application/json" },
      body: JSON.stringify({
        externalUrl: snap.outputUrl,
        fileName: `higgsfield-${job.id}.${job.modality === "video" ? "mp4" : "png"}`,
        fileType: job.modality,
      }),
    });
    const archiveBody = await archived.json().catch(() => ({}));
    if (!archived.ok || !archiveBody.success) throw new Error("Could not archive generated media");
    const { error: transitionError } = await supabase
      .from("ai_generation_jobs")
      .update({
        status: "succeeded",
        result_url: archiveBody.url || snap.outputUrl,
        media_file_id: archiveBody.mediaFileId,
      })
      .eq("id", job.id)
      .eq("user_id", user.id)
      .in("status", ["queued", "running"]);
    if (transitionError) throw transitionError;
    return json({
      success: true,
      status: "succeeded",
      url: archiveBody.url || snap.outputUrl,
      ...(job.modality === "video" ? { videoUrl: archiveBody.url || snap.outputUrl } : { imageUrl: archiveBody.url || snap.outputUrl }),
      mediaFileId: archiveBody.mediaFileId,
    });
  } catch (err) {
    if (err instanceof HiggsfieldAuthError)
      return json({ error: err.message, code: err.code }, 409);
    console.error("[ai-generation-status]", err);
    return json({ error: err instanceof Error ? err.message : "Status failed" }, 500);
  }
});
