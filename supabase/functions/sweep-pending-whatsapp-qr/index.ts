import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { corsHeaders, handleCorsOptions } from "../_shared/cors.ts";
import { createEvolutionApi } from "../_shared/evolutionApi.ts";
import { createPendingQrCleanupPorts } from "../_shared/pendingQrCleanupPorts.ts";
import { runSweep, type SweepPorts } from "./run.ts";

const SOURCE = "sweep-pending-whatsapp-qr";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function createPorts(): SweepPorts {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) throw new Error("sweep backend unavailable");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  return {
    ...createPendingQrCleanupPorts(admin, createEvolutionApi(), SOURCE),
    listStalePending: async (cutoffIso, limit) => {
      const { data, error } = await admin
        .from("social_accounts")
        .select("id")
        .eq("platform", "whatsapp")
        .eq("connection_mode", "evolution_qr")
        .eq("is_active", false)
        .like("platform_user_id", "pending_%")
        .lt("connected_at", cutoffIso)
        .order("connected_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message ?? "pending listing failed");
      return (data ?? []).map((row: { id: string }) => row.id);
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsOptions();
  const auth = verifyCronAuth(req);
  if (!auth.ok) return auth.response;

  try {
    return json(200, { success: true, ...(await runSweep(createPorts())) });
  } catch (error) {
    // The listing failed: nothing was deleted.
    console.error(`[${SOURCE}] run failed:`, error instanceof Error ? error.message : String(error));
    return json(500, { success: false, error: "Sweep failed" });
  }
});
