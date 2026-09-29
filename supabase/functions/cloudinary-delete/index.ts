import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteFromOpeninary, getOpeninaryConfig } from "../_shared/openinary.ts";
import { logToDatabase } from "../_shared/logging.ts";
import { destroyCloudinary } from "../_shared/cloudinaryDestroy.ts";
import { authorisedPublicIds, deleteAuthorisedMediaFiles, openinaryObjectKeyMatches } from "./deletePlan.ts";

// The service-role client, typed loosely: the generated schema types are not wired into edge functions.
// deno-lint-ignore no-explicit-any
type ServiceClient = any;

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
    const actorId = user.id;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const serviceClient: ServiceClient | null = serviceRoleKey ? createClient(supabaseUrl, serviceRoleKey) : null;

    // Cloudinary credentials are only required by paths that delete a Cloudinary
    // object — an Openinary-only deployment must still be able to delete via mediaFileIds.
    const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
    const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
    const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");

    const { publicIds, mediaFileIds }: DeleteRequest = await req.json();
    const { data: adminRole, error: roleError } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", actorId)
      .eq("role", "admin")
      .maybeSingle();
    if (roleError) console.error("[cloudinary-delete] admin role lookup failed");
    const isAdmin = !!adminRole && !roleError;

    /** A lookup failure refuses the whole request; it gets a durable row, never the ids or keys. */
    async function logLookupFailure(stage: string) {
      if (!serviceClient) return;
      try {
        await logToDatabase(serviceClient, {
          level: "error",
          category: "system",
          source: "cloudinary-delete",
          message: "Delete refused: lookup failed",
          user_id: actorId,
          metadata: { reason: "lookup_failed", stage },
        });
      } catch {
        console.error("[cloudinary-delete] lookup failure log failed");
      }
    }

    async function logProviderMismatch(count: number) {
      if (count === 0 || !serviceClient) return;
      try {
        await logToDatabase(serviceClient, {
          level: "warn",
          category: "auth",
          source: "cloudinary-delete",
          message: "Refused provider delete: object mismatch",
          user_id: actorId,
          metadata: { reason: "provider_object_mismatch", count },
        });
      } catch {
        console.error("[cloudinary-delete] mismatch log failed");
      }
    }

    async function logProviderFailures(client: ServiceClient | null, failedCount: number, errorCount: number) {
      if (failedCount === 0 && errorCount === 0) return;
      if (!client) { console.error("[cloudinary-delete] provider failure log skipped: no service key"); return; }
      try {
        await logToDatabase(client, {
          level: "error",
          category: "system",
          source: "cloudinary-delete",
          message: "Delete incomplete: provider delete or status update failed",
          user_id: actorId,
          metadata: { reason: "provider_delete_failed", failedCount, errorCount },
        });
      } catch {
        console.error("[cloudinary-delete] provider failure log failed");
      }
    }

    async function removeDeletedRows(client: ServiceClient | null, ids: string[]): Promise<boolean> {
      if (ids.length === 0) return true;
      if (!client) return false;
      const { error } = await client.from("media_files").delete().in("id", ids);
      if (error) {
        console.error("[cloudinary-delete] media row delete failed");
        await logLookupFailure("row_delete");
        return false;
      }
      return true;
    }

    async function logDeleteRefusal(refusedCount: number) {
      if (refusedCount === 0 || !serviceClient) return;
      try {
        await logToDatabase(serviceClient, {
          level: "warn",
          category: "auth",
          source: "cloudinary-delete",
          message: "Refused delete for unauthorised media",
          user_id: actorId,
          metadata: { refusedCount },
        });
      } catch {
        console.error("[cloudinary-delete] refusal log failed");
      }
    }

    if (mediaFileIds && mediaFileIds.length > 0) {
      let mediaQuery = supabase
        .from("media_files")
        .select("id, user_id, file_type, file_path, cloudinary_public_id")
        .in("id", mediaFileIds);
      if (!isAdmin) mediaQuery = mediaQuery.eq("user_id", actorId);
      const { data: mediaRows, error: mediaError } = await mediaQuery;
      if (mediaError) {
        console.error("[cloudinary-delete] media lookup failed");
        await logLookupFailure("media");
        return new Response(JSON.stringify({ success: false, error: "Could not load media files" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const ownedIds = (mediaRows || []).map((row: { id: string }) => row.id);
      let providerRows: Array<{ id: string; media_file_id: string; provider: string; object_key: string; status: string; delivery_url?: string | null }> = [];
      let providerError: { message: string } | null = null;
      if (ownedIds.length > 0) {
        if (!serviceClient) {
          console.error("[cloudinary-delete] provider lookup skipped: no service key");
          await logLookupFailure("provider");
          return new Response(JSON.stringify({ success: false, error: "Could not load stored objects" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const providerLookup = await serviceClient
          .from("media_file_providers")
          .select("id, media_file_id, provider, object_key, status, delivery_url")
          .in("media_file_id", ownedIds);
        providerRows = providerLookup.data || [];
        providerError = providerLookup.error;
      }
      if (providerError) {
        console.error("[cloudinary-delete] provider lookup failed");
        await logLookupFailure("provider");
        return new Response(JSON.stringify({ success: false, error: "Could not load stored objects" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const config = getOpeninaryConfig();
      const outcome = await deleteAuthorisedMediaFiles({
        requestedIds: mediaFileIds,
        rows: mediaRows || [],
        providers: providerRows,
        destroyOpeninary: async (objectKey) => {
          if (!config) return { success: false, error: "openinary unavailable" };
          return deleteFromOpeninary(config, objectKey);
        },
        destroyCloudinary,
        markDeleted: async (providerRowId, reason) => {
          if (!serviceClient) return { error: "provider status update unavailable" };
          const { error } = await serviceClient
            .from("media_file_providers")
            .update({ status: "deleted", deleted_at: new Date().toISOString(), deleted_reason: reason })
            .eq("id", providerRowId);
          return { error: error?.message };
        },
      });
      await logDeleteRefusal(outcome.results.filter((result) => result.status === "refused").length);
      await logProviderMismatch(outcome.mismatchCount);
      await logProviderFailures(serviceClient, outcome.failedMediaFileIds.length, outcome.errors.length);
      // The ids were authorised above (owner, or admin). Remove their rows here: an admin's browser
      // JWT cannot delete another user's row under RLS, which would leave a row for a removed object.
      const rowsRemoved = await removeDeletedRows(serviceClient, outcome.deletedMediaFileIds);
      return new Response(JSON.stringify({
        success: outcome.failedMediaFileIds.length === 0 && rowsRemoved,
        deletedMediaFileIds: outcome.deletedMediaFileIds,
        failedMediaFileIds: outcome.failedMediaFileIds.length ? outcome.failedMediaFileIds : undefined,
        results: outcome.results,
        errors: outcome.errors.length ? outcome.errors : undefined,
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

    let ownedQuery = supabase
      .from("media_files")
      .select("id, user_id, file_type, file_path, cloudinary_public_id")
      .in("cloudinary_public_id", publicIds);
    if (!isAdmin) ownedQuery = ownedQuery.eq("user_id", actorId);
    const { data: ownedRows, error: ownedError } = await ownedQuery;
    if (ownedError) {
      console.error("[cloudinary-delete] public id lookup failed");
        await logLookupFailure("public_id");
      return new Response(JSON.stringify({ success: false, error: "Could not load media files" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { allowed, refused } = authorisedPublicIds(publicIds, ownedRows || []);
    await logDeleteRefusal(refused.length);

    const deleted: string[] = [];
    const failed: string[] = [...refused];
    const providerErrors: string[] = [];
    let mismatchCount = 0;
    const filePathById = new Map((ownedRows || []).map((row: { id: string; file_path?: string | null }) => [row.id, row.file_path ?? null]));
    // cdn_storage is admin-only under RLS; read it as the service role or non-admins see no Openinary.
    const { data: setting } = await (serviceClient ?? supabase).from("app_settings").select("value").eq("key", "cdn_storage").maybeSingle();
    const providers = setting?.value?.write_policy?.providers || ["cloudinary"];

    for (const target of allowed) {
      try {
        const removed = await destroyCloudinary(target.publicId, target.resourceType);
        if (removed.success) deleted.push(target.publicId);
        else failed.push(target.publicId);
        if (providers.includes("openinary")) {
          const config = getOpeninaryConfig();
          if (!serviceClient) { providerErrors.push("openinary lookup failed"); continue; }
          const { data: rows, error: providerLookupError } = await serviceClient
            .from("media_file_providers")
            .select("id, media_file_id, object_key, delivery_url, status")
            .eq("media_file_id", target.mediaFileId)
            .eq("provider", "openinary")
            .neq("status", "deleted");
          if (providerLookupError) { providerErrors.push("openinary lookup failed"); continue; }
          for (const row of rows || []) {
            if (row.status === "failed") continue;
            if (row.media_file_id !== target.mediaFileId || !openinaryObjectKeyMatches(row.object_key, row.delivery_url, filePathById.get(target.mediaFileId))) {
              mismatchCount += 1;
              providerErrors.push("provider object mismatch");
              continue;
            }
            if (!config) { providerErrors.push("openinary unavailable"); continue; }
            const openRemoved = await deleteFromOpeninary(config, row.object_key);
            if (!openRemoved.success) { providerErrors.push(openRemoved.error || "openinary delete failed"); continue; }
            const { error: statusError } = await serviceClient.from("media_file_providers").update({ status: "deleted", deleted_at: new Date().toISOString(), deleted_reason: "user delete" }).eq("id", row.id);
            if (statusError) providerErrors.push("openinary status update failed");
          }
        }
      } catch (err) {
        failed.push(target.publicId);
        console.error("[cloudinary-delete] public id delete failed");
      }
    }

    await logProviderMismatch(mismatchCount);
    const response: DeleteResponse = {
      success: failed.length === 0 && mismatchCount === 0,
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
