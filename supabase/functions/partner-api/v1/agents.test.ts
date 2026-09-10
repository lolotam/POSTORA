// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { AGENT_ID, AGENT_ROW, ATTEMPT_ID, humanAgentFixture, IDENTITY_ID } from "../../_shared/humanAgentTestSupport.ts";
const id = `agent_${AGENT_ID}`;
function request(method = "POST", suffix = "", body?: unknown, key = "idem-1") {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/agents${suffix}`, { method,
    headers: { "x-postora-key": "pk_live_test", "idempotency-key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const drive = (f: ReturnType<typeof humanAgentFixture>, req: Request) => handleRequest(req, () => f.admin);
const routes = [["GET", ""], ["GET", `/${id}`], ["POST", ""], ["PATCH", `/${id}`], ["DELETE", `/${id}`]] as const;
for (const [method, suffix] of routes) Deno.test(`${method} agents${suffix}: entitlement refuses first and logs`, async () => {
  const f = humanAgentFixture({ entitled: false }); const response = await drive(f, request(method, suffix));
  assertEquals((await response.json()).error.code, "feature_not_entitled");
  assert(!f.reads.some((url) => url.pathname.endsWith("whatsapp_agents"))); assertEquals(f.claims.length, 0);
  assert(f.rows.system_logs.some((row) => (row.metadata as Record<string, unknown>).event === "partner_entitlement_refused"));
  assertEquals(f.rows.partner_api_usage[0].error_code, "feature_not_entitled");
});
for (const method of ["GET", "PATCH", "DELETE"]) Deno.test(`${method} foreign agent refuses before agent mutation`, async () => {
  const f = humanAgentFixture(); f.rows.whatsapp_agents[0].workspace_id = "foreign";
  const response = await drive(f, request(method, `/${id}`, method === "PATCH" ? { display_name: "Changed" } : undefined));
  assertEquals((await response.json()).error.code, "resource_not_found");
  assert(!f.writes.some((write) => write.table === "whatsapp_agents")); assertEquals(f.creates.length, 0);
  assert(f.reads.filter((url) => url.pathname.endsWith("whatsapp_agents")).every((url) => url.searchParams.get("workspace_id") === "eq.ws" && !url.searchParams.has("user_id")));
});
Deno.test("create replays stored body without a second Auth identity and hashes changed fields", async () => {
  const f = humanAgentFixture(); f.rows.whatsapp_agents = [];
  const body = { display_name: "New Agent", max_conversations: 8 };
  const first = await drive(f, request("POST", "", body)); assertEquals(first.status, 201); const saved = await first.json();
  assert(!JSON.stringify(saved).includes("user_id")); assert(!JSON.stringify(saved).includes(IDENTITY_ID)); assertEquals(saved.agent.id, id);
  const replay = await drive(f, request("POST", "", body)); assertEquals(await replay.json(), saved);
  assertEquals(replay.headers.get("Idempotency-Replayed"), "true"); assertEquals(f.creates.length, 1);
  assert(/^svc\+[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}@partner\.postora\.cloud$/.test(String(f.creates[0].email)));
  assertEquals(f.creates[0].email_confirm, false); assert(!("password" in f.creates[0]));
  const changed = await drive(f, request("POST", "", { ...body, max_conversations: 9 }));
  assertEquals((await changed.json()).error.code, "idempotency_conflict"); assertEquals(f.creates.length, 1);
});
for (const outcome of ["replay", "conflict", "in_progress", "indeterminate"]) Deno.test(`create claim ${outcome} never mints identity`, async () => {
  const f = humanAgentFixture({ claim: outcome }); const response = await drive(f, request("POST", "", { display_name: "New" }));
  const body = await response.json(); if (outcome === "replay") assertEquals(body, { stored: true });
  else assertEquals(body.error.code, `idempotency_${outcome}`);
  assertEquals(f.creates.length, 0); assert(!f.writes.some((write) => write.table === "provision_partner_agent"));
});
Deno.test("failed provisioning RPC compensates the successfully minted identity", async () => {
  const f = humanAgentFixture({ rpcFails: true }); f.rows.whatsapp_agents = [];
  const response = await drive(f, request("POST", "", { display_name: "New" }));
  assertEquals((await response.json()).error.code, "internal_error"); assertEquals(f.creates.length, 1);
  assertEquals(f.deletes, [IDENTITY_ID]); assertEquals(f.identities.size, 0);
  await drive(f, request("POST", "", { display_name: "New" })); assertEquals(f.creates.length, 1);
});
for (const options of [{ responseLost: true }, { rpcFails: true, failRead: "whatsapp_agents" }, { rpcFails: true, incompleteRecovery: true }, { rpcFails: true, cleanupFails: true }]) {
  Deno.test(`uncertain recovery preserves identity and logs reconciliation: ${JSON.stringify(options)}`, async () => {
    const f = humanAgentFixture(options); f.rows.whatsapp_agents = [];
    const response = await drive(f, request("POST", "", { display_name: "New" }));
    assertEquals((await response.json()).error.code, "idempotency_indeterminate"); assert(f.identities.has(IDENTITY_ID));
    assertEquals(f.deletes.length, "cleanupFails" in options ? 1 : 0);
    assert(f.rows.system_logs.some((row) => (row.metadata as Record<string, unknown>).event === "partner_agent_recovery"));
    assert(f.writes.some((write) => write.row.state === "indeterminate" && write.url.searchParams.get("attempt_token") === `eq.${ATTEMPT_ID}`));
  });
}
Deno.test("Auth failure makes no SQL call and records the discoverable attempt", async () => {
  const f = humanAgentFixture({ createFails: true }); const response = await drive(f, request("POST", "", { display_name: "New" }));
  assertEquals((await response.json()).error.code, "idempotency_indeterminate");
  assert(!f.writes.some((write) => write.table === "provision_partner_agent")); assertEquals(f.deletes.length, 0);
});
Deno.test("a lease takeover keeps the Auth email stable and cannot mint another identity", async () => {
  const f = humanAgentFixture({ claim: "claimed", settleFails: true }); f.rows.whatsapp_agents = [];
  await drive(f, request("POST", "", { display_name: "New" }));
  const response = await drive(f, request("POST", "", { display_name: "New" }));
  assertEquals((await response.json()).error.code, "idempotency_indeterminate");
  assertEquals(f.creates.length, 2); assertEquals(f.creates[0].email, f.creates[1].email);
  assertEquals(f.writes.filter((write) => write.table === "provision_partner_agent").length, 1);
  assertEquals(f.identities.size, 1); assertEquals(f.rows.whatsapp_agents.length, 1);
});
Deno.test("single-field PATCH writes only that field and returns a private-field-free body", async () => {
  const f = humanAgentFixture(); const response = await drive(f, request("PATCH", `/${id}`, { display_name: "Renamed" }));
  assertEquals(response.status, 200); assert(!JSON.stringify(await response.json()).includes("user_id"));
  assertEquals(f.writes.find((write) => write.table === "whatsapp_agents")!.row, { display_name: "Renamed" });
  assertEquals(f.rows.whatsapp_agents[0], { ...AGENT_ROW, display_name: "Renamed" });
});
for (const body of [{ status: "busy" }, { current_conversations: 0 }, {}, { user_id: IDENTITY_ID }]) Deno.test(`PATCH refuses invalid fields without writing: ${JSON.stringify(body)}`, async () => {
  const f = humanAgentFixture(); const response = await drive(f, request("PATCH", `/${id}`, body));
  assertEquals((await response.json()).error.code, "invalid_request"); assertEquals(f.claims.length, 0);
  assert(!f.writes.some((write) => write.table === "whatsapp_agents"));
});
Deno.test("list and get whitelist fields, and a failed read never becomes empty success", async () => {
  for (const suffix of ["", `/${id}`]) {
    const f = humanAgentFixture(); const response = await drive(f, request("GET", suffix));
    assertEquals(response.status, 200); const body = await response.text(); assert(!body.includes("user_id")); assert(!body.includes(IDENTITY_ID));
    const failed = humanAgentFixture({ failRead: "whatsapp_agents" });
    assertEquals((await (await drive(failed, request("GET", suffix))).json()).error.code, "internal_error");
  }
});
// The null case is the one the workspace predicate used to miss: rows written
// before the tenancy backfill still carry no workspace, and they are live
// conversations, so a delete that cannot see them orphans a real customer.
for (const workspace of ["ws", null]) Deno.test(`delete refuses a live assignment carrying workspace ${String(workspace)}`, async () => {
  const f = humanAgentFixture();
  f.rows.whatsapp_conversation_assignments.push({ id: "assignment", workspace_id: workspace, agent_id: AGENT_ID, unassigned_at: null });
  const response = await drive(f, request("DELETE", `/${id}`)); assertEquals(response.status, 409);
  assertEquals((await response.json()).error.code, "invalid_request"); assertEquals(f.rows.whatsapp_agents.length, 1);
  assert(!f.writes.some((write) => write.table === "whatsapp_agents"));
});
Deno.test("delete proceeds when every assignment is already closed", async () => {
  const f = humanAgentFixture();
  f.rows.whatsapp_conversation_assignments.push({ id: "closed", workspace_id: "ws", agent_id: AGENT_ID, unassigned_at: "2026-09-01T00:00:00Z" });
  assertEquals((await drive(f, request("DELETE", `/${id}`))).status, 200);
  assertEquals(f.rows.whatsapp_agents.length, 0);
});
Deno.test("delete replays after removal and never deletes Auth identity", async () => {
  const f = humanAgentFixture(); const first = await drive(f, request("DELETE", `/${id}`)); assertEquals(first.status, 200);
  const saved = await first.json(); assertEquals(f.rows.whatsapp_agents.length, 0);
  assertEquals(await (await drive(f, request("DELETE", `/${id}`))).json(), saved); assertEquals(f.deletes.length, 0);
});
Deno.test("settlement failure preserves created agent and fences the attempt", async () => {
  const f = humanAgentFixture({ settleFails: true }); f.rows.whatsapp_agents = [];
  const response = await drive(f, request("POST", "", { display_name: "New" }));
  assertEquals((await response.json()).error.code, "idempotency_indeterminate"); assertEquals(f.rows.whatsapp_agents.length, 1); assertEquals(f.deletes.length, 0);
  assert(f.writes.some((write) => write.row.state === "indeterminate"));
});

for (const [method, failRead] of [["PATCH", "whatsapp_agents"], ["DELETE", "whatsapp_conversation_assignments"]]) Deno.test(`${method} failed prerequisite read refuses before mutation`, async () => {
  const f = humanAgentFixture({ failRead });
  const response = await drive(f, request(method, `/${id}`, method === "PATCH" ? { status: "away" } : undefined));
  assertEquals((await response.json()).error.code, "internal_error");
  assert(!f.writes.some((write) => write.table === "whatsapp_agents"));
});
Deno.test("list pages are workspace-scoped and resume across equal timestamps", async () => {
  const f = humanAgentFixture();
  const second = "44444444-4444-4444-8444-444444444444";
  f.rows.whatsapp_agents.push({ ...AGENT_ROW, id: second });
  f.rows.whatsapp_agents.push({ ...AGENT_ROW, id: "55555555-5555-4555-8555-555555555555", workspace_id: "foreign" });
  const first = await (await drive(f, request("GET", "?limit=1"))).json();
  assertEquals(first.data.map((row: { id: string }) => row.id), [`agent_${second}`]); assert(first.next_cursor);
  const next = await (await drive(f, request("GET", `?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`))).json();
  assertEquals(next.data.map((row: { id: string }) => row.id), [id]); assertEquals(next.next_cursor, null);
});
for (const [method, suffix] of routes.filter(([method]) => ["POST", "PATCH", "DELETE"].includes(method))) Deno.test(`${method} requires idempotency before any resource mutation`, async () => {
  const f = humanAgentFixture();
  const response = await drive(f, request(method, suffix, method === "DELETE" ? undefined : { display_name: "New" }, ""));
  assertEquals((await response.json()).error.code, "missing_idempotency_key"); assertEquals(f.claims.length, 0);
  assertEquals(f.creates.length, 0); assert(!f.writes.some((write) => write.table === "whatsapp_agents"));
});
