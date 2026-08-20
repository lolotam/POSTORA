import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteFromOpeninary, getOpeninaryConfig, openinaryTarget, uploadToOpeninary } from "../_shared/openinary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RenameRequest {
  fileId: string;
  newName: string; // New filename (without extension)
}

interface RenameResponse {
  success: boolean;
  newUrl?: string;
  newPublicId?: string;
  error?: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      console.error("Auth error:", authError);
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Cloudinary credentials
    const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
    const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
    const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");

    if (!cloudName || !apiKey || !apiSecret) {
      console.error("Missing Cloudinary credentials");
      return new Response(
        JSON.stringify({ success: false, error: "Cloudinary not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { fileId, newName }: RenameRequest = await req.json();

    if (!fileId || !newName) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields: fileId, newName" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get the file from database
    const { data: file, error: fetchError } = await supabase
      .from("media_files")
      .select("*")
      .eq("id", fileId)
      .eq("user_id", user.id)
      .single();

    if (fetchError || !file) {
      console.error("File fetch error:", fetchError);
      return new Response(
        JSON.stringify({ success: false, error: "File not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (file.storage_bucket !== "cloudinary" || !file.cloudinary_public_id) {
      return new Response(
        JSON.stringify({ success: false, error: "File is not stored in Cloudinary" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const currentPublicId = file.cloudinary_public_id;
    
    // Extract folder path from current public_id
    const lastSlashIndex = currentPublicId.lastIndexOf("/");
    const folder = lastSlashIndex > -1 ? currentPublicId.substring(0, lastSlashIndex) : "";
    
    // Clean the new name
    const cleanNewName = newName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const newPublicId = folder ? `${folder}/${cleanNewName}` : cleanNewName;

    console.log(`Renaming file: ${currentPublicId} -> ${newPublicId}`);

    // Build timestamp and signature for Cloudinary API
    const timestamp = Math.floor(Date.now() / 1000);
    const signatureParams = [
      `from_public_id=${currentPublicId}`,
      `timestamp=${timestamp}`,
      `to_public_id=${newPublicId}`,
    ].sort().join("&");

    // Create SHA-1 signature
    const encoder = new TextEncoder();
    const data = encoder.encode(signatureParams + apiSecret);
    const hashBuffer = await crypto.subtle.digest("SHA-1", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    // Determine resource type from file type
    const resourceType = file.file_type === "video" ? "video" : "image";
    
    // Call Cloudinary rename API
    const renameUrl = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/rename`;
    
    const formData = new FormData();
    formData.append("from_public_id", currentPublicId);
    formData.append("to_public_id", newPublicId);
    formData.append("api_key", apiKey);
    formData.append("timestamp", timestamp.toString());
    formData.append("signature", signature);

    // Mirror to Openinary BEFORE renaming on Cloudinary.
    //
    // Cloudinary's native rename is atomic, but it kills the old secure_url the
    // moment it lands — and the resolver keeps serving the old object_version until
    // the swap commits below. Doing the Openinary upload after the rename would sit
    // a full download+re-POST inside that window, so a large file would 404 on the
    // live CDN for as long as the mirror took. The bytes are identical either side
    // of a rename, so we can stage the new Openinary object from the OLD URL first
    // and leave the old version completely intact while we do it.
    //
    // What remains is a single DB round-trip between the rename and the swap.
    const { data: cdnSetting } = await supabase
      .from("app_settings").select("value").eq("key", "cdn_storage").maybeSingle();
    const providers = cdnSetting?.value?.write_policy?.providers || ["cloudinary"];

    const renamedFormat =
      (file.file_path?.split(".").pop() || "").toLowerCase().split(/[?#]/)[0] || undefined;
    let stagedOpeninary: { path: string; url: string } | null = null;

    if (providers.includes("openinary")) {
      const config = getOpeninaryConfig();
      if (!config) {
        return new Response(
          JSON.stringify({ success: false, error: "Openinary unavailable" }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const target = openinaryTarget(newPublicId, config.folderPrefix);
      const staged = await uploadToOpeninary(
        config, file.file_path, target.folder, target.baseName, renamedFormat, file.file_size,
      );
      // A collision-renamed object is unreachable by the read side and could shadow
      // an older object holding the intended name, so a key mismatch is a failure.
      const expected = `${target.folder}/${target.baseName}${renamedFormat ? `.${renamedFormat}` : ""}`;
      if (!staged.success || staged.path !== expected) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `Openinary rename upload failed: ${staged.error || "object key mismatch"}`,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      stagedOpeninary = { path: staged.path!, url: staged.url! };
    }

    console.log(`Calling Cloudinary rename API: ${renameUrl}`);
    const renameResponse = await fetch(renameUrl, {
      method: "POST",
      body: formData,
    });

    if (!renameResponse.ok) {
      const errorText = await renameResponse.text();
      console.error("Cloudinary rename failed:", errorText);
      return new Response(
        JSON.stringify({ success: false, error: `Rename failed: ${errorText}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = await renameResponse.json();
    console.log("Cloudinary rename successful:", result);

    // The swap: everything below is DB-only, so the interval during which the old
    // version's now-dead Cloudinary URL is still current is a single round-trip.
    const { data: currentProvider } = await supabase
      .from("media_file_providers")
      .select("object_version, object_key")
      .eq("media_file_id", fileId).eq("provider", "cloudinary").eq("status", "ready")
      .order("object_version", { ascending: false }).limit(1).maybeSingle();
    const nextVersion = (file.current_object_version || currentProvider?.object_version || 1) + 1;

    const providerRows: Record<string, unknown>[] = [{
      media_file_id: fileId, provider: "cloudinary", object_version: nextVersion,
      object_key: result.public_id, delivery_url: result.secure_url, status: "ready",
      bytes: file.file_size, mime_type: file.mime_type,
    }];
    if (stagedOpeninary) {
      providerRows.push({
        media_file_id: fileId, provider: "openinary", object_version: nextVersion,
        object_key: stagedOpeninary.path, delivery_url: stagedOpeninary.url, status: "ready",
        bytes: file.file_size, mime_type: file.mime_type,
      });
    }

    const { error: providerError } = await supabase.from("media_file_providers").insert(providerRows);
    if (providerError) {
      return new Response(
        JSON.stringify({ success: false, error: `Provider swap failed: ${providerError.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    await supabase.from("media_files").update({ current_object_version: nextVersion }).eq("id", fileId);

    // The swap has committed, so the old objects are no longer reachable through the
    // resolver. Retire the old Openinary object now — leaving it would cost storage
    // and, because Openinary never overwrites, a future upload of that same name
    // would be suffixed rather than replacing it. Best-effort: a failure here is a
    // cleanup problem, not a correctness one, and must not fail a completed rename.
    if (stagedOpeninary && currentProvider?.object_key) {
      const { data: oldOpeninary } = await supabase
        .from("media_file_providers")
        .select("id, object_key")
        .eq("media_file_id", fileId).eq("provider", "openinary")
        .eq("object_version", file.current_object_version || 1).maybeSingle();
      if (oldOpeninary?.object_key) {
        const config = getOpeninaryConfig();
        if (config) {
          const removed = await deleteFromOpeninary(config, oldOpeninary.object_key);
          await supabase.from("media_file_providers").update({
            status: "deleted",
            deleted_at: new Date().toISOString(),
            deleted_reason: removed?.success ? "superseded by rename" : "superseded by rename (remote delete failed)",
          }).eq("id", oldOpeninary.id);
        }
      }
    }

    // Update database with new URL and public_id
    const { error: updateError } = await supabase
      .from("media_files")
      .update({
        file_path: result.secure_url,
        cloudinary_public_id: result.public_id,
      })
      .eq("id", fileId);

    if (updateError) {
      console.error("Database update error:", updateError);
      return new Response(
        JSON.stringify({ success: false, error: `Database update failed: ${updateError.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const response: RenameResponse = {
      success: true,
      newUrl: result.secure_url,
      newPublicId: result.public_id,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Cloudinary rename error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
