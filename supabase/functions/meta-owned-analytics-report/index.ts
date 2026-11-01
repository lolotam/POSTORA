import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { redactSensitive } from "../_shared/logging.ts";
import { createStoredReportHandler } from "./handler.ts";
import { PersistedReportRefused } from "./store.ts";

export function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const client = url && key ? createClient(url, key) : null;
  return createStoredReportHandler({ secret: key ?? "",
    authenticate: (request, actingUserId) => {
      if (!client) throw new PersistedReportRefused("storage_unavailable", 503);
      return authenticateCaller(request, actingUserId);
    },
    rpc: (name, args, signal) => {
      if (!client) throw new PersistedReportRefused("storage_unavailable", 503);
      return client.rpc(name, args).abortSignal(signal);
    },
    audit: async (event, signal) => {
      if (!client) return false;
      const receipt = await client.from("system_logs").insert({ level: event.status === 200 ? "info" : "warn", category: "edge",
        source: "meta-owned-analytics-report", message: "Persisted analytics report finished", metadata: redactSensitive(event) }).abortSignal(signal);
      return receipt.error === null;
    },
  })(req);
}
if (import.meta.main) Deno.serve(handler);
