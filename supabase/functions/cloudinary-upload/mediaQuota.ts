import { destroyCloudinary } from "../_shared/cloudinaryDestroy.ts";
import { MEDIA_QUOTA_CODE, mediaQuotaBody, mediaQuotaHumanMessage } from "../_shared/mediaQuotaError.ts";
export { mediaQuotaPreflight, type QuotaRpc } from "../_shared/mediaQuotaError.ts";
import { deleteFromOpeninary, getOpeninaryConfig } from "../_shared/openinary.ts";

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
