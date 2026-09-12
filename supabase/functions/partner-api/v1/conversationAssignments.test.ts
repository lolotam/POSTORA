// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { AGENT_ID, ATTEMPT_ID, humanAgentFixture } from "../../_shared/humanAgentTestSupport.ts";
const CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIVATE_KEY = "wa_123_96555555555";
const OLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function fixture(opts: Parameters<typeof humanAgentFixture>[0] = {}) {
  const f = humanAgentFixture(opts);
  f.rows.partner_api_key_accounts.push({ key_id: "key", workspace_id: "ws", social_account_id: "account" });
  f.rows.messaging_cache.push({ id: CONV, workspace_id: "ws", social_account_id: "account", platform: "whatsapp", conversation_id: PRIVATE_KEY, user_id: "private-owner", last_message_at: "2026-09-10T00:00:00Z" });
  f.rows.whatsapp_conversation_assignments.push({ id: OLD, workspace_id: "ws", conversation_cache_id: CONV, conversation_id: PRIVATE_KEY, user_id: "private-owner", agent_id: AGENT_ID, assigned_at: "2026-09-10T00:00:00Z", unassigned_at: null, notes: "Old" });
  return f;
}
function request(method = "GET", suffix = "assignment", body?: unknown, key = "assignment-1") {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/conversations/conv_${CONV}/${suffix}`, { method,
    headers: { "x-postora-key": "pk_live_test", "idempotency-key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const drive = (f: ReturnType<typeof fixture>, req: Request) => handleRequest(req, () => f.admin);
const input = { agent_id: `agent_${AGENT_ID}`, notes: "Follow up" };
const routes = [["GET", "assignment", "get_assignment"], ["PUT", "assignment", "assign_conversation"], ["DELETE", "assignment", "unassign_conversation"], ["GET", "assignment-history", "list_assignment_history"]] as const;
function privateFree(body: unknown) {
  const text = JSON.stringify(body);
  for (const forbidden of ["wa_", '"conversation_id"', '"user_id"', "private-owner"]) assert(!text.includes(forbidden), text);
}
for (const [method, suffix, action] of routes) {
  Deno.test(`${action}: entitlement refuses first under its own action and logs`, async () => {
    const f = fixture({ entitled: false }); const response = await drive(f, request(method, suffix));
    const body = await response.json(); assertEquals(body.error.code, "feature_not_entitled"); privateFree(body);
    assert(!f.reads.some((u) => /messaging_cache|assignments|assignment_history/.test(u.pathname))); assertEquals(f.claims.length, 0);
    assert(f.rows.system_logs.some((r) => (r.metadata as Record<string, unknown>).action === action));
    assertEquals(f.rows.partner_api_usage[0].error_code, "feature_not_entitled");
  });
  Deno.test(`${action}: unbound conversation refuses before any assignment access`, async () => {
    const f = fixture(); f.rows.messaging_cache[0].social_account_id = "unbound";
    const response = await drive(f, request(method, suffix, method === "PUT" ? input : undefined));
    assertEquals((await response.json()).error.code, "resource_not_found");
    assert(!f.reads.some((u) => /whatsapp_.*assignment/.test(u.pathname)));
    assert(!f.writes.some((w) => /assignment/.test(w.table))); assertEquals(f.claims.length, 0);
    assertEquals(f.rows.partner_api_usage[0].error_code, "resource_not_found");
  });
  Deno.test(`${action}: bound non-WhatsApp conversation has its parent's refusal`, async () => {
    const f = fixture(); f.rows.messaging_cache[0].platform = "facebook";
    assertEquals((await (await drive(f, request(method, suffix, method === "PUT" ? input : undefined))).json()).error.code, "unsupported_capability");
    assert(!f.writes.some((w) => /assignment/.test(w.table)));
  });
}
Deno.test("assignment PUT closes the existing row, sets both tenancy columns, records history and replays without a second write", async () => {
  const f = fixture(); const response = await drive(f, request("PUT", "assignment", input));
  assertEquals(response.status, 200); const saved = await response.json(); privateFree(saved);
  const rows = f.rows.whatsapp_conversation_assignments;
  assertEquals(rows.length, 2); assert(rows[0].unassigned_at); assertEquals(rows.filter((r) => r.unassigned_at === null).length, 1);
  assertEquals(rows[1].workspace_id, "ws"); assertEquals(rows[1].conversation_cache_id, CONV); assertEquals(rows[1].notes, input.notes);
  const rpc = f.writes.find((w) => w.table === "partner_write_conversation_assignment")!;
  assertEquals(rpc.row, { p_workspace_id: "ws", p_key_id: "key", p_conversation_cache_id: CONV, p_agent_id: AGENT_ID, p_notes: input.notes, p_unassign: false });
  assertEquals(f.rows.whatsapp_assignment_history[0].workspace_id, "ws"); assertEquals(f.rows.whatsapp_assignment_history[0].action, "transferred");
  const replay = await drive(f, request("PUT", "assignment", input)); assertEquals(await replay.json(), saved); assertEquals(replay.headers.get("Idempotency-Replayed"), "true");
  assertEquals(f.writes.filter((w) => w.table === "partner_write_conversation_assignment").length, 1);
  const read = await (await drive(f, request())).json(); privateFree(read); assertEquals(read.assignment.id, saved.assignment.id);
});
for (const outcome of ["claimed", "replay", "conflict", "in_progress", "indeterminate"]) Deno.test(`assignment PUT claim ${outcome}`, async () => {
  const f = fixture({ claim: outcome }); const response = await drive(f, request("PUT", "assignment", input)); const body = await response.json(); privateFree(body);
  if (outcome === "claimed") assertEquals(response.status, 200);
  else if (outcome === "replay") assertEquals(body, { stored: true });
  else assertEquals(body.error.code, `idempotency_${outcome}`);
  assertEquals(f.writes.filter((w) => w.table === "partner_write_conversation_assignment").length, outcome === "claimed" ? 1 : 0);
});
for (const change of ["notes", "agent_id", "owner", "account", "text_key", "method"]) Deno.test(`assignment idempotency hashes ${change}`, async () => {
  const f = fixture(); await drive(f, request("PUT", "assignment", input));
  const changed = { ...input };
  if (change === "notes") changed.notes = "Different";
  if (change === "agent_id") changed.agent_id = `agent_${CONV}`;
  if (change === "owner") f.rows.messaging_cache[0].user_id = "other-owner";
  if (change === "text_key") f.rows.messaging_cache[0].conversation_id = "another-private-key";
  if (change === "account") { f.rows.messaging_cache[0].social_account_id = "other-bound"; f.rows.partner_api_key_accounts[0].social_account_id = "other-bound"; }
  const response = await drive(f, request(change === "method" ? "DELETE" : "PUT", "assignment", change === "method" ? undefined : changed));
  assertEquals((await response.json()).error.code, "idempotency_conflict"); assertEquals(f.rows.whatsapp_conversation_assignments.length, 2);
});
Deno.test("assignment DELETE preserves the closed row, and a fresh DELETE without an active assignment writes no assignment or history", async () => {
  const f = fixture(); const response = await drive(f, request("DELETE")); assertEquals(response.status, 200); const body = await response.json(); privateFree(body);
  assertEquals(f.rows.whatsapp_conversation_assignments.length, 1); assertEquals(f.rows.whatsapp_conversation_assignments[0].id, OLD); assert(f.rows.whatsapp_conversation_assignments[0].unassigned_at);
  assertEquals(f.rows.whatsapp_assignment_history.length, 1);
  assertEquals(await (await drive(f, request("DELETE"))).json(), body);
  const before = JSON.stringify([f.rows.whatsapp_conversation_assignments, f.rows.whatsapp_assignment_history]);
  const missing = await drive(f, request("DELETE", "assignment", undefined, "fresh-key")); assertEquals((await missing.json()).error.code, "resource_not_found");
  assertEquals(JSON.stringify([f.rows.whatsapp_conversation_assignments, f.rows.whatsapp_assignment_history]), before);
  assert(!f.writes.some((w) => w.method === "DELETE"));
});
Deno.test("assignment history scopes workspace and key, excludes null dates and resumes equal timestamps", async () => {
  const f = fixture(); const base = { workspace_id: "ws", conversation_id: PRIVATE_KEY, user_id: "private-owner", action: "assigned", from_agent_id: null, to_agent_id: AGENT_ID, reason: "Note", created_at: "2026-09-10T00:00:00Z" };
  f.rows.whatsapp_assignment_history.push({ ...base, id: CONV }, { ...base, id: OLD }, { ...base, id: AGENT_ID, created_at: null }, { ...base, id: OLD, workspace_id: "foreign" }, { ...base, id: OLD, conversation_id: "other" });
  const first = await (await drive(f, request("GET", "assignment-history?limit=1"))).json(); privateFree(first);
  assertEquals(first.data.map((r: { id: string }) => r.id), [`assignment_history_${OLD}`]); assert(first.next_cursor);
  const second = await (await drive(f, request("GET", `assignment-history?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`))).json(); privateFree(second);
  assertEquals(second.data.map((r: { id: string }) => r.id), [`assignment_history_${CONV}`]); assertEquals(second.next_cursor, null);
  const url = f.reads.filter((u) => u.pathname.endsWith("whatsapp_assignment_history")).at(-1)!;
  assertEquals(url.searchParams.getAll("or").length, 1); assertEquals(url.searchParams.get("limit"), "2"); assertEquals(url.searchParams.get("created_at"), "not.is.null"); assertEquals(url.searchParams.get("order"), "created_at.desc,id.desc");
});
for (const [table, suffix] of [["messaging_cache", "assignment"], ["partner_api_key_accounts", "assignment"], ["whatsapp_conversation_assignments", "assignment"], ["whatsapp_assignment_history", "assignment-history"]]) Deno.test(`assignment failed ${table} read never becomes empty success`, async () => {
  const f = fixture({ failRead: table }); const body = await (await drive(f, request("GET", suffix))).json(); privateFree(body); assertEquals(body.error.code, "internal_error");
});
for (const options of [{ assignmentRpcFails: true }, { settleFails: true }]) Deno.test(`assignment unknown write or settlement is fenced: ${JSON.stringify(options)}`, async () => {
  const f = fixture(options); const response = await drive(f, request("PUT", "assignment", input)); assertEquals((await response.json()).error.code, "idempotency_indeterminate");
  assert(f.writes.some((w) => w.row.state === "indeterminate" && w.url.searchParams.get("attempt_token") === `eq.${ATTEMPT_ID}`));
});
for (const method of ["PUT", "DELETE"]) Deno.test(`assignment ${method} requires idempotency`, async () => {
  const f = fixture(); const response = await drive(f, request(method, "assignment", method === "PUT" ? input : undefined, "")); assertEquals((await response.json()).error.code, "missing_idempotency_key"); assertEquals(f.claims.length, 0);
});
Deno.test("assignment PUT refuses a foreign agent without closing the active row", async () => {
  const f = fixture(); f.rows.whatsapp_agents[0].workspace_id = "foreign";
  const body = await (await drive(f, request("PUT", "assignment", input))).json(); assertEquals(body.error.code, "resource_not_found"); privateFree(body);
  assertEquals(f.rows.whatsapp_conversation_assignments[0].unassigned_at, null); assertEquals(f.rows.whatsapp_assignment_history.length, 0);
});
Deno.test("assignment replay loses access when its conversation account is unbound", async () => {
  const f = fixture(); await drive(f, request("PUT", "assignment", input));
  f.rows.partner_api_key_accounts = [];
  const response = await drive(f, request("PUT", "assignment", input));
  assertEquals((await response.json()).error.code, "resource_not_found");
  assertEquals(f.claims.length, 1); assertEquals(f.rows.whatsapp_conversation_assignments.length, 2);
});
for (const [method, body] of [["PUT", { ...input, user_id: "spoofed" }], ["PUT", { ...input, conversation_id: PRIVATE_KEY }], ["DELETE", input], ["PUT", { notes: "No agent" }]] as const) Deno.test(`assignment ${method} rejects invalid fields: ${JSON.stringify(body)}`, async () => {
  const f = fixture(); const response = await drive(f, request(method, "assignment", body));
  assertEquals((await response.json()).error.code, "invalid_request"); assertEquals(f.claims.length, 0);
  assertEquals(f.rows.whatsapp_conversation_assignments[0].unassigned_at, null);
});
