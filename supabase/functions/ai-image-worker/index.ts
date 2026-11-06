// Background image generation worker. Cron (every minute) and generate-image's kick call it.
// The door only authenticates and answers 202; the tick runs in waitUntil so neither pg_net's
// timeout nor the gateway's ~60 s response limit can cut a generation. Decisions live in worker.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { runInBackground } from "../_shared/background.ts";
import { createAiImageWorkerPorts } from "./deps.ts";
import { runAiImageWorker } from "./worker.ts";

const WORKER_STARTED_AT_MS = Date.now();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  await runInBackground("ai-image-worker tick", async () => {
    const summary = await runAiImageWorker(createAiImageWorkerPorts(admin, WORKER_STARTED_AT_MS));
    console.log("[ai-image-worker] tick", JSON.stringify(summary));
  });
  return new Response(JSON.stringify({ success: true, accepted: true }), {
    status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
