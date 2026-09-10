import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AgentConfigOpError, getAutomationHandlers, setAutomationHandlers, getAudience } from "./agentConfigOps.ts";
import { ACCOUNT_ID, OTHER_ID, TOOL_ID, agentFixture } from "./agentConfigTestSupport.ts";
import { decodeCursor } from "../partner-api/v1/pagination.ts";

const page = { limit: 20, cursor: null };
const initial = { automation_handler: "n8n", comment_automation_handler: "internal", media_understanding: "audio", ig_igid: "keep", flow: { step: 4 }, token_type: "keep" };
for (const [field, value] of Object.entries({ automation_handler: "off", comment_automation_handler: "n8n", media_understanding: "audio+image" })) {
  Deno.test(`handler partial PUT sends only ${field}, preserving all other metadata`, async () => {
    const f = agentFixture();
    f.rows.social_accounts[0].account_metadata = { ...initial };
    const result = await setAutomationHandlers(f.ctx, ACCOUNT_ID, { [field]: value });
    assertEquals(f.writes[0].row, { p_account_id: ACCOUNT_ID, p_workspace_id: "ws", p_patch: { [field]: value } });
    assertEquals(f.rows.social_accounts[0].account_metadata, { ...initial, [field]: value });
    assertEquals(result, { account_id: ACCOUNT_ID, platform: "whatsapp", automation_handler: "n8n", comment_automation_handler: "internal", media_understanding: "audio", [field]: value });
  });
}
Deno.test("handler GET and PUT resolve all fields and never expose unrelated metadata", async () => {
  const f = agentFixture();
  assertEquals(await getAutomationHandlers(f.ctx), { account_id: ACCOUNT_ID, platform: "whatsapp", automation_handler: "internal", comment_automation_handler: "off", media_understanding: "off" });
  assertEquals(await setAutomationHandlers(f.ctx, null, { automation_handler: "n8n" }), { account_id: ACCOUNT_ID, platform: "whatsapp", automation_handler: "n8n", comment_automation_handler: "off", media_understanding: "off" });
});
for (const body of [{}, { automation_handler: null }, { comment_automation_handler: "bad" }, { media_understanding: true }, { token_type: "bad" }, { toString: "internal" }]) {
  Deno.test(`invalid handler patch never reaches RPC: ${JSON.stringify(body)}`, async () => {
    const f = agentFixture();
    const error = await assertRejects(() => setAutomationHandlers(f.ctx, ACCOUNT_ID, body), AgentConfigOpError);
    assertEquals(error.code, "invalid_request"); assertEquals(f.writes, []);
  });
}
Deno.test("unbound handler and audience selectors are refused before any query", async () => {
  const f = agentFixture({ platform: "facebook" });
  for (const call of [() => getAutomationHandlers(f.ctx, OTHER_ID), () => setAutomationHandlers(f.ctx, OTHER_ID, { automation_handler: "off" }), () => getAudience(f.ctx, OTHER_ID, page)]) {
    const error = await assertRejects(call, AgentConfigOpError);
    assertEquals(error.code, "resource_not_found");
  }
  assertEquals(f.reads, []); assertEquals(f.writes, []);
});
Deno.test("handlers require an explicit selector for multiple bindings and match the entitled platform", async () => {
  const f = agentFixture();
  const error = await assertRejects(() => getAutomationHandlers({ ...f.ctx, platform: "instagram" }), AgentConfigOpError);
  assertEquals(error.code, "resource_not_found");
  f.reads.length = 0;
  const ambiguous = await assertRejects(() => setAutomationHandlers({ ...f.ctx, accountIds: [ACCOUNT_ID, OTHER_ID] }, null, { automation_handler: "off" }), AgentConfigOpError);
  assertEquals(ambiguous.code, "invalid_request"); assertEquals(f.reads, []); assertEquals(f.writes, []);
});
Deno.test("failed audience and handler account reads surface errors instead of defaults or empty success", async () => {
  const f = agentFixture({ platform: "facebook", failTable: "social_contacts" });
  assertEquals((await assertRejects(() => getAudience(f.ctx, null, page), AgentConfigOpError)).code, "internal_error");
  const failed = agentFixture({ failTable: "social_accounts" });
  assertEquals((await assertRejects(() => getAutomationHandlers(failed.ctx), AgentConfigOpError)).code, "internal_error");
});
Deno.test("audience keeps null-workspace bound contacts, excludes same-workspace unbound contacts, and pages timestamp ties", async () => {
  const f = agentFixture({ platform: "facebook" });
  const contact = { social_account_id: ACCOUNT_ID, workspace_id: null, platform: "facebook", last_interacted_at: "2026-09-10T00:00:00Z" };
  f.rows.social_contacts.push(
    { ...contact, id: ACCOUNT_ID }, { ...contact, id: TOOL_ID },
    { ...contact, id: OTHER_ID, social_account_id: OTHER_ID, workspace_id: "ws" },
  );
  const first = await getAudience(f.ctx, null, { limit: 1, cursor: null });
  assertEquals(first.data.map((row: { id: string }) => row.id), [TOOL_ID]);
  assert(first.next_cursor);
  const second = await getAudience(f.ctx, null, { limit: 1, cursor: decodeCursor(first.next_cursor) });
  assertEquals(second.data.map((row: { id: string }) => row.id), [ACCOUNT_ID]);
  assertEquals(second.next_cursor, null);
  for (const url of f.reads.filter((url) => url.pathname.endsWith("/social_contacts"))) {
    assertEquals(url.searchParams.get("social_account_id"), `in.(${ACCOUNT_ID})`);
    assert(!url.searchParams.has("workspace_id"));
    assertEquals(url.searchParams.get("order"), "last_interacted_at.desc,id.desc");
    assertEquals(url.searchParams.get("limit"), "2");
  }
  assertEquals(f.reads.at(-1)!.searchParams.getAll("or").length, 1);
});
Deno.test("unsupported audience platforms refuse before querying", async () => {
  const f = agentFixture();
  for (const platform of ["whatsapp", "tiktok", "", "toString"]) {
    assertEquals((await assertRejects(() => getAudience({ ...f.ctx, platform }, null, page), AgentConfigOpError)).code, "invalid_request");
  }
  assertEquals(f.reads, []);
});
