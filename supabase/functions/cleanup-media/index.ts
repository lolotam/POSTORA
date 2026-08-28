import { verifyCronOrAdmin } from "../_shared/cron-auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteFromOpeninary, getOpeninaryConfig } from "../_shared/openinary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CleanupResult {
  totalOrphaned: number;
  deleted: number;
  failed: number;
  errors: string[];
  deletedFiles: string[];
}

interface OrphanedFilePayload {
  id: string;
  publicId: string | null;
  path: string;
  createdAt: string;
  fileType: string;
  storageBucket: string;
  thumbnailUrl: string;
}

/**
 * Build a small preview URL for an orphaned media file.
 * - Cloudinary images/videos: use a c_fill,w_200,h_200 transformation.
 * - Supabase storage or already-absolute URLs: return the path as-is.
 */
function buildThumbnailUrl(args: {
  storageBucket: string;
  fileType: string;
  publicId: string | null;
  filePath: string;
}): string {
  const { storageBucket, fileType, publicId, filePath } = args;
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");

  // Cloudinary-backed file with a public id -> transformed thumbnail
  if (storageBucket === "cloudinary" && publicId && cloudName) {
    const resourceType = fileType === "video" ? "video" : "image";
    const ext = resourceType === "video" ? ".mp4" : "";
    return `https://res.cloudinary.com/${cloudName}/${resourceType}/upload/c_fill,w_200,h_200/${publicId}${ext}`;
  }

  // Already an absolute URL (Cloudinary file_path stored as full URL, or other host)
  if (filePath && /^https?:\/\//i.test(filePath)) {
    return filePath;
  }

  // Supabase storage path - returned verbatim; the browser resolves via the public URL helper
  return filePath;
}

async function deleteFromCloudinary(publicId: string): Promise<boolean> {
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");

  if (!cloudName || !apiKey || !apiSecret) {
    console.error("Missing Cloudinary credentials");
    return false;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signatureString = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  
  // Create SHA1 signature
  const encoder = new TextEncoder();
  const data = encoder.encode(signatureString);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const signature = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  const formData = new FormData();
  formData.append("public_id", publicId);
  formData.append("timestamp", timestamp.toString());
  formData.append("api_key", apiKey);
  formData.append("signature", signature);

  try {
    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
      {
        method: "POST",
        body: formData,
      }
    );

    const result = await response.json();
    
    if (result.result === "ok" || result.result === "not found") {
      console.log(`Deleted from Cloudinary: ${publicId}`);
      return true;
    } else {
      console.error(`Failed to delete ${publicId}:`, result);
      return false;
    }
  } catch (error) {
    console.error(`Error deleting ${publicId}:`, error);
    return false;
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Reachable from the cron scheduler and from the admin Media Cleanup page,
  // so an admin JWT is accepted alongside the cron secret.
  const auth = await verifyCronOrAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body for options
    let dryRun = true; // Default to dry run for safety
    let maxFiles = 100; // Limit per run to avoid timeouts
    let olderThanDays = 7; // Only clean files older than 7 days

    try {
      const body = await req.json();
      dryRun = body.dryRun !== false; // Must explicitly set to false to actually delete
      maxFiles = body.maxFiles || 100;
      olderThanDays = body.olderThanDays || 7;
    } catch {
      // Use defaults if no body provided
    }

    console.log(`Starting media cleanup - dryRun: ${dryRun}, maxFiles: ${maxFiles}, olderThanDays: ${olderThanDays}`);

    // Calculate the cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    // Get all media files older than cutoff date
    const { data: allMediaFiles, error: mediaError } = await supabase
      .from("media_files")
      .select("id, cloudinary_public_id, file_path, created_at, user_id, file_type, storage_bucket")
      .lt("created_at", cutoffDate.toISOString())
      .not("cloudinary_public_id", "is", null)
      .limit(maxFiles * 2); // Get more to account for used files

    if (mediaError) {
      console.error("Error fetching media files:", mediaError);
      throw new Error(`Failed to fetch media files: ${mediaError.message}`);
    }

    if (!allMediaFiles || allMediaFiles.length === 0) {
      console.log("No media files found older than cutoff date");
      return new Response(
        JSON.stringify({
          success: true,
          message: "No media files to clean up",
          result: { totalOrphaned: 0, deleted: 0, failed: 0, errors: [], deletedFiles: [] },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${allMediaFiles.length} media files older than ${olderThanDays} days`);

    // Get all posts to check which media files are in use
    const { data: allPosts, error: postsError } = await supabase
      .from("posts")
      .select("media_file_ids");

    if (postsError) {
      console.error("Error fetching posts:", postsError);
      throw new Error(`Failed to fetch posts: ${postsError.message}`);
    }

    // Collect all media file IDs that are in use
    const usedMediaIds = new Set<string>();
    if (allPosts) {
      for (const post of allPosts) {
        if (post.media_file_ids && Array.isArray(post.media_file_ids)) {
          for (const id of post.media_file_ids) {
            usedMediaIds.add(id);
          }
        }
      }
    }

    console.log(`Found ${usedMediaIds.size} media files currently in use by posts`);

    // Find orphaned files (not used by any post)
    const orphanedFiles = allMediaFiles.filter(
      (file) => !usedMediaIds.has(file.id)
    );

    console.log(`Found ${orphanedFiles.length} orphaned media files`);

    // Limit to maxFiles
    const filesToProcess = orphanedFiles.slice(0, maxFiles);

    const result: CleanupResult = {
      totalOrphaned: orphanedFiles.length,
      deleted: 0,
      failed: 0,
      errors: [],
      deletedFiles: [],
    };

    if (dryRun) {
      console.log("DRY RUN - No files will be deleted");
      result.deletedFiles = filesToProcess.map((f) => f.cloudinary_public_id || f.file_path);
      const filesToDelete: OrphanedFilePayload[] = filesToProcess.map((f) => ({
        id: f.id,
        publicId: f.cloudinary_public_id,
        path: f.file_path,
        createdAt: f.created_at,
        fileType: f.file_type ?? "image",
        storageBucket: f.storage_bucket ?? "cloudinary",
        thumbnailUrl: buildThumbnailUrl({
          storageBucket: f.storage_bucket ?? "cloudinary",
          fileType: f.file_type ?? "image",
          publicId: f.cloudinary_public_id,
          filePath: f.file_path,
        }),
      }));
      return new Response(
        JSON.stringify({
          success: true,
          dryRun: true,
          message: `Found ${orphanedFiles.length} orphaned files. Set dryRun: false to delete.`,
          result,
          filesToDelete,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Actually delete files
    for (const file of filesToProcess) {
      try {
        // Delete from Cloudinary
        if (file.cloudinary_public_id) {
          const cloudinaryDeleted = await deleteFromCloudinary(file.cloudinary_public_id);
          if (!cloudinaryDeleted) {
            result.errors.push(`Cloudinary delete failed: ${file.cloudinary_public_id}`);
          }
        }

        const { data: providerRows, error: providerLookupError } = await supabase.from("media_file_providers").select("id, object_key, provider").eq("media_file_id", file.id).neq("status", "deleted");
        if (providerLookupError) { result.failed++; result.errors.push(`Provider lookup failed for ${file.id}: ${providerLookupError.message}`); continue; }
        for (const row of providerRows || []) {
          if (row.provider !== "openinary") continue;
          try {
            const config = getOpeninaryConfig(); if (!config) throw new Error("Openinary unavailable");
            const removed = await deleteFromOpeninary(config, row.object_key);
            if (!removed.success) { result.errors.push(`openinary delete failed: ${removed.error}`); continue; }
            await supabase.from("media_file_providers").update({ status: "deleted", deleted_at: new Date().toISOString(), deleted_reason: "cleanup-media" }).eq("id", row.id);
          } catch (error) { result.errors.push(`openinary delete failed: ${error instanceof Error ? error.message : String(error)}`); }
        }

        // Delete from database
        const { error: deleteError } = await supabase
          .from("media_files")
          .delete()
          .eq("id", file.id);

        if (deleteError) {
          result.failed++;
          result.errors.push(`DB delete failed for ${file.id}: ${deleteError.message}`);
        } else {
          result.deleted++;
          result.deletedFiles.push(file.cloudinary_public_id || file.file_path);
        }
      } catch (error: unknown) {
        result.failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push(`Error processing ${file.id}: ${errorMessage}`);
      }
    }

    console.log(`Cleanup complete: ${result.deleted} deleted, ${result.failed} failed`);

    // Log the cleanup operation
    await supabase.from("system_logs").insert({
      source: "cleanup-media",
      level: result.failed > 0 ? "warn" : "info",
      category: "maintenance",
      message: `Media cleanup completed: ${result.deleted} deleted, ${result.failed} failed`,
      metadata: {
        totalOrphaned: result.totalOrphaned,
        deleted: result.deleted,
        failed: result.failed,
        errors: result.errors.slice(0, 10), // Limit error count in log
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: `Cleaned up ${result.deleted} orphaned files`,
        result,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Cleanup error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
