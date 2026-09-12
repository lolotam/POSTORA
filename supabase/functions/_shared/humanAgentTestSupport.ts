// deno-lint-ignore-file no-import-prefix require-await
// Real Supabase client, fake HTTP boundary: exercise Auth and PostgREST encoding.
// The fake fetch is async to match fetch's contract, with immediate responses.
import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
export const AGENT_ID = "11111111-1111-4111-8111-111111111111";
export const IDENTITY_ID = "22222222-2222-4222-8222-222222222222";
export const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
type Row = Record<string, unknown>;
export const AGENT_ROW = { id: AGENT_ID, workspace_id: "ws", user_id: IDENTITY_ID, display_name: "Support", status: "offline", max_conversations: 10, current_conversations: 2, last_seen_at: null, created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z" };
export function humanAgentFixture(opts: { entitled?: boolean; claim?: string; failRead?: string; rpcFails?: boolean; responseLost?: boolean; cleanupFails?: boolean; createFails?: boolean; settleFails?: boolean; deleteRace?: boolean; incompleteRecovery?: boolean; assignmentRpcFails?: boolean } = {}) {
  const reads: URL[] = [];
  const writes: { table: string; method: string; row: Row; url: URL }[] = [];
  const creates: Row[] = [], deletes: string[] = [], claims: Row[] = [];
  const identities = new Set<string>();
  const emails = new Set<string>();
  const rows: Record<string, Row[]> = {
    partner_api_keys: [{ id: "key", workspace_id: "ws", social_account_id: "account", key_prefix: "pk_live_test", scopes: ["agents:read", "agents:manage"], rate_limit_per_min: 60, monthly_quota: null, revoked_at: null, expires_at: null }],
    partner_provisioned_workspaces: [{ workspace_id: "ws", owner_user_id: "owner" }],
    app_settings: [{ key: "feature_human_agent", value: opts.entitled ?? true }], user_feature_overrides: [],
    whatsapp_agents: [{ ...AGENT_ROW }], whatsapp_conversation_assignments: [], whatsapp_assignment_history: [], messaging_cache: [], partner_api_key_accounts: [], system_logs: [], partner_api_usage: [], partner_api_idempotency: [],
  };
  const NON_PREDICATE = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
  const matches = (row: Row, url: URL) => [...url.searchParams].every(([key, value]) => {
    if (value.startsWith("eq.")) return key === "key_hash" || String(row[key]) === value.slice(3);
    if (value === "is.null") return row[key] == null;
    if (value === "not.is.null") return row[key] != null;
    if (value.startsWith("in.(")) return value.slice(4, -1).split(",").includes(String(row[key]));
    if (key === "or") {
      const cursor = value.match(/^\((\w+)\.lt\.([^,]+),and\(\1\.eq\.\2,id\.lt\.([^()]+)\)\)$/);
      assert(cursor); return String(row[cursor[1]]) < cursor[2] || (row[cursor[1]] === cursor[2] && String(row.id) < cursor[3]);
    }
    // A predicate this fixture does not model must fail the test, not quietly
    // match every row: an ignored filter makes an unfiltered query look correct,
    // which is how a missing `is.null` let a closed assignment block a delete.
    assert(NON_PREDICATE.has(key), `Unsupported fixture filter: ${key}=${value}`);
    return true;
  });
  const settled = new Map<string, Row>(), hashes = new Map<string, string>();
  const admin = createClient("https://database.example", "test", { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)), table = url.pathname.split("/").at(-1)!;
    const method = init?.method ?? "GET", row = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname.startsWith("/auth/")) {
      if (method === "POST") {
        creates.push(row);
        if (opts.createFails) return Response.json({ msg: "unavailable" }, { status: 500 });
        if (emails.has(row.email)) return Response.json({ msg: "User already registered" }, { status: 422 });
        emails.add(row.email);
        identities.add(IDENTITY_ID); return Response.json({ id: IDENTITY_ID, email: row.email });
      }
      assert(method === "DELETE", `Unexpected Auth method ${method}`); deletes.push(table);
      if (opts.cleanupFails) return Response.json({ msg: "unavailable" }, { status: 500 });
      identities.delete(table); return Response.json({});
    }
    if (table === "consume_partner_rate_v2") return Response.json({ allowed: true, remaining: 59, reset_seconds: 40 });
    if (table === "claim_partner_idempotency") {
      claims.push(row); const key = row.p_idempotency_key, previous = settled.get(key);
      const outcome = hashes.has(key) && hashes.get(key) !== row.p_request_hash ? "conflict" : opts.claim ?? (previous?.state === "indeterminate" ? "indeterminate" : previous ? "replay" : "claimed");
      if (!hashes.has(key)) hashes.set(key, row.p_request_hash);
      return Response.json({ outcome, attempt_token: claims.length === 1 ? ATTEMPT_ID : crypto.randomUUID(), http_status: previous?.http_status ?? 201, response_body: previous?.response_body ?? { stored: true } });
    }
    if (method !== "GET") {
      writes.push({ table, method, row, url });
      if (table === "partner_write_conversation_assignment") {
        if (opts.assignmentRpcFails) return Response.json({ message: "private SQL failure" }, { status: 500 });
        const conversation = rows.messaging_cache.find((c) => c.id === row.p_conversation_cache_id && c.workspace_id === row.p_workspace_id && c.platform === "whatsapp" && rows.partner_api_key_accounts.some((b) => b.key_id === row.p_key_id && b.workspace_id === c.workspace_id && b.social_account_id === c.social_account_id));
        const agent = rows.whatsapp_agents.find((a) => a.id === row.p_agent_id && a.workspace_id === row.p_workspace_id);
        if (!conversation || (!row.p_unassign && !agent)) return Response.json({ error: "resource_not_found" });
        const previous = rows.whatsapp_conversation_assignments.find((a) => a.workspace_id === row.p_workspace_id && a.conversation_id === conversation.conversation_id && a.unassigned_at === null);
        if (row.p_unassign && !previous) return Response.json({ error: "resource_not_found" });
        const now = new Date().toISOString();
        if (previous) { previous.unassigned_at = now; previous.conversation_cache_id = row.p_conversation_cache_id; }
        const assignment = row.p_unassign ? previous! : { id: crypto.randomUUID(), workspace_id: row.p_workspace_id, conversation_cache_id: row.p_conversation_cache_id, conversation_id: conversation.conversation_id, agent_id: row.p_agent_id, assigned_at: now, unassigned_at: null, notes: row.p_notes };
        if (!row.p_unassign) rows.whatsapp_conversation_assignments.push(assignment);
        rows.whatsapp_assignment_history.push({ id: crypto.randomUUID(), workspace_id: row.p_workspace_id, conversation_id: conversation.conversation_id, action: row.p_unassign ? "unassigned" : previous ? "transferred" : "assigned", from_agent_id: previous?.agent_id ?? null, to_agent_id: row.p_unassign ? null : row.p_agent_id, reason: row.p_notes, created_at: now });
        return Response.json(assignment);
      }
      if (table === "provision_partner_agent") {
        if (opts.responseLost || !opts.rpcFails) rows.whatsapp_agents.push({ ...AGENT_ROW, display_name: row.p_display_name, max_conversations: row.p_max_conversations });
        if (opts.rpcFails || opts.responseLost) return Response.json({ message: "private SQL failure" }, { status: 500 });
        return Response.json(rows.whatsapp_agents.at(-1));
      }
      if (table === "partner_api_idempotency") {
        if (opts.settleFails && row.state === "completed") return Response.json({ message: "private error" }, { status: 500 });
        settled.set(url.searchParams.get("idempotency_key")!.slice(3), row); return new Response(null, { status: 204 });
      }
      assert(Object.hasOwn(rows, table), table);
      if (method === "POST") { rows[table].push(row); return new Response(null, { status: 204 }); }
      if (method === "DELETE" && opts.deleteRace) return Response.json({ code: "23503", message: "private FK" }, { status: 409 });
      const selected = rows[table].filter((stored) => matches(stored, url));
      if (method === "PATCH") selected.forEach((stored) => Object.assign(stored, row));
      if (method === "DELETE") rows[table] = rows[table].filter((stored) => !matches(stored, url));
      return Response.json(selected);
    }
    reads.push(url);
    if (opts.failRead === table) return Response.json({ message: "private read failure" }, { status: 500 });
    assert(Object.hasOwn(rows, table), table);
    const selected = rows[table].filter((stored) => matches(stored, url)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
    const count = opts.incompleteRecovery && url.searchParams.get("select") === "id,user_id" ? 1001 : selected.length;
    // Deliberately return private columns too: serializers must whitelist even
    // if an upstream RPC/query grows its projection.
    return Response.json(selected.slice(0, Number(url.searchParams.get("limit") ?? 1000)), { headers: { "content-range": `0-${Math.max(0, selected.length - 1)}/${count}` } });
  } } });
  return { admin, rows, reads, writes, creates, deletes, identities, claims, ctx: { admin, workspaceId: "ws", requestId: "req" } };
}
