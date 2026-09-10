// Test-only PostgREST boundary shared by use-case and routed acceptance tests.
import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import type { AgentConfigContext } from "./agentConfigOps.ts";

export const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_ID = "22222222-2222-4222-8222-222222222222";
export const TOOL_ID = "33333333-3333-4333-8333-333333333333";
export const STORED_CONFIG = { id: "config", social_account_id: ACCOUNT_ID, platform: "whatsapp", persona_instructions: "Speak as our brand", business_profile_text: "Our established business", is_enabled: true, updated_at: "2026-09-10T00:00:00Z" };
type Row = Record<string, unknown>;
export function agentFixture(opts: { failTable?: string; writeFails?: boolean; concurrentPersona?: boolean; entitled?: boolean; claim?: string; settleFails?: boolean; noConfig?: boolean; noTool?: boolean; sharedOutside?: boolean; foreignWorkspace?: boolean; platform?: string } = {}) {
  const reads: URL[] = [];
  const writes: Array<{ table: string; row: Row; url: URL; method: string }> = [];
  const claims: Row[] = [];
  const rows: Record<string, Row[]> = {
    partner_api_keys: [{ id: "key", workspace_id: "ws", social_account_id: ACCOUNT_ID, key_prefix: "pk_live_test", scopes: ["automation:read", "automation:manage"], rate_limit_per_min: 60, monthly_quota: null, revoked_at: null, expires_at: null }],
    partner_provisioned_workspaces: [{ workspace_id: "ws", owner_user_id: "owner" }],
    app_settings: ["feature_msg_whatsapp", "feature_msg_facebook", "feature_msg_instagram", "feature_msg_threads", "feature_youtube_comments"].map((key) => ({ key, value: opts.entitled ?? true })),
    user_feature_overrides: [],
    partner_api_key_accounts: [{ key_id: "key", workspace_id: "ws", social_account_id: ACCOUNT_ID }],
    social_accounts: [{ id: ACCOUNT_ID, workspace_id: opts.foreignWorkspace ? "foreign" : "ws", user_id: "owner", platform: opts.platform ?? "whatsapp", is_active: true }],
    ai_agent_configs: opts.noConfig ? [] : [{ ...STORED_CONFIG }],
    ai_agent_tools: opts.noTool ? [] : [{ id: TOOL_ID, user_id: "owner", social_account_id: ACCOUNT_ID, platform: "whatsapp", name: "brand_tool", scope: "account", settings: { store_url: "https://store.example" }, secret: "never-expose", credentials_secret_id: "vault-id", created_at: "2026-09-10T00:00:00Z" }],
    ai_agent_tool_accounts: opts.sharedOutside ? [{ tool_id: TOOL_ID, social_account_id: OTHER_ID }] : [],
    ai_agent_allowed_models: [{ provider: "openai", model_id: "approved", is_active: true }],
    system_logs: [], partner_api_usage: [], partner_api_idempotency: [],
  };
  const matches = (row: Row, url: URL) => [...url.searchParams].every(([key, value]) => {
    if (value.startsWith("eq.")) return key === "key_hash" || String(row[key]) === value.slice(3);
    if (value === "is.null") return row[key] == null;
    if (value.startsWith("in.(")) return value.slice(4, -1).split(",").map((item) => item.replaceAll('"', "")).includes(String(row[key]));
    return true;
  });
  let settled: Row | undefined;
  let originalHash: unknown;
  const admin = createClient("https://database.example", "test", { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)); const table = url.pathname.split("/").at(-1)!;
    const method = init?.method ?? "GET";
    if (table === "consume_partner_rate_v2") return Response.json({ allowed: true, remaining: 59, reset_seconds: 40 });
    if (table === "claim_partner_idempotency") {
      const row = JSON.parse(String(init?.body)); claims.push(row);
      const outcome = originalHash && originalHash !== row.p_request_hash ? "conflict" : opts.claim ?? (settled ? "replay" : "claimed");
      originalHash ??= row.p_request_hash;
      return Response.json({ outcome, attempt_token: "attempt-1", http_status: settled?.http_status ?? 200, response_body: settled?.response_body ?? { stored: true } });
    }
    if (method !== "GET" && method !== "HEAD") {
      const row = init?.body ? JSON.parse(String(init.body)) : {};
      writes.push({ table, row, url, method });
      if (opts.writeFails && table === "ai_agent_configs") return Response.json({ message: "private write failure" }, { status: 500 });
      if (table === "partner_api_idempotency") {
        if (opts.settleFails && row.state === "completed") return Response.json({ message: "private settlement failure" }, { status: 500 });
        settled = row;
        return new Response(null, { status: 204 });
      }
      if (table === "upsert_connector_credential_secret") return Response.json([{ secret_id: "vault-id", configured_fields: Object.keys(row.p_secret as Row) }]);
      if (table === "delete_connector_credential_secret" || table === "set_ai_agent_tool_accounts") return new Response(null, { status: 204 });
      assert(Object.hasOwn(rows, table), table);
      if (opts.concurrentPersona && table === "ai_agent_configs" && method === "PATCH") Object.assign(rows.ai_agent_configs[0], { persona_instructions: "Concurrent live persona", updated_at: "2026-09-10T00:01:00Z" });
      const affected = rows[table].filter((stored) => matches(stored, url));
      if (method === "DELETE") rows[table] = rows[table].filter((stored) => !matches(stored, url));
      else if (method === "PATCH") affected.forEach((stored) => Object.assign(stored, row));
      else rows[table].push(row);
      const selected = method === "PATCH" ? affected : rows[table].filter((stored) => matches(stored, url));
      if (table === "system_logs" || table === "partner_api_usage") return new Response(null, { status: 204 });
      const accept = new Headers(init?.headers).get("accept") ?? "";
      if (accept.includes("vnd.pgrst.object") && !selected.length) return Response.json({ code: "PGRST116", message: "No rows" }, { status: 406 });
      return Response.json(accept.includes("vnd.pgrst.object") ? selected[0] : selected);
    }
    reads.push(url);
    if (table === opts.failTable) return Response.json({ message: "private read failure" }, { status: 500 });
    assert(Object.hasOwn(rows, table), table);
    return Response.json(rows[table].filter((row) => matches(row, url)).slice(0, Number(url.searchParams.get("limit") ?? 1000)));
  } } });
  const ctx: AgentConfigContext = { admin, workspaceId: "ws", accountIds: [ACCOUNT_ID], requestId: "req", platform: opts.platform ?? "whatsapp" };
  return { admin, ctx, rows, reads, writes, claims };
}
