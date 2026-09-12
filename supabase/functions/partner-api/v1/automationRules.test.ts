// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { ACCOUNT_ID, OTHER_ID, TOOL_ID, agentFixture } from "../../_shared/agentConfigTestSupport.ts";
import { decodeCursor } from "./pagination.ts";

const CONV = "44444444-4444-4444-8444-444444444444";
const KEY = "wa_1555000_96512345678";
const MODE_PATH = `conversations/conv_${CONV}/mode`;
const REPLIES = "automation/auto-replies";
const RULE = { name: "After hours", rule_type: "away", reply_message: "We will reply soon", schedule_days: [0, 6], schedule_start: "17:00", schedule_end: "09:00" };
function request(method: string, path: string, body?: unknown, query = "platform=whatsapp", key = "rules-1") {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/${path}?${query}`, {
    method, headers: { "x-postora-key": "pk_live_test", "idempotency-key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function fixture(opts: Parameters<typeof agentFixture>[0] = {}) {
  const f = agentFixture(opts);
  f.rows.messaging_cache.push({ id: CONV, user_id: "cache-owner", workspace_id: "ws", social_account_id: ACCOUNT_ID, platform: "whatsapp", conversation_id: KEY, last_message_at: "2026-09-10T00:00:00Z" });
  f.rows.ai_conversation_modes.push({ id: TOOL_ID, user_id: "cache-owner", platform: "whatsapp", conversation_id: KEY, mode: "ai_first", updated_at: "2026-09-10T00:00:00Z" });
  const table = opts.platform && opts.platform !== "whatsapp" ? "messenger_auto_replies" : "whatsapp_auto_replies";
  f.rows[table].push({ id: TOOL_ID, user_id: "owner", platform: opts.platform ?? "whatsapp", ...RULE, is_active: true, created_at: "2026-09-10T00:00:00Z" });
  return f;
}
const drive = (f: ReturnType<typeof fixture>, req: Request) => handleRequest(req, () => f.admin);
async function safeBody(response: Response) {
  const text = await response.text();
  assert(!/wa_|"conversation_id"|"user_id"/.test(text), text);
  return JSON.parse(text);
}
const routes = [
  ["GET", "automation/conversation-modes", "list_conversation_modes", undefined],
  ["GET", MODE_PATH, "get_conversation_mode", undefined],
  ["PUT", MODE_PATH, "set_conversation_mode", { mode: "human_first" }],
  ["GET", REPLIES, "list_auto_replies", undefined],
  ["POST", REPLIES, "create_auto_reply", RULE],
  ["PATCH", `${REPLIES}/${TOOL_ID}`, "update_auto_reply", { is_active: false }],
  ["DELETE", `${REPLIES}/${TOOL_ID}`, "delete_auto_reply", undefined],
] as const;
for (const [method, path, , input] of routes) {
  Deno.test(`${method} ${path}: missing platform has no default and unsupported table platforms never reach resource queries`, async () => {
    for (const [query, code] of [["", "feature_not_entitled"], ["platform=threads", "invalid_request"], ["platform=tiktok", "invalid_request"]]) {
      const f = fixture();
      assertEquals((await safeBody(await drive(f, request(method, path, input, query)))).error.code, code);
      assert(!f.reads.some((url) => /\/(partner_api_key_accounts|social_accounts|messaging_cache|ai_conversation_modes|.*auto_replies)$/.test(url.pathname)));
      assertEquals(f.claims.length, 0);
      assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, code);
    }
  });
}
for (const [method, path, action, input] of routes) {
  Deno.test(`${action}: response excludes private identifiers and entitlement refusal is logged first`, async () => {
    const good = fixture();
    const response = await drive(good, request(method, path, input));
    assertEquals(response.status, 200); await safeBody(response);
    const f = fixture({ entitled: false });
    const denied = await safeBody(await drive(f, request(method, path, input)));
    assertEquals(denied.error.code, "feature_not_entitled");
    assert(!f.reads.some((url) => /\/(partner_api_key_accounts|social_accounts|messaging_cache|ai_conversation_modes|.*auto_replies)$/.test(url.pathname)));
    assertEquals((f.writes.find((w) => w.table === "system_logs")!.row.metadata as Record<string, unknown>).action, action);
    assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "feature_not_entitled");
  });
}
for (const method of ["GET", "PUT"]) {
  for (const mismatch of ["unbound", "workspace"]) {
    Deno.test(`mode ${method}: ${mismatch} cache row is refused before any mode query`, async () => {
      const f = fixture();
      Object.assign(f.rows.messaging_cache[0], mismatch === "unbound" ? { social_account_id: OTHER_ID } : { workspace_id: "foreign" });
      assertEquals((await safeBody(await drive(f, request(method, MODE_PATH, method === "PUT" ? { mode: "ai_first" } : undefined)))).error.code, "resource_not_found");
      assert(!f.reads.some((url) => url.pathname.endsWith("/ai_conversation_modes")));
      assertEquals(f.claims.length, 0);
    });
  }
  Deno.test(`mode ${method}: threads fails validation, while a bound Facebook conversation uses the parent refusal`, async () => {
    const f = fixture({ platform: "threads" });
    const body = method === "PUT" ? { mode: "ai_first" } : undefined;
    assertEquals((await safeBody(await drive(f, request(method, MODE_PATH, body, "platform=threads")))).error.code, "invalid_request");
    assert(!f.reads.some((url) => url.pathname.endsWith("/ai_conversation_modes")));
    const fb = fixture({ platform: "facebook" }); fb.rows.messaging_cache[0].platform = "facebook";
    const refusal = await safeBody(await drive(fb, request(method, MODE_PATH, body, "platform=facebook")));
    assertEquals(refusal.error.code, "unsupported_capability");
    assertEquals(refusal.error.message, "Conversations are readable for whatsapp accounts only");
  });
}
for (const mode of [null, "default"]) {
  Deno.test(`mode ${mode}: clears the cache owner's row and returns null`, async () => {
    const f = fixture();
    const response = await safeBody(await drive(f, request("PUT", MODE_PATH, { mode })));
    assertEquals(response.mode, null); assertEquals(response.id, `conv_${CONV}`);
    assertEquals(f.rows.ai_conversation_modes.length, 0);
    const deleted = f.writes.find((w) => w.table === "ai_conversation_modes")!;
    assertEquals(deleted.method, "DELETE"); assertEquals(deleted.url.searchParams.get("user_id"), "eq.cache-owner");
    assertEquals(deleted.url.searchParams.get("conversation_id"), `eq.${KEY}`);
  });
}
Deno.test("mode rejects invalid input without writes, and persists using the cache owner", async () => {
  for (const body of [{ mode: "threads" }, {}, { mode: "ai_first", user_id: "attacker" }, { mode: "ai_first", conversation_id: KEY }]) {
    const f = fixture(); assertEquals((await safeBody(await drive(f, request("PUT", MODE_PATH, body)))).error.code, "invalid_request");
    assert(!f.writes.some((w) => w.table === "ai_conversation_modes"));
  }
  const f = fixture();
  assertEquals((await safeBody(await drive(f, request("PUT", MODE_PATH, { mode: "human_then_ai" })))).mode, "human_then_ai");
  assertEquals(f.writes.find((w) => w.table === "ai_conversation_modes")!.row, { user_id: "cache-owner", platform: "whatsapp", conversation_id: KEY, mode: "human_then_ai" });
});
Deno.test("mode list omits orphan and foreign-owner modes, paginates tied cache timestamps with gaps", async () => {
  const f = fixture();
  f.rows.ai_conversation_modes.push({ id: OTHER_ID, user_id: "cache-owner", platform: "whatsapp", conversation_id: "wa_orphan_1234", mode: "human_first" });
  f.rows.messaging_cache.push({ ...f.rows.messaging_cache[0], id: OTHER_ID, conversation_id: "wa_gap_1234" });
  f.rows.messaging_cache.push({ ...f.rows.messaging_cache[0], id: ACCOUNT_ID, conversation_id: "wa_final_1234" });
  f.rows.ai_conversation_modes.push({ ...f.rows.ai_conversation_modes[0], conversation_id: "wa_final_1234" });
  f.rows.ai_conversation_modes.push({ ...f.rows.ai_conversation_modes[0], user_id: "wrong-owner", conversation_id: "wa_gap_1234" });
  const page1 = await safeBody(await drive(f, request("GET", "automation/conversation-modes", undefined, "platform=whatsapp&limit=1")));
  assertEquals(page1.data.map((row: { id: string }) => row.id), [`conv_${CONV}`]);
  assertEquals(decodeCursor(page1.next_cursor)?.id, CONV);
  const page2 = await safeBody(await drive(f, request("GET", "automation/conversation-modes", undefined, `platform=whatsapp&limit=1&cursor=${page1.next_cursor}`)));
  assertEquals(page2.data.map((row: { id: string }) => row.id), [`conv_${ACCOUNT_ID}`]); assertEquals(page2.next_cursor, null);
});
Deno.test("mode list bounds sparse scans and continues to a resolvable override after the budget", async () => {
  const f = fixture(); f.rows.messaging_cache = []; f.rows.ai_conversation_modes = [];
  for (let i = 0; i < 501; i++) {
    const id = `${(1000 - i).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
    f.rows.messaging_cache.push({ id, user_id: "owner", workspace_id: "ws", social_account_id: ACCOUNT_ID, platform: "whatsapp", conversation_id: `wa_private_${i}`, last_message_at: "2026-09-10T00:00:00Z" });
  }
  f.rows.ai_conversation_modes.push({ user_id: "owner", platform: "whatsapp", conversation_id: "wa_private_500", mode: "ai_first" });
  const first = await safeBody(await drive(f, request("GET", "automation/conversation-modes")));
  assertEquals(first.data, []); assert(first.next_cursor);
  assertEquals(f.reads.filter((url) => url.pathname.endsWith("/messaging_cache")).length, 5);
  const second = await safeBody(await drive(f, request("GET", "automation/conversation-modes", undefined, `platform=whatsapp&cursor=${first.next_cursor}`)));
  assertEquals(second.data.length, 1); assertEquals(second.next_cursor, null);
});
for (const platform of ["whatsapp", "facebook", "instagram"]) {
  Deno.test(`${platform} rules write under the webhook account owner, with owner-scoped updates`, async () => {
    const f = fixture({ platform }); f.rows.social_accounts[0].user_id = "webhook-owner";
    const table = platform === "whatsapp" ? "whatsapp_auto_replies" : "messenger_auto_replies";
    const response = await safeBody(await drive(f, request("POST", REPLIES, RULE, `platform=${platform}`)));
    assertEquals(response.rule.platform, platform);
    const write = f.writes.find((w) => w.table === table)!;
    assertEquals(write.row.user_id, "webhook-owner");
    assertEquals(write.row.platform, platform === "whatsapp" ? undefined : platform);
    const updated = await drive(f, request("PATCH", `${REPLIES}/${response.rule.id}`, { is_active: false }, `platform=${platform}`, "patch-1"));
    assertEquals((await safeBody(updated)).rule.is_active, false);
    const patch = f.writes.find((w) => w.table === table && w.method === "PATCH")!;
    assertEquals(patch.url.searchParams.get("user_id"), "eq.webhook-owner");
    if (platform !== "whatsapp") assertEquals(patch.url.searchParams.get("platform"), `eq.${platform}`);
  });
}
for (const method of ["PATCH", "DELETE"]) {
  Deno.test(`rule ${method}: foreign owner is not found and never mutated`, async () => {
    const f = fixture(); f.rows.whatsapp_auto_replies[0].user_id = "foreign";
    const result = await safeBody(await drive(f, request(method, `${REPLIES}/${TOOL_ID}`, method === "PATCH" ? { name: "stolen" } : undefined)));
    assertEquals(result.error.code, "resource_not_found");
    assert(!f.writes.some((w) => w.table === "whatsapp_auto_replies"));
  });
}
Deno.test("rule creation requires an account selector for multiple bindings and rejects invalid fields", async () => {
  const f = fixture(); f.rows.partner_api_key_accounts.push({ key_id: "key", workspace_id: "ws", social_account_id: OTHER_ID });
  assertEquals((await safeBody(await drive(f, request("POST", REPLIES, RULE)))).error.code, "invalid_request");
  assertEquals(f.claims.length, 0);
  assertEquals((await drive(f, request("POST", REPLIES, RULE, `platform=whatsapp&account_id=acc_${ACCOUNT_ID}`))).status, 200);
  for (const invalid of [{ ...RULE, user_id: "fake" }, { ...RULE, rule_type: "invalid" }, { ...RULE, schedule_start: "25:00" }, { ...RULE, schedule_days: [7] }]) {
    const bad = fixture(); assertEquals((await safeBody(await drive(bad, request("POST", REPLIES, invalid)))).error.code, "invalid_request");
    assert(!bad.writes.some((w) => w.table === "whatsapp_auto_replies"));
  }
});
for (const outcome of ["replay", "conflict", "in_progress", "indeterminate"]) {
  Deno.test(`auto-reply POST ${outcome} claim makes no rule write`, async () => {
    const f = fixture({ claim: outcome }); const response = await drive(f, request("POST", REPLIES, RULE));
    const body = await safeBody(response);
    if (outcome === "replay") { assertEquals(body, { stored: true }); assertEquals(response.headers.get("Idempotency-Replayed"), "true"); }
    else assertEquals(body.error.code, `idempotency_${outcome}`);
    assert(!f.writes.some((w) => w.table === "whatsapp_auto_replies"));
  });
}
for (const [method, path, , input] of routes.filter(([method]) => method !== "GET")) {
  Deno.test(`${method} ${path}: claimed write settles with attempt token, then replays the stored body once`, async () => {
    const f = fixture(); const first = await drive(f, request(method, path, input)); assertEquals(first.status, 200);
    const body = await safeBody(first);
    const settle = f.writes.find((w) => w.table === "partner_api_idempotency")!;
    assertEquals(settle.row.response_body, body); assertEquals(settle.row.http_status, 200);
    assertEquals(settle.url.searchParams.get("attempt_token"), "eq.attempt-1");
    const replay = await drive(f, request(method, path, input));
    assertEquals(await safeBody(replay), body); assertEquals(replay.headers.get("Idempotency-Replayed"), "true");
    assertEquals(f.writes.filter((w) => ["ai_conversation_modes", "whatsapp_auto_replies"].includes(w.table)).length, 1);
  });
}
for (const [path, table] of [[MODE_PATH, "messaging_cache"], [MODE_PATH, "ai_conversation_modes"], ["automation/conversation-modes", "ai_conversation_modes"], [REPLIES, "whatsapp_auto_replies"]]) {
  Deno.test(`${path}: ${table} read failure never becomes empty success`, async () => {
    const f = fixture({ failTable: table });
    assertEquals((await safeBody(await drive(f, request("GET", path)))).error.code, "internal_error");
    assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "internal_error");
  });
}
for (const opts of [{ writeFails: true }, { settleFails: true }]) {
  Deno.test(`auto-reply uncertain write fences its attempt ${JSON.stringify(opts)}`, async () => {
    const f = fixture(opts); const body = await safeBody(await drive(f, request("POST", REPLIES, RULE)));
    assertEquals(body.error.code, "idempotency_indeterminate");
    assertEquals(f.writes.find((w) => w.table === "partner_api_idempotency" && w.row.state === "indeterminate")!.url.searchParams.get("attempt_token"), "eq.attempt-1");
  });
}
Deno.test("mode GET without an override returns a public conversation id and null mode", async () => {
  const f = fixture(); f.rows.ai_conversation_modes = [];
  const result = await safeBody(await drive(f, request("GET", MODE_PATH)));
  assertEquals(result.id, `conv_${CONV}`); assertEquals(result.mode, null);
});
Deno.test("new write hashes cover body fields and resolved owner changes", async () => {
  for (const [method, path, , body] of routes.filter(([method]) => method === "PUT" || method === "POST" || method === "PATCH")) {
    const f = fixture(); assertEquals((await drive(f, request(method, path, body))).status, 200);
    const changed = method === "PUT" ? { mode: "ai_first" } : method === "POST" ? { ...RULE, keywords: ["changed"] } : { is_active: true };
    assertEquals((await safeBody(await drive(f, request(method, path, changed)))).error.code, "idempotency_conflict");
    if (method === "PUT") f.rows.messaging_cache[0].user_id = "replacement-owner";
    else f.rows.social_accounts[0].user_id = "replacement-owner";
    assertEquals((await safeBody(await drive(f, request(method, path, body)))).error.code, "idempotency_conflict");
  }
});
Deno.test("auto-reply list paginates tied timestamps and excludes another owner, platform and null sort keys", async () => {
  const f = fixture({ platform: "facebook" });
  const row = f.rows.messenger_auto_replies[0];
  f.rows.messenger_auto_replies.push({ ...row, id: OTHER_ID }, { ...row, id: ACCOUNT_ID, user_id: "foreign" }, { ...row, id: CONV, platform: "instagram" }, { ...row, id: crypto.randomUUID(), created_at: null });
  const first = await safeBody(await drive(f, request("GET", REPLIES, undefined, "platform=facebook&limit=1")));
  assertEquals(first.data.map((rule: { id: string }) => rule.id), [TOOL_ID]);
  const next = await safeBody(await drive(f, request("GET", REPLIES, undefined, `platform=facebook&limit=1&cursor=${first.next_cursor}`)));
  assertEquals(next.data.map((rule: { id: string }) => rule.id), [OTHER_ID]); assertEquals(next.next_cursor, null);
});
