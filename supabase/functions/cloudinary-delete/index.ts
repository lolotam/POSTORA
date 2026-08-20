import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteFromOpeninary, getOpeninaryConfig } from "../_shared/openinary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DeleteRequest {
  publicIds: string[]; // Cloudinary public IDs to delete
  resourceType?: "image" | "video";
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

    const { publicIds, resourceType = "image" }: DeleteRequest = await req.json();

    if (!publicIds || publicIds.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "No public IDs provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
