// YouTube has no comment webhook, so Postora is the event source: one newest-first channel
// sweep, deduped by the inbox insert, then handed to the same door as the Threads poller.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { defaultYouTubeDeps } from "../_shared/youtubeComments.ts";
import { pollYouTubeComments } from "./poll.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  try {
    const summary = await pollYouTubeComments(admin, {
      youtube: defaultYouTubeDeps(),
    });
    return new Response(JSON.stringify({ success: true, ...summary }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`[youtube-poll] ${message}`);
    return new Response(JSON.stringify({ error: "account_listing_failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
