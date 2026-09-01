// Partner webhook delivery worker -- cron-invoked, service role, no user auth.
//
// Design record: docs/decisions/2026-09-02-d5-webhook-substrate.md.
//
// ARCHITECTURE.md §27 forbids treating an Edge Function as a durable queue,
// which is exactly why the queue is a table and this is only the thing that
// drains it. Everything that decides anything lives in worker.ts; this file is
// the door: cron auth, a client, a tick, a summary.
//
// Cadence is 60s, because the retry ladder's finest rung is 1m and a slower
// tick would make that rung a lie.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { runWebhookWorker } from "./worker.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const summary = await runWebhookWorker({ admin });
    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[partner-webhooks] tick failed:", message);
    // 500 is right here and only here: this endpoint's caller is cron, not a
    // partner, and a cron run that failed must be visibly red rather than a
    // 200 carrying bad news nobody reads.
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
