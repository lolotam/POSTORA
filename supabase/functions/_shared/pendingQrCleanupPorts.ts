/** The real ports for pendingQrCleanup.ts: the service-role client, Evolution and system_logs. */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { EvolutionApiError, type EvolutionApi } from "./evolutionApi.ts";
import { logToDatabase } from "./logging.ts";
import type { PendingQrCleanupPorts } from "./pendingQrCleanup.ts";

export function createPendingQrCleanupPorts(
  admin: SupabaseClient,
  evolution: Pick<EvolutionApi, "deleteInstance">,
  source: string,
): PendingQrCleanupPorts {
  return {
    findInstanceName: async (accountId) => {
      const { data, error } = await admin
        .from("whatsapp_evolution_instances")
        .select("instance_name")
        .eq("social_account_id", accountId)
        .maybeSingle();
      if (error) throw new Error(error.message ?? "instance lookup failed");
      return data?.instance_name ?? null;
    },
    deleteIfPending: async (accountId, ownerId) => {
      let query = admin
        .from("social_accounts")
        .delete()
        .eq("id", accountId)
        .eq("platform", "whatsapp")
        .eq("connection_mode", "evolution_qr")
        .eq("is_active", false)
        .like("platform_user_id", "pending_%");
      if (ownerId) query = query.eq("user_id", ownerId);
      const { data, error } = await query.select("id");
      if (error) throw new Error(error.message ?? "account delete failed");
      return Array.isArray(data) && data.length > 0;
    },
    deleteEvolutionInstance: async (instanceName) => {
      try {
        await evolution.deleteInstance(instanceName);
      } catch (error) {
        // Already gone on the provider side (restart, earlier cleanup): nothing left to remove.
        if (error instanceof EvolutionApiError && error.status === 404) return;
        throw error;
      }
    },
    log: (level, message, metadata) =>
      logToDatabase(admin, { level, category: "system", source, message, metadata }),
  };
}
