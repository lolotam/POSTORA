import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { recordSystemAudit } from "../_shared/systemLogAudit.ts";
import { createStoredReportHandler } from "./handler.ts";
import { PersistedReportRefused } from "./store.ts";

export function handler(req: Request): Promise<Response> {
  let authenticated = false;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const client = url && key ? createClient(url, key) : null;
  return createStoredReportHandler({ secret: key ?? "",
    authenticate: async (request, actingUserId) => {
      if (!client) throw new PersistedReportRefused("storage_unavailable", 503);
      const caller = await authenticateCaller(request, actingUserId);
      authenticated = true;
      return caller;
    },
    rpc: (name, args, signal) => {
      if (!client) throw new PersistedReportRefused("storage_unavailable", 503);
      return client.rpc(name, args).abortSignal(signal);
    },
    audit: async (event, signal) => {
      if (!client) return false;
      return await recordSystemAudit({ client, signal,
        refusalKey: authenticated ? undefined : `meta-owned-analytics-report:${event.status}`, entry: {
          level: event.status === 200 ? "info" : "warn", category: "edge", source: "meta-owned-analytics-report",
          message: "Persisted analytics report finished", metadata: event,
        } });
    },
  })(req);
}
if (import.meta.main) Deno.serve(handler);
