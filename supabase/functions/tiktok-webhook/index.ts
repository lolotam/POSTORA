import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { applyPendingWebhookEvents } from "../_shared/tiktokPublishOutcome.ts";
import { handleTikTokWebhook } from "./handler.ts";

Deno.serve((req) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const admin: SupabaseClient | null = url && serviceRoleKey
    ? createClient(url, serviceRoleKey)
    : null;

  return handleTikTokWebhook(req, {
    clientSecret: Deno.env.get("TIKTOK_CLIENT_SECRET") ?? null,
    webhookSecret: Deno.env.get("TIKTOK_WEBHOOK_SECRET") ?? null,
    nowSeconds: () => Date.now() / 1000,
    admin,
    applyPending: applyPendingWebhookEvents,
    log: (message) => console.log(message),
  });
});
