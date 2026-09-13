import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AgentConfigOpError, getAgentConfig, listAgentTools, setAgentToolAccounts, updateAgentConfig, upsertAgentTool } from "./agentConfigOps.ts";
import { ACCOUNT_ID, OTHER_ID, TOOL_ID, STORED_CONFIG, agentFixture } from "./agentConfigTestSupport.ts";
import { GUARDED_FIELDS } from "./configBlanking.ts";
import { deleteAccountScopedTool, parseUpsertToolInput, upsertAccountScopedTool, type ToolAdminClient } from "./toolWrites.ts";

for (const field of ["is_enabled", ...GUARDED_FIELDS]) {
  Deno.test(`partial config PUT of ${field} never writes an unmentioned guarded field`, async () => {
    const f = agentFixture();
    await updateAgentConfig(f.ctx, ACCOUNT_ID, { [field]: field === "is_enabled" ? false : "New content" });
    const write = f.writes.find((w) => w.table === "ai_agent_configs")!;
    assertEquals(write.method, "PATCH");
    for (const guarded of GUARDED_FIELDS.filter((key) => key !== field)) {
      assert(!Object.hasOwn(write.row, guarded), `${guarded} was added to the database payload`);
      assertEquals(f.rows.ai_agent_configs[0][guarded], STORED_CONFIG[guarded]);
    }
    assertEquals(write.url.searchParams.get("social_account_id"), `eq.${ACCOUNT_ID}`);
    assertEquals(write.url.searchParams.get("platform"), "eq.whatsapp");
    assert(!write.url.searchParams.has("user_id"));
  });
}
for (const field of GUARDED_FIELDS) {
  Deno.test(`existing ${field} can only be emptied with explicit confirmation`, async () => {
    const f = agentFixture();
    await assertRejects(() => updateAgentConfig(f.ctx, ACCOUNT_ID, { [field]: "" }), AgentConfigOpError);
    assertEquals(f.writes.length, 0);
    await updateAgentConfig(f.ctx, ACCOUNT_ID, { [field]: "", confirm_clear: true });
    assertEquals(f.rows.ai_agent_configs[0][field], "");
    assert(!Object.hasOwn(f.writes[0].row, "confirm_clear"));
  });
}
for (const confirm_clear of [false, true]) {
  Deno.test(`config read failure refuses a write even when confirm_clear=${confirm_clear}`, async () => {
    const f = agentFixture({ failTable: "ai_agent_configs" });
    await assertRejects(() => updateAgentConfig(f.ctx, ACCOUNT_ID, { is_enabled: false, confirm_clear }), AgentConfigOpError, "Unable to read");
    assertEquals(f.writes.length, 0);
    await assertRejects(() => getAgentConfig(f.ctx, ACCOUNT_ID), AgentConfigOpError, "Unable to read");
  });
}
Deno.test("unbound config and sharing account are refused before any database query", async () => {
  const f = agentFixture();
  await assertRejects(() => updateAgentConfig(f.ctx, OTHER_ID, { is_enabled: false }), AgentConfigOpError);
  await assertRejects(() => setAgentToolAccounts(f.ctx, TOOL_ID, ACCOUNT_ID, { social_account_ids: [OTHER_ID] }), AgentConfigOpError);
  assertEquals(f.reads, []); assertEquals(f.writes, []);
});
Deno.test("a corrupted cross-workspace binding cannot reach config", async () => {
  const f = agentFixture({ foreignWorkspace: true });
  await assertRejects(() => getAgentConfig(f.ctx, ACCOUNT_ID), AgentConfigOpError);
  assertEquals(f.reads.length, 1);
  assertEquals(f.reads[0].searchParams.get("workspace_id"), "eq.ws");
});
Deno.test("new config uses an insert so concurrent first saves cannot bypass blanking", async () => {
  const f = agentFixture({ noConfig: true });
  await updateAgentConfig(f.ctx, ACCOUNT_ID, { persona_instructions: "New persona" });
  assertEquals(f.writes[0].method, "POST");
  assertEquals(f.writes[0].row.user_id, "owner"); // legacy FK metadata derived from account
  assert(!f.writes[0].url.searchParams.has("on_conflict"));
  assert(!Object.hasOwn(f.writes[0].row, "business_profile_text"));
});
Deno.test("a persona populated between guard read and write cannot be erased by a stale empty save", async () => {
  const f = agentFixture({ concurrentPersona: true });
  f.rows.ai_agent_configs[0].persona_instructions = "";
  await assertRejects(() => updateAgentConfig(f.ctx, ACCOUNT_ID, { persona_instructions: "" }));
  assertEquals(f.rows.ai_agent_configs[0].persona_instructions, "Concurrent live persona");
  assertEquals(f.writes[0].url.searchParams.get("updated_at"), `eq.${STORED_CONFIG.updated_at}`);
});
Deno.test("structured profile rendering participates in the same blanking guard", async () => {
  const f = agentFixture();
  await assertRejects(() => updateAgentConfig(f.ctx, ACCOUNT_ID, { business_profile: {} }), AgentConfigOpError);
  assertEquals(f.writes, []);
  await updateAgentConfig(f.ctx, ACCOUNT_ID, { business_profile: { notes: "New profile" } });
  assertEquals(f.writes[0].row.business_profile_text, "Additional notes:\nNew profile");
});
Deno.test("tool list strips both credential representations and owner metadata", async () => {
  const f = agentFixture();
  const result = await listAgentTools(f.ctx, null, { limit: 20, cursor: null });
  assertEquals(result.data.length, 1);
  assertEquals(result.data[0].has_secret, true);
  for (const field of ["secret", "credentials_secret_id", "user_id"]) assert(!Object.hasOwn(result.data[0], field));
});
Deno.test("sharing delegates the parsed deduplicated set to the existing transactional RPC", async () => {
  const f = agentFixture();
  await setAgentToolAccounts(f.ctx, TOOL_ID, ACCOUNT_ID, { social_account_ids: [ACCOUNT_ID, ACCOUNT_ID] });
  const rpc = f.writes.find((w) => w.table === "set_ai_agent_tool_accounts")!;
  assertEquals(rpc.row, { p_user_id: "owner", p_tool_id: TOOL_ID, p_social_account_ids: [ACCOUNT_ID] });
  assert(!f.reads.some((url) => url.searchParams.has("user_id")));
});
Deno.test("whole-tool sharing cannot remove an existing unbound share", async () => {
  const f = agentFixture({ sharedOutside: true });
  await assertRejects(() => setAgentToolAccounts(f.ctx, TOOL_ID, ACCOUNT_ID, { social_account_ids: [] }));
  assertEquals(f.writes, []);
});
Deno.test("workspace tool writers enforce share bindings themselves before touching Vault", async () => {
  const f = agentFixture({ sharedOutside: true });
  const vaultWrites: string[] = [];
  const vault = {
    upsertCredentials() { vaultWrites.push("upsert"); return Promise.resolve({ secretId: "vault", configuredFields: ["secret"] }); },
    deleteCredentials() { vaultWrites.push("delete"); return Promise.resolve(); },
  };
  const scope = { workspaceId: "ws", accountIds: [ACCOUNT_ID], toolId: TOOL_ID };
  // The existing helper seam abstracts over multiple supabase-js versions.
  const admin = f.admin as unknown as ToolAdminClient;
  const input = parseUpsertToolInput({ tool: { social_account_id: ACCOUNT_ID, name: "brand_tool", description: "Brand lookup", connector_type: "custom_rest", url: "https://store.example/api", credentials: { secret: "new-secret" } } });
  await assertRejects(() => upsertAccountScopedTool(admin, vault, { ...scope, input }));
  await assertRejects(() => deleteAccountScopedTool(admin, vault, scope));
  assertEquals(vaultWrites, []);
  assertEquals(f.writes, []);
});
Deno.test("tool PUT reuses credential partition and merge, targets path id and never returns secrets", async () => {
  const f = agentFixture();
  const saved = await upsertAgentTool(f.ctx, TOOL_ID, ACCOUNT_ID, { name: "brand_tool", description: "Brand lookup", connector_type: "custom_rest", url: "https://store.example/api", credentials: { secret: "new-secret" } });
  const vault = f.writes.findIndex((w) => w.table === "upsert_connector_credential_secret");
  const write = f.writes.findIndex((w) => w.table === "ai_agent_tools");
  assert(vault >= 0 && vault < write);
  assertEquals(f.writes[write].url.searchParams.get("id"), `eq.${TOOL_ID}`);
  assertEquals(f.writes[write].url.searchParams.get("social_account_id"), `eq.${ACCOUNT_ID}`);
  assertEquals(f.rows.ai_agent_tools[0].settings, { store_url: "https://store.example" });
  assert(!JSON.stringify(saved).includes("new-secret"));
  assert(!JSON.stringify(saved).includes("vault-id"));
});
for (const failTable of ["social_accounts", "ai_agent_tools", "ai_agent_tool_accounts", "ai_agent_allowed_models"]) {
  Deno.test(`${failTable} read failure never becomes a successful empty result or mutation`, async () => {
    const f = agentFixture({ failTable });
    const operation = failTable === "ai_agent_allowed_models"
      ? () => updateAgentConfig(f.ctx, ACCOUNT_ID, { model: "openai/approved" })
      : failTable === "ai_agent_tool_accounts"
      ? () => setAgentToolAccounts(f.ctx, TOOL_ID, ACCOUNT_ID, { social_account_ids: [] })
      : () => listAgentTools(f.ctx, null, { limit: 20, cursor: null });
    await assertRejects(operation);
    assertEquals(f.writes, []);
  });
}

Deno.test("escalation_timeout_minutes outside 1..10080 is refused, inside is stored", async () => {
  const f = agentFixture();
  await assertRejects(
    () => updateAgentConfig(f.ctx, ACCOUNT_ID, { escalation_timeout_minutes: 0 }),
    AgentConfigOpError,
    "escalation_timeout_minutes must be an integer between 1 and 10080",
  );
  await assertRejects(
    () => updateAgentConfig(f.ctx, ACCOUNT_ID, { escalation_timeout_minutes: 10081 }),
    AgentConfigOpError,
    "escalation_timeout_minutes must be an integer between 1 and 10080",
  );
  await updateAgentConfig(f.ctx, ACCOUNT_ID, { escalation_timeout_minutes: 90 });
  const write = f.writes.find((w) => w.table === "ai_agent_configs")!;
  assertEquals(write.row.escalation_timeout_minutes, 90);
});

