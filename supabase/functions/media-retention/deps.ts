import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { destroyCloudinary } from "../_shared/cloudinaryDestroy.ts";
import { logToDatabase } from "../_shared/logging.ts";
import { deleteAuthorisedMediaFiles, type ProviderDeleteRow } from "../_shared/mediaDeletePlan.ts";
import { deleteFromOpeninary, getOpeninaryConfig } from "../_shared/openinary.ts";
import type { ClaimedMediaFile, RetentionLog, RetentionPorts } from "./run.ts";

// deno-lint-ignore no-explicit-any
type ServiceClient = any;

export function createServiceClient(): ServiceClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) throw new Error("retention backend unavailable");
  return createClient(supabaseUrl, serviceRoleKey);
}

/** Service-role delete of one claimed library row. Zero rows is not a removal. */
export async function deleteClaimedMediaRow(
  supabase: ServiceClient,
  id: string,
  claimedUserId: string,
): Promise<{ removed: boolean; stillDeleting: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("media_files")
    .delete()
    .eq("id", id)
    .eq("user_id", claimedUserId)
    .eq("retention_state", "deleting")
    .select("id");
  if (error) return { removed: false, stillDeleting: false, error: "media row delete failed" };
  if (Array.isArray(data) && data.length > 0) return { removed: true, stillDeleting: false };

  console.error("[media-retention] media row delete matched nothing");
  const lookup = await supabase
    .from("media_files")
    .select("id")
    .eq("id", id)
    .eq("retention_state", "deleting")
    .maybeSingle();
  // Release is a no-op unless the row is still deleting, so a failed lookup
  // still asks the caller to release rather than leave a claim stuck.
  if (lookup.error) {
    console.error("[media-retention] deleting-state lookup failed");
    return { removed: false, stillDeleting: false, error: "media row delete failed" };
  }
  return { removed: false, stillDeleting: lookup.data != null };
}

/** Provider row was loaded for this media id. The write must name that id too. */
export async function markProviderDeleted(
  supabase: ServiceClient,
  providerRowId: string,
  mediaFileId: string,
): Promise<{ error?: string }> {
  const { data, error } = await supabase
    .from("media_file_providers")
    .update({ status: "deleted", deleted_at: new Date().toISOString(), deleted_reason: "retention" })
    .eq("id", providerRowId)
    .eq("media_file_id", mediaFileId)
    .select("id");
  if (error || !Array.isArray(data) || data.length === 0) return { error: "provider status update failed" };
  return {};
}

export function createRetentionPorts(supabase: ServiceClient): RetentionPorts {
  return {
    async sweep(pNow, pLimit) {
      const { data, error } = await supabase.rpc("media_retention_sweep", { p_now: pNow, p_limit: pLimit });
      if (error) throw new Error("retention sweep failed");
      return Array.isArray(data) ? data : [];
    },
    async claim(pNow, pLimit) {
      const { data, error } = await supabase.rpc("media_retention_claim", { p_now: pNow, p_limit: pLimit });
      if (error) throw new Error("retention claim failed");
      return Array.isArray(data) ? data as ClaimedMediaFile[] : [];
    },
    async release(id, failed) {
      const { error } = await supabase.rpc("media_retention_release", { p_id: id, p_failed: failed });
      if (error) throw new Error("retention release failed");
    },
    async preview(userId) {
      const { data, error } = await supabase.rpc("media_retention_preview", { p_user: userId });
      if (error) throw new Error("retention preview failed");
      return Array.isArray(data) ? data : [];
    },
    async readDeleteEnabled() {
      const { data, error } = await supabase
        .from("media_retention_settings")
        .select("delete_enabled")
        .eq("id", 1)
        .maybeSingle();
      if (error || !data) return false;
      return data.delete_enabled === true;
    },
    async loadProviders(mediaFileId) {
      const { data, error } = await supabase
        .from("media_file_providers")
        .select("id, media_file_id, provider, object_key, status, delivery_url")
        .eq("media_file_id", mediaFileId);
      if (error) return { error: "provider lookup failed" };
      return { rows: (data ?? []) as ProviderDeleteRow[] };
    },
    async deleteFile(file, providers, timeoutMs) {
      const config = getOpeninaryConfig();
      const deadline = Date.now() + timeoutMs;
      const callTimeout = () => {
        const left = deadline - Date.now();
        return left > 0 ? left : 0;
      };
      const outcome = await deleteAuthorisedMediaFiles({
        requestedIds: [file.media_file_id],
        rows: [{
          id: file.media_file_id,
          user_id: file.user_id,
          file_type: file.file_type,
          cloudinary_public_id: file.cloudinary_public_id,
          file_path: file.file_path,
        }],
        providers,
        destroyOpeninary: async (objectKey) => {
          const left = callTimeout();
          if (left <= 0) return { success: false, error: "timed out" };
          if (!config) return { success: false, error: "openinary unavailable" };
          return deleteFromOpeninary(config, objectKey, left);
        },
        destroyCloudinary: (objectKey, resourceType) => {
          const left = callTimeout();
          if (left <= 0) return Promise.resolve({ success: false, error: "timed out" });
          return destroyCloudinary(objectKey, resourceType, { timeoutMs: left });
        },
        markDeleted: (providerRowId) => markProviderDeleted(supabase, providerRowId, file.media_file_id),
      });
      return { confirmed: outcome.deletedMediaFileIds.includes(file.media_file_id) };
    },
    removeMediaRow(id, claimedUserId) {
      return deleteClaimedMediaRow(supabase, id, claimedUserId);
    },
    async logRun(entry: RetentionLog) {
      await logToDatabase(supabase, {
        level: entry.failed > 0 ? "warn" : "info",
        category: "system",
        source: "media-retention",
        message: "Media retention run finished",
        metadata: {
          warned: entry.warned,
          cleared: entry.cleared,
          claimed: entry.claimed,
          deleted: entry.deleted,
          failed: entry.failed,
          backlog: entry.backlog,
          delete_enabled: entry.delete_enabled,
        },
      });
    },
  };
}
