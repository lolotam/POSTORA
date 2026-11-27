import { supabase } from "@/integrations/supabase/client";
import type { YouTubeThumbnailMediaGateway } from "../application/ports";
import type { YouTubeThumbnailCandidate } from "../domain/thumbnail";

// How many owned images the picker may look at. The creator's newest images
// come first, because that is the one they want for a thumbnail.
const OWNED_IMAGE_LIMIT = 50;

interface OwnedImageRow {
  id: string;
  file_path: string | null;
  mime_type: string | null;
  file_type: string | null;
  file_size: number | null;
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

/**
 * Reads the creator's own media library for the thumbnail picker.
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
    return ((data ?? []) as OwnedImageRow[]).map((row) => ({
      id: row.id,
      file_name: fileNameOf(row),
      mime_type: row.mime_type ?? "",
      file_type: row.file_type ?? "",
      file_size: row.file_size,
    }));
  }
}

export const defaultYouTubeThumbnailMediaGateway = new SupabaseYouTubeThumbnailMediaGateway();
