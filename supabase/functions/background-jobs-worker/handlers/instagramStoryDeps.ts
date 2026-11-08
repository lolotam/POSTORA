import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { createInstagramAccountCapabilityStore, createServiceRpcCaller } from "../../_shared/facebookUserCredentialStore.ts";
import { readStoryWork, type InstagramStoryPorts } from "./instagramStory.ts";

/** Fetch and body decoding share one deadline. Neither raw provider errors nor tokens escape. */
export async function storyJson(url: string, init: RequestInit, timeoutMs: number, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  if (timeoutMs < 1) throw new Error("story_deadline");
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, { ...init, signal: abort.signal });
        if (!response.ok) throw new Error("story_provider_refused");
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || Array.isArray(body) || "error" in body) throw new Error("story_provider_refused");
        return body as Record<string, unknown>;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("story_deadline")); }, timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function validStoryMedia(file: Record<string, unknown>): boolean {
  const m = file.metadata;
  if (!m || typeof m !== "object" || Array.isArray(m) || file.scan_state !== "available") return false;
  const meta = m as Record<string, unknown>;
  const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!positive(meta.width) || !positive(meta.height) || !positive(file.file_size)) return false;
  // Conservative supported subset. No transform or inferred dimensions/duration.
  // Meta's container processing must still accept the video's actual encoding before publish.
  if (meta.width > 1920 || Math.abs(meta.width / meta.height - 9 / 16) > 0.01) return false;
  if (file.mime_type === "image/jpeg") return file.file_size <= 8 * 1024 * 1024;
  return ["video/mp4", "video/quicktime"].includes(String(file.mime_type)) && file.file_size <= 100 * 1024 * 1024 &&
    positive(meta.duration) && meta.duration >= 3 && meta.duration <= 60;
}

export function createInstagramStoryPorts(admin: SupabaseClient, fetcher: typeof fetch = fetch, now = Date.now): InstagramStoryPorts {
  let endpoint = "";
  let token = "";
  let account = "";
  let mediaUrl = "";
  let video = false;
  let deadline = Infinity;
  const signal = () => AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - now())));
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(name, args).abortSignal(signal());
    if (error) throw new Error("story_storage_unavailable");
    return data;
  };
  const request = (path: string, timeout: number, body?: Record<string, unknown>) => storyJson(`${endpoint}/${path}`, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, timeout, fetcher);
  return {
    now,
    async load(job, deadlineMs) {
      deadline = deadlineMs;
      const row = await rpc("read_instagram_story_job", { p_job_id: job.id, p_token: job.claim_token });
      const work = row && readStoryWork(row);
      if (!work) throw new Error("story_claim_or_state_unavailable");
      const context = { authorized: row.authorized === true, primarySucceeded: row.primarySucceeded === true, eligible: false, mediaValid: false };
      if (["published", "failed", "uncertain"].includes(work.phase) || !context.authorized) return { work, context };
      const { data: a, error: ae } = await admin.from("social_accounts")
        .select("id,platform_user_id,access_token").eq("id", work.accountId).eq("user_id", job.user_id).eq("platform", "instagram").eq("is_active", true).abortSignal(signal()).maybeSingle();
      if (ae) throw new Error("story_account_read_failed");
      if (!a) return { work, context: { ...context, authorized: false } };
      const capability = await createInstagramAccountCapabilityStore(createServiceRpcCaller({
        rpc: (name, args) => admin.rpc(name, args).abortSignal(signal()),
      })).readCapability({ userId: job.user_id, socialAccountId: work.accountId });
      const scope = capability.loginKind === "direct" ? "instagram_business_content_publish" : "instagram_content_publish";
      if (!capability.capabilityPresent || !capability.scopesAuthoritative || capability.permissionReadState !== "ok" ||
        !capability.grantedScopes.includes(scope) || !capability.loginKind || !a.access_token || !/^\d+$/.test(a.platform_user_id)) return { work, context };
      endpoint = capability.loginKind === "direct" ? "https://graph.instagram.com/v21.0" : "https://graph.facebook.com/v21.0";
      token = a.access_token; account = a.platform_user_id;
      context.eligible = true;
      const { data: file, error: fe } = await admin.from("media_files").select("*").eq("id", row.mediaFileId).eq("user_id", job.user_id).abortSignal(signal()).maybeSingle();
      if (fe) throw new Error("story_media_read_failed");
      context.mediaValid = !!file && validStoryMedia(file);
      if (!context.mediaValid) return { work, context };
      // Resolve the current object version; a stale CDN URL must never substitute for this file.
      const { data: providers, error: pe } = await admin.from("media_file_providers")
        .select("delivery_url,provider").eq("media_file_id", file.id).eq("object_version", file.current_object_version ?? 1).eq("status", "ready").abortSignal(signal());
      if (pe) throw new Error("story_media_read_failed");
      mediaUrl = providers?.find((p: { provider: string }) => p.provider === "openinary")?.delivery_url ?? providers?.[0]?.delivery_url ?? "";
      if (!mediaUrl && /^https:\/\//.test(file.file_path)) mediaUrl = file.file_path;
      if (!mediaUrl && !["openinary", "cloudinary"].includes(file.storage_bucket)) {
        const { data, error } = await admin.storage.from(file.storage_bucket).createSignedUrl(file.file_path, 3600);
        if (error) throw new Error("story_media_read_failed");
        mediaUrl = data?.signedUrl ?? "";
      }
      context.mediaValid = /^https:\/\//.test(mediaUrl);
      video = file.mime_type.startsWith("video/");
      if (deadline - now() < 6000) throw new Error("story_deadline");
      const identity = await request(`${account}?fields=account_type`, Math.min(10_000, deadline - now() - 5000));
      context.eligible = identity.account_type === "BUSINESS";
      return { work, context };
    },
    async checkpoint(job, work) {
      return await rpc("checkpoint_instagram_story", { p_job_id: job.id, p_token: job.claim_token, p_generation: work.generation,
        p_phase: work.phase, p_container_id: work.containerId ?? null, p_media_id: work.mediaId ?? null }) === true;
    },
    async create(_work, timeout) {
      const body = await request(`${account}/media`, timeout, { media_type: "STORIES", [video ? "video_url" : "image_url"]: mediaUrl });
      if (typeof body.id !== "string" || !/^\d+$/.test(body.id)) throw new Error("story_invalid_container");
      return { id: body.id };
    },
    async status(work, timeout) {
      const body = await request(`${encodeURIComponent(work.containerId!)}?fields=status_code`, timeout);
      switch (body.status_code) {
        case "PUBLISHED": return "published";
        case "FINISHED": return "finished";
        case "ERROR": case "EXPIRED": return "failed";
        case "IN_PROGRESS": return "waiting";
        default: throw new Error("story_unknown_status");
      }
    },
    async publish(work, timeout) {
      const body = await request(`${account}/media_publish`, timeout, { creation_id: work.containerId });
      if (typeof body.id !== "string" || !/^\d+$/.test(body.id)) throw new Error("story_invalid_media");
      return { id: body.id };
    },
    async settle(job, work, result) {
      return await rpc("settle_instagram_story", { p_job_id: job.id, p_token: job.claim_token, p_generation: work.generation,
        p_published: result.published, p_error: result.error ?? null, p_uncertain: result.uncertain ?? false }) === true;
    },
  };
}
