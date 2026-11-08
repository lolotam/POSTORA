// Background job worker. Cron (every minute) and the domain kick call it.
// The door only authenticates and answers 202; the tick runs in waitUntil so neither pg_net's
// timeout nor the gateway's response limit can cut a chunk.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { runInBackground } from "../_shared/background.ts";
import { createBackgroundJobsWorkerPorts } from "./deps.ts";
import { backgroundJobHandlers } from "./handlers/index.ts";
import { runBackgroundJobsWorker } from "./worker.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;
  const workerStartedAtMs = Date.now();
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: { fetch: (input, init) => fetch(input, { ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    }) },
  });
  await runInBackground("background-jobs-worker tick", async () => {
    const ports = createBackgroundJobsWorkerPorts(
      admin,
      workerStartedAtMs,
      backgroundJobHandlers(admin),
    );
    const summary = await runBackgroundJobsWorker(ports);
    console.log("[background-jobs-worker] tick", JSON.stringify(summary));
  });
  return new Response(JSON.stringify({ success: true, accepted: true }), {
    status: 202,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
