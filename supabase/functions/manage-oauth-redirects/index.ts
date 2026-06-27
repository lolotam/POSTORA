import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleRestrictedCorsOptions, restrictedJsonResponse, restrictedErrorResponse } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);

  if (req.method !== "POST") {
    return restrictedErrorResponse(req, "Method not allowed", 405);
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return restrictedErrorResponse(req, "Unauthorized", 401);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return restrictedErrorResponse(req, "Unauthorized", 401);

    const { data: roleData } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleData) return restrictedErrorResponse(req, "Admin access required", 401);

    const { client_id, redirect_uris } = await req.json();

    if (!client_id || !Array.isArray(redirect_uris)) {
      return restrictedErrorResponse(req, "client_id (string) and redirect_uris (string[]) required", 400);
    }

    // Use Supabase Management API to update the OAuth client's redirect URIs
    // The admin client's auth.admin namespace may not have oauth methods,
    // so we call the Auth Admin API directly
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Try the Auth Admin API endpoint for OAuth clients
    const response = await fetch(
      `${supabaseUrl}/auth/v1/admin/oauth/clients/${client_id}`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${serviceRoleKey}`,
          "apikey": serviceRoleKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ redirect_uris }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("Supabase OAuth API error:", response.status, errorBody);
      
      // If the admin API doesn't support this endpoint, return a helpful message
      if (response.status === 404) {
        return restrictedJsonResponse(req, {
          success: false,
          synced: false,
          message: "Supabase Auth Admin API for OAuth clients not available. URIs updated in local DB only. Please also update in Supabase Dashboard manually.",
          error_detail: errorBody,
        });
      }
      
      return restrictedErrorResponse(req, `Failed to sync with Supabase OAuth server: ${errorBody}`, response.status);
    }

    const result = await response.json();
    console.log("OAuth client updated successfully:", result);

    return restrictedJsonResponse(req, {
      success: true,
      synced: true,
      message: "Redirect URIs synced to Supabase OAuth server",
      client_id,
      redirect_uris,
    });
  } catch (err) {
    console.error("manage-oauth-redirects error:", err);
    return restrictedErrorResponse(req, err.message || "Internal server error");
  }
});
