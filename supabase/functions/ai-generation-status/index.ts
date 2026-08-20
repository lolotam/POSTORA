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
      const { data: timedOut, error: timeoutError } = await supabase
        .from("ai_generation_jobs")
        .update({ status: "timeout", error: "Generation timed out" })
        .eq("id", job.id)
        .eq("user_id", user.id)
        .in("status", ["queued", "running", "archiving"])
        .select("id");
      if (timeoutError) throw timeoutError;
      // A timeout is a definitive end for this job, so the reservation must come
      // back — otherwise an abandoned generation silently costs the user a slot
      // for the rest of the day. Guarded on the transition so concurrent polls
      // cannot each release.
      if (job.credential_source === "platform" && timedOut?.length)
        await supabase.rpc("release_ai_generation_quota", { p_user_id: user.id });
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
      const { data: failedRows, error: failError } = await supabase
        .from("ai_generation_jobs")
        .update({ status: "failed", error: snap.error })
        .eq("id", job.id)
        .eq("user_id", user.id)
        .in("status", ["queued", "running"])
        .select("id");
      if (failError) throw failError;
      // Release only if THIS poll performed the transition. Concurrent polls both
      // see `running`, and releasing per-poll would return more quota than was
      // reserved.
      if (job.credential_source === "platform" && failedRows?.length)
        await supabase.rpc("release_ai_generation_quota", { p_user_id: user.id });
      return json({ success: true, status: "failed", error: snap.error });
    }

    // Claim the job BEFORE archiving. Archiving creates a media_files row, so two
    // concurrent polls that both archive produce two rows for one generation — and
    // because a zero-row UPDATE is not an error, the loser would still report
    // success with its own duplicate URL. Claiming first means exactly one poll
    // archives; the others read back the winner's persisted result.
    const { data: claimed, error: claimError } = await supabase
      .from("ai_generation_jobs")
      .update({ status: "archiving" })
      .eq("id", job.id)
      .eq("user_id", user.id)
      .in("status", ["queued", "running"])
      .select("id");
    if (claimError) throw claimError;

    if (!claimed?.length) {
      // Another poll won the claim. Report its outcome rather than archiving again.
      const { data: winner } = await supabase
        .from("ai_generation_jobs")
        .select("status, result_url, media_file_id, error")
        .eq("id", job.id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (winner?.status === "succeeded") {
        return json({
          success: true,
          status: "succeeded",
          url: winner.result_url,
          ...(job.modality === "video"
            ? { videoUrl: winner.result_url }
            : { imageUrl: winner.result_url }),
          mediaFileId: winner.media_file_id,
        });
      }
      // Report the persisted state truthfully. `timeout` and `failed` are terminal,
      // and calling them "running" would keep the client polling a job that will
      // never change again.
      if (winner?.status === "failed" || winner?.status === "timeout") {
        return json({ success: true, status: winner.status, error: winner.error ?? undefined });
      }
      return json({ success: true, status: "running", pollAfterSeconds: 5 });
    }

    const uploadUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/cloudinary-upload`;
    let archiveBody: Record<string, any> = {};
    try {
      const archived = await fetch(uploadUrl, {
        method: "POST",
        headers: { Authorization: h, "Content-Type": "application/json" },
        body: JSON.stringify({
          externalUrl: snap.outputUrl,
          fileName: `higgsfield-${job.id}.${job.modality === "video" ? "mp4" : "png"}`,
          fileType: job.modality,
        }),
      });
      archiveBody = await archived.json().catch(() => ({}));
      if (!archived.ok || !archiveBody.success) throw new Error("Could not archive generated media");
    } catch (archiveErr) {
      // We hold the claim, so release it or the job is stranded in `archiving`
      // until the 30-minute timeout with no poll able to retry it.
      await supabase
        .from("ai_generation_jobs")
        .update({ status: "running" })
        .eq("id", job.id)
        .eq("user_id", user.id)
        .eq("status", "archiving");
      throw archiveErr;
    }

    const resultUrl = archiveBody.url || snap.outputUrl;
    const { data: succeeded, error: transitionError } = await supabase
      .from("ai_generation_jobs")
      .update({
        status: "succeeded",
        result_url: resultUrl,
        media_file_id: archiveBody.mediaFileId,
      })
      .eq("id", job.id)
      .eq("user_id", user.id)
      .eq("status", "archiving")
      .select("id");
    if (transitionError) throw transitionError;

    // Losing this transition means our claim was taken away while we archived --
    // the 30-minute timeout is the only thing that does so. Reporting "succeeded"
    // on an unconfirmed write would tell the client a job completed when the
    // database says it timed out, so re-read and return whatever actually persisted.
    if (!succeeded?.length) {
      const { data: persisted } = await supabase
        .from("ai_generation_jobs")
        .select("status, result_url, media_file_id, error")
        .eq("id", job.id)
        .eq("user_id", user.id)
        .maybeSingle();
      console.warn(
        `[ai-generation-status] archive claim lost for job ${job.id}; persisted status=${persisted?.status}`,
      );
      return json({
        success: true,
        status: persisted?.status ?? "failed",
        url: persisted?.result_url ?? undefined,
        error: persisted?.error ?? "The generation was marked timed out while archiving.",
      });
    }

    return json({
      success: true,
      status: "succeeded",
      url: resultUrl,
      ...(job.modality === "video" ? { videoUrl: resultUrl } : { imageUrl: resultUrl }),
      mediaFileId: archiveBody.mediaFileId,
    });
  } catch (err) {
    if (err instanceof HiggsfieldAuthError)
      return json({ error: err.message, code: err.code }, 409);
    console.error("[ai-generation-status]", err);
    return json({ error: err instanceof Error ? err.message : "Status failed" }, 500);
  }
});
