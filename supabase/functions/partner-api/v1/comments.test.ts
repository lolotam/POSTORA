import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { listComments } from "../../_shared/commentOps.ts";
import { YOUTUBE_COMMENT_SCOPE } from "../../_shared/youtubeCommentCapability.ts";
import { handleRequest } from "../index.ts";
import { withPartnerAuth } from "./authenticated.ts";
import { deleteCommentRoute, getCommentRoute, hideCommentRoute, listCommentsRoute, replyCommentRoute } from "./comments.ts";

const ID = "22222222-2222-4222-8222-222222222222";
const OTHER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = { id: ID, workspace_id: "ws", platform: "facebook", platform_user_id: "page", access_token: "secret", is_active: true };
const cases = [
  ["GET", "", "list_comments", listCommentsRoute],
  ["GET", "/{id}", "get_comment", getCommentRoute],
  ["POST", "/{id}/reply", "reply_comment", replyCommentRoute],
  ["POST", "/{id}/hide", "hide_comment", hideCommentRoute],
  ["DELETE", "/{id}", "delete_comment", deleteCommentRoute],
] as const;
function fixture(opts: { entitled?: boolean; claim?: string; unbound?: boolean; settleFails?: boolean; providerFailure?: string; platform?: string; failTable?: string } = {}) {
  const reads: URL[] = [];
  const writes: Array<{ table: string; row: Record<string, unknown>; url: URL }> = [];
  const claims: Record<string, unknown>[] = [];
  const providerWrites: { url: string; body: unknown; method: string }[] = [];
  let settled: Record<string, unknown> | undefined;
  let originalHash: string | undefined;
  const admin = createClient("https://database.example", "test", { auth: { persistSession: false }, global: { fetch: (input, init) => {
    const url = new URL(String(input)); const table = url.pathname.split("/").at(-1)!;
    if (table === "consume_partner_rate_v2") return Promise.resolve(Response.json({ allowed: true, remaining: 59, reset_seconds: 40 }));
    if (table === "claim_partner_idempotency") {
      const row = JSON.parse(String(init?.body)); claims.push(row);
      const outcome = originalHash && row.p_request_hash !== originalHash ? "conflict" : opts.claim ?? (settled ? "replay" : "claimed");
      originalHash ??= row.p_request_hash;
      return Promise.resolve(Response.json({ outcome, attempt_token: "attempt-1", http_status: settled?.http_status ?? 200, response_body: settled?.response_body ?? { original: true } }));
    }
    if (init?.method === "PATCH" || init?.method === "POST") {
      const row = JSON.parse(String(init.body)); writes.push({ table, row, url });
      if (table === "partner_api_idempotency") {
        if (opts.settleFails && row.state === "completed") return Promise.resolve(Response.json({ message: "settlement unavailable" }, { status: 500 }));
        settled = row;
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    reads.push(url);
    if (table === opts.failTable) return Promise.resolve(Response.json({ message: "private read error" }, { status: 500 }));
    const rows: Record<string, unknown[]> = {
      partner_api_keys: [{ id: "key", workspace_id: "ws", social_account_id: OTHER, key_prefix: "pk_live_test", scopes: ["comments:read", "comments:manage"], rate_limit_per_min: 60, monthly_quota: null, revoked_at: null, expires_at: null }],
      partner_provisioned_workspaces: [{ owner_user_id: "owner" }],
      app_settings: [{ key: "feature_comment_manager", value: opts.entitled ?? true }],
      user_feature_overrides: [],
      partner_api_key_accounts: [{ social_account_id: opts.unbound ? OTHER : ID }],
      social_accounts: [{ ...ACCOUNT, platform: opts.platform ?? ACCOUNT.platform, token_expires_at: "2099-01-01T00:00:00Z", account_metadata: { granted_scopes: [YOUTUBE_COMMENT_SCOPE] } }],
    };
    assert(Object.hasOwn(rows, table), table);
    return Promise.resolve(Response.json(rows[table]));
  } } });
  const deps = { signingSecret: "route-test-secret", fetcher: ((input, init) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      providerWrites.push({ url, body: init.body ? JSON.parse(String(init.body)) : null, method: init.method });
      if (opts.providerFailure === "timeout") return Promise.reject(new TypeError("connection lost"));
      if (opts.providerFailure === "malformed") return Promise.resolve(new Response("broken", { status: 200 }));
      if (opts.providerFailure === "server") return Promise.resolve(Response.json({ error: { message: "private upstream" } }, { status: 500 }));
      if (opts.providerFailure === "missing_id") return Promise.resolve(Response.json({ success: true }));
      return Promise.resolve(Response.json({ id: "reply-created", success: true }));
    }
    if (url.includes("/commentThreads?")) return Promise.resolve(Response.json({ items: [{ id: "thread", snippet: { videoId: "post", topLevelComment: { id: "comment", snippet: { textDisplay: "hello" } } } }] }));
    if (url.includes("/feed?")) return Promise.resolve(Response.json({ data: [{ id: "post" }] }));
    if (url.includes("/comments?")) return Promise.resolve(Response.json({ data: [{ id: "comment", message: "hello" }] }));
    return Promise.resolve(Response.json({ id: "comment", message: "hello" }));
  }) as typeof fetch };
  const seed = async () => (await listComments({ admin, workspaceId: "ws", accountIds: [ID], requestId: "seed" }, new Request("https://partner.example/v1/comments"), {}, deps)).data[0].id;
  return { admin, deps, seed, reads, writes, claims, providerWrites };
}
function request(method: string, suffix: string, body?: unknown) {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/comments${suffix}`, {
    method, headers: { "x-postora-key": "pk_live_test", "idempotency-key": "idem-1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function drive(f: ReturnType<typeof fixture>, index: number, id: string, body?: unknown) {
  const [method, suffix, action, handler] = cases[index];
  return withPartnerAuth(action, method === "GET" ? "B" : "C", (req, authed, params) => handler(req, authed, params, f.deps))(
    request(method, suffix.replace("{id}", id), body), "req", { id }, () => f.admin,
  );
}
for (const [method, suffix, action] of cases) {
  Deno.test(`${action}: real router refuses entitlement before target reads and logs its own action`, async () => {
    const f = fixture({ entitled: false });
    const res = await handleRequest(request(method, suffix.replace("{id}", "invalid")), () => f.admin);
    assertEquals(res.status, 403); assertEquals((await res.json()).error.code, "feature_not_entitled");
    assert(!f.reads.some((url) => /\/(social_accounts|partner_api_key_accounts)$/.test(url.pathname)));
    assertEquals(f.writes.find((w) => w.table === "system_logs")?.row.metadata && (f.writes.find((w) => w.table === "system_logs")!.row.metadata as Record<string, unknown>).action, action);
    assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "feature_not_entitled");
  });
}
for (const [claim, code] of [["conflict", "idempotency_conflict"], ["in_progress", "idempotency_in_progress"], ["indeterminate", "idempotency_indeterminate"], ["replay", null]] as const) {
  Deno.test(`reply claim ${claim} does not repeat a provider write`, async () => {
    const f = fixture({ claim }); const id = await f.seed();
    const res = await drive(f, 2, id, { message: "reply" });
    const body = await res.json();
    if (code) { assertEquals(res.status, 409); assertEquals(body.error.code, code); }
    else { assertEquals(res.status, 200); assertEquals(body, { original: true }); assertEquals(res.headers.get("Idempotency-Replayed"), "true"); }
    assertEquals(f.providerWrites.length, 0);
  });
}
Deno.test("claimed reply settles with its attempt token; replay returns stored body and changed message conflicts", async () => {
  const f = fixture(); const id = await f.seed();
  const first = await drive(f, 2, id, { message: "reply" });
  assertEquals(first.status, 200); const body = await first.json();
  assertEquals(f.providerWrites.length, 1); assert(f.providerWrites[0].url.includes("/comment/comments"));
  const settlement = f.writes.find((w) => w.table === "partner_api_idempotency")!;
  assertEquals(settlement.row.http_status, 200); assertEquals(settlement.row.response_body, body);
  assertEquals(settlement.url.searchParams.get("attempt_token"), "eq.attempt-1");
  const replay = await drive(f, 2, id, { message: "reply" });
  assertEquals(await replay.json(), body); assertEquals(replay.headers.get("Idempotency-Replayed"), "true");
  const conflict = await drive(f, 2, id, { message: "different" });
  assertEquals((await conflict.json()).error.code, "idempotency_conflict"); assertEquals(f.providerWrites.length, 1);
});
for (const providerFailure of ["timeout", "malformed", "server", "missing_id"]) {
  Deno.test(`reply ${providerFailure} is fenced indeterminate`, async () => {
    const f = fixture({ providerFailure }); const id = await f.seed();
    const res = await drive(f, 2, id, { message: "reply" });
    assertEquals((await res.json()).error.code, "idempotency_indeterminate");
    const mark = f.writes.find((w) => w.table === "partner_api_idempotency")!;
    assertEquals(mark.row.state, "indeterminate"); assertEquals(mark.url.searchParams.get("attempt_token"), "eq.attempt-1");
  });
}
Deno.test("lost settlement after successful provider reply marks the same attempt indeterminate", async () => {
  const f = fixture({ settleFails: true }); const id = await f.seed();
  const res = await drive(f, 2, id, { message: "reply" });
  assertEquals((await res.json()).error.code, "idempotency_indeterminate");
  assertEquals(f.writes.filter((w) => w.table === "partner_api_idempotency").map((w) => w.row.state), ["completed", "indeterminate"]);
  assertEquals(f.providerWrites.length, 1);
});
for (const index of [1, 2, 3, 4]) {
  Deno.test(`${cases[index][2]} refuses a formerly bound comment before a provider call or replay`, async () => {
    const f = fixture({ unbound: true, claim: "replay" }); const id = await f.seed();
    f.reads.length = 0;
    const res = await drive(f, index, id, index === 2 ? { message: "reply" } : undefined);
    assertEquals(res.status, 404); assertEquals((await res.json()).error.code, "resource_not_found");
    assertEquals(f.claims.length, 0); assertEquals(f.providerWrites.length, 0);
    assert(!f.reads.some((url) => url.pathname.endsWith("/social_accounts")));
    assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "resource_not_found");
  });
}
Deno.test("YouTube delete is unsupported before an idempotency claim or provider write", async () => {
  const f = fixture({ platform: "youtube" }); const id = await f.seed();
  const res = await drive(f, 4, id);
  assertEquals(res.status, 422); assertEquals((await res.json()).error.code, "unsupported_capability");
  assertEquals(f.claims.length, 0); assertEquals(f.providerWrites.length, 0);
});
Deno.test("hide and delete use shared Graph writes and include action and hidden state in the hash", async () => {
  const f = fixture(); const id = await f.seed();
  assertEquals((await drive(f, 3, id, { hidden: false })).status, 200);
  assert(f.providerWrites[0].url.includes("is_hidden=false"));
  assertEquals((await (await drive(f, 3, id, { hidden: true })).json()).error.code, "idempotency_conflict");
  assertEquals((await (await drive(f, 4, id)).json()).error.code, "idempotency_conflict");
  const deletion = fixture(); const deletionId = await deletion.seed();
  assertEquals((await drive(deletion, 4, deletionId)).status, 200);
  assertEquals(deletion.providerWrites[0].method, "DELETE");
});
Deno.test("private-reply options and unknown write fields are rejected before claiming or sending", async () => {
  const f = fixture(); const id = await f.seed();
  const res = await drive(f, 2, id, { message: "reply", private: true });
  assertEquals((await res.json()).error.code, "invalid_request"); assertEquals(f.claims.length, 0); assertEquals(f.providerWrites.length, 0);
});
Deno.test("comment list read failures return logged internal_error, not an empty page", async () => {
  const f = fixture({ failTable: "social_accounts" });
  const res = await drive(f, 0, "");
  assertEquals(res.status, 500); assertEquals((await res.json()).error.code, "internal_error");
  assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "internal_error");
});
