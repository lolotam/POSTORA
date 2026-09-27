// Store-event opener worker. Cron-invoked, service role, no user auth.
// The queue is store_events; this file is only the door. Decisions live in worker.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { createStoreEventPorts } from "./deps.ts";
import { sanitizeFailureReason, runStoreEventWorker } from "./worker.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const summary = await runStoreEventWorker(createStoreEventPorts(admin));
    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = sanitizeFailureReason(error instanceof Error ? error.message : "tick_failed");
    console.error("[process-store-events] tick failed:", message);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
