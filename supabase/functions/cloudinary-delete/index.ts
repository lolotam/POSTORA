import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteFromOpeninary, getOpeninaryConfig } from "../_shared/openinary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DeleteRequest {
  publicIds: string[]; // Cloudinary public IDs to delete
  resourceType?: "image" | "video";
  mediaFileIds?: string[]; // media_files IDs to delete across all providers (openinary-primary rows)
}

interface DeleteResponse {
  success: boolean;
  deleted?: string[];
  failed?: string[];
  error?: string;
  errors?: string[];
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

    console.log(`User ${user.id} requesting Cloudinary delete`);

    // Cloudinary credentials are only required by paths that delete a Cloudinary
    // object — an Openinary-only deployment must still be able to delete via mediaFileIds.
    const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
    const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
    const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");

    const { publicIds, resourceType = "image", mediaFileIds }: DeleteRequest = await req.json();

    // mediaFileIds path: resolve every stored provider object for each media row and
    // delete from the right cloud (used for openinary-primary rows that have no
    // Cloudinary public_id).
    if (mediaFileIds && mediaFileIds.length > 0) {
      const deletedIds: string[] = [];
      const failedIds: string[] = [];
      const errors: string[] = [];
      const config = getOpeninaryConfig();

      const { data: providerRows, error: providerError } = await supabase
        .from("media_file_providers")
        .select("id, media_file_id, provider, object_key, object_version, status")
        .in("media_file_id", mediaFileIds)
        .neq("status", "deleted");

      if (providerError) {
        return new Response(JSON.stringify({ success: false, error: `Provider lookup failed: ${providerError.message}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      for (const mediaFileId of mediaFileIds) {
        let anyFailure = false;
        for (const row of (providerRows || []).filter((r: any) => r.media_file_id === mediaFileId)) {
          try {
            if (row.provider === "openinary") {
              if (!config) { errors.push(`openinary: unavailable`); anyFailure = true; continue; }
              const removed = await deleteFromOpeninary(config, row.object_key);
              if (!removed.success) { errors.push(`openinary: ${removed.error}`); anyFailure = true; continue; }
            } else if (row.provider === "cloudinary") {
              if (!cloudName || !apiKey || !apiSecret) { errors.push("cloudinary: credentials unavailable"); anyFailure = true; continue; }
              const timestamp = Math.floor(Date.now() / 1000);
              const signatureParams = [`public_id=${row.object_key}`, `timestamp=${timestamp}`].sort().join("&");
              const encoder = new TextEncoder();
              const signData = encoder.encode(signatureParams + apiSecret);
              const hashBuffer = await crypto.subtle.digest("SHA-1", signData);
              const signature = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
              const formData = new FormData();
              formData.append("public_id", row.object_key);
              formData.append("api_key", apiKey);
              formData.append("timestamp", timestamp.toString());
              formData.append("signature", signature);
              const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`, { method: "POST", body: formData });
              const result = await response.json();
              if (result.result !== "ok" && result.result !== "not found") { errors.push(`cloudinary: ${result?.error?.message || response.status}`); anyFailure = true; continue; }
            }
            await supabase.from("media_file_providers").update({ status: "deleted", deleted_at: new Date().toISOString(), deleted_reason: "user delete" }).eq("id", row.id);
          } catch (err: any) {
            errors.push(`${row.provider}: ${err?.message || String(err)}`);
            anyFailure = true;
          }
        }
        if (anyFailure) failedIds.push(mediaFileId); else deletedIds.push(mediaFileId);
      }

      return new Response(JSON.stringify({
        success: failedIds.length === 0,
        deletedMediaFileIds: deletedIds,
        failedMediaFileIds: failedIds.length ? failedIds : undefined,
        errors: errors.length ? errors : undefined,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!publicIds || publicIds.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "No public IDs provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!cloudName || !apiKey || !apiSecret) {
      console.error("Missing Cloudinary credentials");
      return new Response(
        JSON.stringify({ success: false, error: "Cloudinary not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Deleting ${publicIds.length} files from Cloudinary`);

    const deleted: string[] = [];
    const failed: string[] = [];
    const providerErrors: string[] = [];
    const { data: setting } = await supabase.from("app_settings").select("value").eq("key", "cdn_storage").maybeSingle();
    const providers = setting?.value?.write_policy?.providers || ["cloudinary"];

    // Delete each file from Cloudinary
    for (const publicId of publicIds) {
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        
        // Build signature string
        const signatureParams = [
          `public_id=${publicId}`,
          `timestamp=${timestamp}`,
        ].sort().join("&");

        // Create SHA-1 signature
        const encoder = new TextEncoder();
        const data = encoder.encode(signatureParams + apiSecret);
        const hashBuffer = await crypto.subtle.digest("SHA-1", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const signature = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

        // Determine resource type from publicId or use provided
        const deleteUrl = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`;

        const formData = new FormData();
        formData.append("public_id", publicId);
        formData.append("api_key", apiKey);
        formData.append("timestamp", timestamp.toString());
        formData.append("signature", signature);

        const response = await fetch(deleteUrl, {
          method: "POST",
          body: formData,
        });

        const result = await response.json();
        
        if (result.result === "ok" || result.result === "not found") {
          deleted.push(publicId);
          console.log(`Deleted from Cloudinary: ${publicId}`);
        } else {
          failed.push(publicId);
          console.error(`Failed to delete ${publicId}:`, result);
        }
        if (providers.includes("openinary")) {
          const config = getOpeninaryConfig();
          const { data: cloudinaryRow, error: lookupError } = await supabase.from("media_file_providers").select("media_file_id").eq("provider", "cloudinary").eq("object_key", publicId).neq("status", "deleted").maybeSingle();
          if (lookupError) { providerErrors.push(`openinary lookup failed: ${lookupError.message}`); continue; }
          const { data: rows, error: providerLookupError } = cloudinaryRow ? await supabase.from("media_file_providers").select("id, object_key, object_version").eq("media_file_id", cloudinaryRow.media_file_id).eq("provider", "openinary").neq("status", "deleted") : { data: [], error: null };
          if (providerLookupError) { providerErrors.push(`openinary lookup failed: ${providerLookupError.message}`); continue; }
          for (const row of rows || []) {
            if (!config) { providerErrors.push(`openinary: ${publicId}: unavailable`); continue; }
            const removed = await deleteFromOpeninary(config, row.object_key);
            if (!removed.success) { providerErrors.push(`openinary: ${publicId}: ${removed.error}`); continue; }
            await supabase.from("media_file_providers").update({ status: "deleted", deleted_at: new Date().toISOString(), deleted_reason: "user delete" }).eq("id", row.id);
          }
        }
      } catch (err) {
        failed.push(publicId);
        console.error(`Error deleting ${publicId}:`, err);
      }
    }

    const response: DeleteResponse = {
      success: failed.length === 0,
      deleted,
      failed: failed.length > 0 ? failed : undefined,
      errors: providerErrors.length ? providerErrors : undefined,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Cloudinary delete error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
