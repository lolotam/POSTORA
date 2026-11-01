import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { redactSensitive } from "../_shared/logging.ts";
import { createOwnedAnalyticsSyncHandler } from "./handler.ts";
import { AnalyticsWorkerStopped } from "./deadline.ts";

/** Runtime composition only; no admission, token read or provider request happens on boot. */
export function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const client = url && key ? createClient(url, key) : null;
  return createOwnedAnalyticsSyncHandler({
    authorize: (request) => {
      const checked = verifyCronAuth(request);
      return checked.ok ? { ok: true } : { ok: false, status: checked.response.status === 503 ? 503 : 401 };
    },
    app: (platform) => {
      const prefix = platform === "facebook" ? "FACEBOOK" : "THREADS";
      const id = Deno.env.get(`${prefix}_APP_ID`);
      const secret = Deno.env.get(`${prefix}_APP_SECRET`);
      return id?.trim() && secret?.trim() ? { id: id.trim(), secret: secret.trim() } : null;
    },
    rpc: (name, args, signal) => {
      if (!client) throw new AnalyticsWorkerStopped("storage_unavailable");
      return client.rpc(name, args).abortSignal(signal);
    },
    audit: async (event, signal) => {
      if (!client) return false;
      const result = await client.from("system_logs").insert({ level: "info", category: "edge", source: "meta-owned-analytics-sync",
        message: "Owned analytics admission finished", metadata: redactSensitive(event) }).abortSignal(signal);
      return result.error === null;
    },
  })(req);
}

if (import.meta.main) Deno.serve(handler);
