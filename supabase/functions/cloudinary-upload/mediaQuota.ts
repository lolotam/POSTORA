import { destroyCloudinary } from "../_shared/cloudinaryDestroy.ts";
import { MEDIA_QUOTA_CODE, mediaQuotaBody, mediaQuotaHumanMessage } from "../_shared/mediaQuotaError.ts";
import { deleteFromOpeninary, getOpeninaryConfig } from "../_shared/openinary.ts";

export interface QuotaRpc {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

/**
 * Null means the upload may proceed: unlimited, slots left, or the read failed
 * (the INSERT trigger is the backstop). A returned limit means remaining is 0
 * and the number came from effective_user_quotas.
 */
export async function mediaQuotaPreflight(db: QuotaRpc, userId: string): Promise<{ limit: number } | null> {
  const remaining = await db.rpc("media_upload_quota_remaining", { p_user: userId });
  if (remaining.error || remaining.data == null) return null;
  const left = Number(remaining.data);
  if (!Number.isFinite(left) || left !== 0) return null;

  const limits = await db.rpc("effective_user_quotas", { p_user_id: userId });
  if (limits.error || limits.data == null) return null;
  const row = Array.isArray(limits.data) ? limits.data[0] : limits.data;
  const raw = (row as { max_media_uploads_per_day?: unknown } | null)?.max_media_uploads_per_day;
  if (raw == null) return null;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 0) return null;
  return { limit };
}

/** A trigger refusal starts with the code. Anything else is left to the caller. */
export async function quotaInsertRefusal(
  message: string,
  cleanup: () => Promise<void>,
): Promise<{ status: 429; body: ReturnType<typeof mediaQuotaBody> } | null> {
  if (!message.startsWith(MEDIA_QUOTA_CODE)) return null;
  await cleanup();
  return {
    status: 429,
    body: {
      success: false,
      error: mediaQuotaHumanMessage(message),
      code: MEDIA_QUOTA_CODE,
    },
  };
}

export async function deleteJustUploaded(facts: {
  storedIn: string[];
  openinaryPath: string | null;
  cloudinaryPublicId: string | null;
  kind: string;
}): Promise<void> {
  if (facts.storedIn.includes("openinary") && facts.openinaryPath) {
    const config = getOpeninaryConfig();
    if (config) {
      try {
        await deleteFromOpeninary(config, facts.openinaryPath);
      } catch {
        console.error("[cloudinary-upload] quota cleanup openinary failed");
      }
    }
  }
  if (facts.storedIn.includes("cloudinary") && facts.cloudinaryPublicId) {
    const resourceType = facts.kind === "video" ? "video" : "image";
    try {
      await destroyCloudinary(facts.cloudinaryPublicId, resourceType);
    } catch {
      console.error("[cloudinary-upload] quota cleanup cloudinary failed");
    }
  }
}
