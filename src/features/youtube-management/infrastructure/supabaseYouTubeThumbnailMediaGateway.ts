import { supabase } from "@/integrations/supabase/client";
import { resolveMediaPreviewUrl } from "@/lib/mediaUrl";
import type { YouTubeThumbnailMediaGateway } from "../application/ports";
import { checkThumbnailFile, isThumbnailFileFailure, type YouTubeThumbnailCandidate } from "../domain/thumbnail";

// How many owned images the picker may look at. The creator's newest images
// come first, because that is the one they want for a thumbnail.
const OWNED_IMAGE_LIMIT = 50;

// The bucket the app stores a creator's own media in.
const MEDIA_BUCKET = "media";

// Signed preview URL lifetime (1 hour): display-only inside the thumbnail dialog.
const PREVIEW_SIGNED_URL_TTL_SECONDS = 3600;

interface OwnedImageRow {
  id: string;
  file_path: string | null;
  mime_type: string | null;
  file_type: string | null;
  file_size: number | null;
  storage_bucket: string | null;
  metadata: { original_filename?: unknown } | null;
}

// The upload's own name reads better than a storage path; the path's last
// segment is the fallback when the row never carried a name.
function fileNameOf(row: OwnedImageRow): string {
  const original = row.metadata?.original_filename;
  if (typeof original === "string" && original.trim().length > 0) return original.trim();
  const path = row.file_path ?? "";
  return path.split("/").pop() || "image";
}

function storagePublicUrl(bucket: string, path: string): string {
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

async function signStoragePreview(bucket: string, path: string): Promise<string | null> {
  const bucketClient = supabase.storage.from(bucket) as {
    createSignedUrl?: (objectPath: string, expiresIn: number) => Promise<{ data?: { signedUrl?: string | null } | null; error?: unknown }>;
    getPublicUrl?: (objectPath: string) => { data: { publicUrl: string } };
  };
  if (typeof bucketClient.createSignedUrl === "function") {
    try {
      const { data, error } = await bucketClient.createSignedUrl(path, PREVIEW_SIGNED_URL_TTL_SECONDS);
      if (!error && typeof data?.signedUrl === "string" && data.signedUrl.length > 0) {
        return data.signedUrl;
      }
    } catch {
      // Fall back to public URL below when signing is unavailable.
    }
  }
  return storagePublicUrl(bucket, path) || null;
}

/**
 * Where the browser can show the image, or null when the row has no file.
 *
 * The URL is display only: it is never sent to an edge function and never
 * reaches YouTube, which receives the stored bytes by row id.
 */
async function previewUrlOf(row: OwnedImageRow): Promise<string | null> {
  const filePath = row.file_path ?? "";
  if (filePath.length === 0) return null;
  const resolved = await resolveMediaPreviewUrl(
    { file_path: filePath, storage_bucket: row.storage_bucket || MEDIA_BUCKET },
    signStoragePreview,
  );
  return resolved || null;
}

async function toCandidate(row: OwnedImageRow): Promise<YouTubeThumbnailCandidate> {
  return {
    id: row.id,
    file_name: fileNameOf(row),
    mime_type: row.mime_type ?? "",
    file_type: row.file_type ?? "",
    file_size: row.file_size,
    preview_url: await previewUrlOf(row),
  };
}

/**
 * Reads and writes the creator's own media library for the thumbnail picker.
 *
 * The query is scoped to the signed-in owner and to image rows; the MIME
 * allow-list is applied by the picker, so the creator can see that a file
 * was filtered out instead of silently losing it.
 */
export class SupabaseYouTubeThumbnailMediaGateway implements YouTubeThumbnailMediaGateway {
  async listOwnedImages(params: { userId: string }): Promise<YouTubeThumbnailCandidate[]> {
    const { data, error } = await supabase
      .from("media_files")
      .select("id, file_path, mime_type, file_type, file_size, storage_bucket, metadata")
      .eq("user_id", params.userId)
      .eq("file_type", "image")
      .in("storage_bucket", ["media", "supabase"])
      .in("mime_type", ["image/jpeg", "image/png"])
      .order("created_at", { ascending: false })
      .limit(OWNED_IMAGE_LIMIT);
    if (error) throw error;
    return Promise.all(((data ?? []) as OwnedImageRow[]).map(toCandidate));
  }

  /**
   * Stores one image the creator picked on this device.
   *
   * The owner comes from the session, never from a parameter: the write runs
   * under the creator's own JWT, so there is no owner to be told, and a
   * caller-supplied owner would be a way to write into another account.
   */
  async uploadOwnedImage(params: {
    blob: Blob;
    fileName: string;
    mimeType: "image/jpeg" | "image/png";
  }): Promise<YouTubeThumbnailCandidate> {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) throw new Error("Authentication required");

    const head = new Uint8Array(await params.blob.slice(0, 16).arrayBuffer());
    const check = checkThumbnailFile({ declaredType: params.mimeType, size: params.blob.size, head });
    if (isThumbnailFileFailure(check)) throw new Error(`Thumbnail image refused: ${check.reason}`);

    const id = crypto.randomUUID();
    const ext = check.mimeType === "image/png" ? "png" : "jpg";
    const filePath = `${userId}/${id}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(filePath, params.blob, { contentType: check.mimeType, upsert: false });
    if (uploadError) throw uploadError;

    const { data: inserted, error: insertError } = await supabase
      .from("media_files")
      .insert({
        id,
        user_id: userId,
        file_path: filePath,
        file_type: "image",
        file_size: params.blob.size,
        mime_type: check.mimeType,
        storage_bucket: MEDIA_BUCKET,
        metadata: { original_filename: params.fileName },
      })
      .select("id, file_path, mime_type, file_type, file_size, storage_bucket, metadata")
      .single();

    if (insertError || !inserted) {
      // The insert may have succeeded and only its answer got lost, so the
      // row is looked up before the stored object is removed: deleting an
      // object whose row exists would leave the library pointing at nothing.
      // Never let a failed read look like an empty one (AGENTS.md Rule #3):
      // only delete the object when the lookup succeeds and confirms absence.
      const { data: existing, error: lookupError } = await supabase
        .from("media_files")
        .select("id, file_path, mime_type, file_type, file_size, storage_bucket, metadata")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!lookupError && existing) return toCandidate(existing as OwnedImageRow);
      if (!lookupError && !existing) {
        await supabase.storage.from(MEDIA_BUCKET).remove([filePath]);
      }
      throw insertError ?? lookupError ?? new Error("Failed to record thumbnail media");
    }

    return toCandidate(inserted as OwnedImageRow);
  }
}

export const defaultYouTubeThumbnailMediaGateway = new SupabaseYouTubeThumbnailMediaGateway();
