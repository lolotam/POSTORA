import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleRestrictedCorsOptions, restrictedJsonResponse, restrictedErrorResponse } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);

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

    if (req.method === "GET") {
      // Fetch all cron jobs
      const { data: jobs, error: jobsError } = await supabaseAdmin.rpc("get_cron_jobs");
      if (jobsError) {
        console.error("Error fetching cron jobs:", jobsError);
        // Fallback: try direct SQL via a simpler approach
        return restrictedErrorResponse(req, "Failed to fetch cron jobs: " + jobsError.message);
      }

      return restrictedJsonResponse(req, { jobs: jobs || [] });
    }

    if (req.method === "POST") {
      const { jobid, active } = await req.json();
      if (typeof jobid !== "number" || typeof active !== "boolean") {
        return restrictedErrorResponse(req, "Invalid request: jobid (number) and active (boolean) required", 400);
      }

      const { data, error: toggleError } = await supabaseAdmin.rpc("toggle_cron_job", {
        _jobid: jobid,
        _active: active,
      });

      if (toggleError) {
        console.error("Error toggling cron job:", toggleError);
        return restrictedErrorResponse(req, "Failed to toggle cron job: " + toggleError.message);
      }

      return restrictedJsonResponse(req, { success: true, jobid, active });
    }

    return restrictedErrorResponse(req, "Method not allowed", 405);
  } catch (err) {
    console.error("manage-cron-jobs error:", err);
    return restrictedErrorResponse(req, err.message || "Internal server error");
  }
});
