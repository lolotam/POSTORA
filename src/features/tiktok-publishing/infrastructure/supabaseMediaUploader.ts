import { supabase } from "@/integrations/supabase/client";
import type { TikTokMediaUploader } from "../application/mediaUploadPort";
import { ReviewGatewayError } from "../application/ports";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new ReviewGatewayError("UPLOAD_READ_FAILED", "That file could not be read.", 400));
    reader.readAsDataURL(file);
  });
}

async function refusalMessage(error: { message?: string; context?: unknown }): Promise<string> {
  if (error.context instanceof Response) {
    const body: unknown = await error.context.clone().json().catch(() => null);
    const record = body as { error?: unknown; message?: unknown } | null;
    if (typeof record?.error === "string") return record.error;
    if (typeof record?.message === "string") return record.message;
  }
  return error.message || "Upload failed.";
}

/** Same path as Create Post's local upload: cloudinary-upload stores the file and creates the media_files row. */
export function createSupabaseMediaUploader(): TikTokMediaUploader {
  return {
    async uploadVideo(file) {
      const fileData = await readAsDataUrl(file);
      const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
        body: { fileData, fileName: file.name, fileType: "video" },
      });
      if (error) throw new ReviewGatewayError("UPLOAD_FAILED", await refusalMessage(error), 502);
      const result = data as { success?: boolean; mediaFileId?: unknown; url?: unknown; duration?: unknown; error?: unknown } | null;
      if (!result?.success || typeof result.mediaFileId !== "string" || typeof result.url !== "string") {
        throw new ReviewGatewayError("UPLOAD_FAILED", typeof result?.error === "string" ? result.error : "Upload failed.", 502);
      }
      const durationSec = typeof result.duration === "number" && Number.isFinite(result.duration) ? result.duration : null;
      return { mediaFileId: result.mediaFileId, url: result.url, durationSec };
    },
  };
}
