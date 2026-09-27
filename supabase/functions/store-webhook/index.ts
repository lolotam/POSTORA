import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkIpRateLimit, checkUserRateLimit } from "../_shared/rate-limiter.ts";
import { enabledStoreFlows, handleStoreWebhook, type ScopedWaitlistRow, type StoreWebhookDeps } from "./handler.ts";

function deps(): StoreWebhookDeps {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  return {
    limitIp: (req) => checkIpRateLimit(admin, "store-webhook", req, 120, 60),
    limitConnector: (connectorId) => checkUserRateLimit(admin, "store-webhook:connector", connectorId, 600, 60),
    async loadBinding(id) {
      const { data, error } = await admin.from("store_webhook_bindings")
        .select("id, user_id, social_account_id, connector_id").eq("id", id).maybeSingle();
      if (error) throw new Error("binding_read_failed");
      return data;
    },
    async loadSecrets(bindingId) {
      const { data, error } = await admin.rpc("get_store_webhook_secret", { p_binding_id: bindingId });
      if (error) throw new Error("secret_read_failed");
      const row = (data ?? {}) as { current?: string; previous?: string | null; rotated_at?: string | null };
      if (typeof row.current !== "string" || !row.current) return null;
      return { current: row.current, previous: row.previous ?? null, rotatedAt: row.rotated_at ?? null };
    },
    async loadProcedures(socialAccountId) {
      const { data, error } = await admin.from("ai_agent_configs")
        .select("agent_behavior").eq("social_account_id", socialAccountId).eq("platform", "whatsapp").maybeSingle();
      if (error) throw new Error("config_read_failed");
      const behavior = data?.agent_behavior as { procedures?: unknown } | null;
      return behavior?.procedures;
    },
    flowsFrom: enabledStoreFlows,
    async loadWaitlist(binding, productId): Promise<ScopedWaitlistRow[]> {
      const { data, error } = await admin.from("stock_waitlist")
        .select("id, product_id, parent_id, phone, connector_id, social_account_id")
        .eq("connector_id", binding.connector_id)
        .eq("social_account_id", binding.social_account_id)
        .or(`product_id.eq.${productId},parent_id.eq.${productId}`);
      if (error) throw new Error("waitlist_read_failed");
      return (data ?? []).map((row: {
        id: string;
        product_id: number;
        parent_id: number | null;
        phone: string | null;
        connector_id: string;
        social_account_id: string;
      }) => ({
        id: row.id,
        product_id: Number(row.product_id),
        parent_id: row.parent_id == null ? null : Number(row.parent_id),
        phone: typeof row.phone === "string" ? row.phone : "",
        connector_id: row.connector_id,
        social_account_id: row.social_account_id,
      }));
    },
    async insertEvents(rows) {
      const { data, error } = await admin.from("store_events")
        .upsert(rows, { onConflict: "binding_id,flow,external_id", ignoreDuplicates: true })
        .select("id");
      if (error) return { ok: false };
      return { ok: true, stored: data?.length ?? 0 };
    },
    now: () => new Date(),
  };
}

Deno.serve((req) => handleStoreWebhook(req, deps()));
