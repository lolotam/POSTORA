import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { ACCOUNT_ID, OTHER_ID, TOOL_ID, STORED_CONFIG, agentFixture } from "../../_shared/agentConfigTestSupport.ts";
import { GUARDED_FIELDS } from "../../_shared/configBlanking.ts";
import { AGENT_PLATFORM_FEATURE_KEYS } from "../../_shared/partnerEntitlement.ts";
import { GENERIC_SCOPES, LEGACY_SCOPES } from "../../_shared/partnerScopes.ts";

const routes = [
  ["GET", "agent", "get_agent_config"], ["PUT", "agent", "update_agent_config"],
  ["GET", "tools", "list_agent_tools"], ["PUT", `tools/${TOOL_ID}`, "upsert_agent_tool"],
  ["DELETE", `tools/${TOOL_ID}`, "delete_agent_tool"], ["PUT", `tools/${TOOL_ID}/accounts`, "set_tool_accounts"],
] as const;
function request(method = "PUT", suffix = "agent", body?: unknown, query = `account_id=${ACCOUNT_ID}&platform=whatsapp`) {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/automation/${suffix}?${query}`, {
    method, headers: { "x-postora-key": "pk_live_test", "idempotency-key": "idem-1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const drive = (f: ReturnType<typeof agentFixture>, req: Request) => handleRequest(req, () => f.admin);
for (const [method, suffix, action] of routes) {
  Deno.test(`${action}: entitlement is first and every refusal is logged`, async () => {
    const f = agentFixture({ entitled: false });
    const response = await drive(f, request(method, suffix));
    assertEquals(response.status, 403); assertEquals((await response.json()).error.code, "feature_not_entitled");
    assert(!f.reads.some((url) => /\/(social_accounts|partner_api_key_accounts|ai_agent_configs|ai_agent_tools)$/.test(url.pathname)));
    const log = f.writes.find((w) => w.table === "system_logs")!;
    assertEquals((log.row.metadata as Record<string, unknown>).action, action);
    assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "feature_not_entitled");
  });
}
for (const outcome of ["replay", "conflict", "in_progress", "indeterminate"]) {
  Deno.test(`config PUT claim ${outcome} never performs a write`, async () => {
    const f = agentFixture({ claim: outcome });
    const response = await drive(f, request("PUT", "agent", { is_enabled: false }));
    const body = await response.json();
    if (outcome === "replay") { assertEquals(body, { stored: true }); assertEquals(response.headers.get("Idempotency-Replayed"), "true"); }
    else { assertEquals(response.status, 409); assertEquals(body.error.code, `idempotency_${outcome}`); }
    assert(!f.writes.some((w) => w.table === "ai_agent_configs"));
  });
}
Deno.test("claimed partial PUT preserves both guarded fields in the actual write, then replays without another write", async () => {
  const f = agentFixture();
  const first = await drive(f, request("PUT", "agent", { is_enabled: false }));
  assertEquals(first.status, 200); const body = await first.json();
  const mutation = f.writes.find((w) => w.table === "ai_agent_configs")!;
  assertEquals(mutation.row, { is_enabled: false });
  for (const field of GUARDED_FIELDS) assertEquals(f.rows.ai_agent_configs[0][field], STORED_CONFIG[field]);
  const settle = f.writes.find((w) => w.table === "partner_api_idempotency")!;
  assertEquals(settle.url.searchParams.get("attempt_token"), "eq.attempt-1");
  assertEquals(settle.row.response_body, body);
  const replay = await drive(f, request("PUT", "agent", { is_enabled: false }));
  assertEquals(await replay.json(), body);
  assertEquals(replay.headers.get("Idempotency-Replayed"), "true");
  assertEquals(f.writes.filter((w) => w.table === "ai_agent_configs").length, 1);
  const conflict = await drive(f, request("PUT", "agent", { is_enabled: false, confirm_clear: true }));
  assertEquals((await conflict.json()).error.code, "idempotency_conflict");
});
for (const opts of [{ writeFails: true }, { settleFails: true }]) {
  Deno.test(`unknown config write/settlement outcome is fenced ${JSON.stringify(opts)}`, async () => {
    const f = agentFixture(opts);
    const response = await drive(f, request("PUT", "agent", { is_enabled: false }));
    assertEquals((await response.json()).error.code, "idempotency_indeterminate");
    const mark = f.writes.find((w) => w.table === "partner_api_idempotency" && w.row.state === "indeterminate")!;
    assertEquals(mark.url.searchParams.get("attempt_token"), "eq.attempt-1");
  });
}
Deno.test("blanking refusal and failed reads are stable errors with usage rows", async () => {
  const f = agentFixture();
  const denied = await drive(f, request("PUT", "agent", { persona_instructions: "" }));
  assertEquals(denied.status, 409);
  assertEquals((await denied.json()).error.details.blanked_fields, ["persona_instructions"]);
  assertEquals(f.writes.filter((w) => w.table === "ai_agent_configs").length, 0);
  for (const method of ["GET", "PUT"]) {
    const failed = agentFixture({ failTable: "ai_agent_configs" });
    const response = await drive(failed, request(method, "agent", method === "PUT" ? { is_enabled: false } : undefined));
    assertEquals(response.status, 500); assertEquals((await response.json()).error.code, "internal_error");
    assertEquals(failed.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "internal_error");
  }
});
Deno.test("unbound selector and sharing target refuse without looking them up or claiming", async () => {
  for (const req of [request("PUT", "agent", { is_enabled: false }, `account_id=${OTHER_ID}&platform=whatsapp`), request("PUT", `tools/${TOOL_ID}/accounts`, { social_account_ids: [OTHER_ID] })]) {
    const f = agentFixture(); const response = await drive(f, req);
    assertEquals(response.status, 404); assertEquals((await response.json()).error.code, "resource_not_found");
    assert(!f.reads.some((url) => url.toString().includes(OTHER_ID)));
    assertEquals(f.claims.length, 0);
  }
});
Deno.test("DELETE is idempotent even after the first call removes its tool", async () => {
  const f = agentFixture();
  const first = await drive(f, request("DELETE", `tools/${TOOL_ID}`));
  assertEquals(first.status, 200); const body = await first.json();
  const second = await drive(f, request("DELETE", `tools/${TOOL_ID}`));
  assertEquals(await second.json(), body);
  assertEquals(second.headers.get("Idempotency-Replayed"), "true");
  assertEquals(f.writes.filter((w) => w.method === "DELETE").length, 1);
});
Deno.test("automation scopes are generic and every selected feature flag exists in the browser registry", async () => {
  for (const scope of ["automation:read", "automation:manage"]) {
    assert((GENERIC_SCOPES as readonly string[]).includes(scope));
    assert(!(LEGACY_SCOPES as readonly string[]).includes(scope));
  }
  const source = await Deno.readTextFile(new URL("../../../../src/hooks/useFeatureFlags.tsx", import.meta.url));
  for (const flags of Object.values(AGENT_PLATFORM_FEATURE_KEYS)) for (const flag of flags) assert(source.includes(`"${flag}"`), flag);
});

for (const selected of Object.keys(AGENT_PLATFORM_FEATURE_KEYS)) {
  Deno.test(`agent config checks ${selected}'s actual flag and matches the account platform`, async () => {
    const f = agentFixture({ platform: selected });
    f.rows.ai_agent_configs[0].platform = selected;
    f.rows.app_settings.forEach((row) => row.value = AGENT_PLATFORM_FEATURE_KEYS[selected].includes(String(row.key)));
    const response = await drive(f, request("GET", "agent", undefined, `platform=${selected}&account_id=${ACCOUNT_ID}`));
    assertEquals(response.status, 200);
    assertEquals((await response.json()).config.platform, selected);
    if (selected !== "whatsapp") {
      f.rows.app_settings.find((row) => row.key === "feature_msg_whatsapp")!.value = true;
      const wrong = await drive(f, request("PUT", "agent", { is_enabled: false }));
      assertEquals(wrong.status, 404);
      assertEquals(f.writes.filter((w) => w.table === "ai_agent_configs").length, 0);
    }
  });
}
Deno.test("sharing to a bound but disabled platform refuses that surface before any claim", async () => {
  const f = agentFixture();
  f.rows.partner_api_key_accounts.push({ key_id: "key", workspace_id: "ws", social_account_id: OTHER_ID });
  f.rows.social_accounts.push({ id: OTHER_ID, workspace_id: "ws", user_id: "owner", platform: "instagram", is_active: true });
  f.rows.app_settings.find((row) => row.key === "feature_msg_instagram")!.value = false;
  const response = await drive(f, request("PUT", `tools/${TOOL_ID}/accounts`, { social_account_ids: [OTHER_ID] }));
  assertEquals(response.status, 403); assertEquals((await response.json()).error.code, "feature_not_entitled");
  assertEquals(f.claims.length, 0);
  assert(!f.writes.some((w) => w.table === "set_ai_agent_tool_accounts"));
});

const toolBody = { name: "brand_tool", description: "Brand lookup", connector_type: "custom_rest", url: "https://store.example/api", credentials: { secret: "credential-v1" } };
for (const [method, suffix, body] of [
  ["PUT", `tools/${TOOL_ID}`, toolBody],
  ["DELETE", `tools/${TOOL_ID}`, undefined],
  ["PUT", `tools/${TOOL_ID}/accounts`, { social_account_ids: [ACCOUNT_ID] }],
] as const) {
  for (const outcome of ["replay", "conflict", "in_progress", "indeterminate"]) {
    Deno.test(`${method} ${suffix} ${outcome} never mutates tools or credentials`, async () => {
      const f = agentFixture({ claim: outcome });
      const response = await drive(f, request(method, suffix, body));
      if (outcome === "replay") assertEquals(await response.json(), { stored: true });
      else assertEquals((await response.json()).error.code, `idempotency_${outcome}`);
      assert(f.writes.every((write) => ["system_logs", "partner_api_usage"].includes(write.table)));
    });
  }
}
Deno.test("tool PUT settles, replays without a second credential write, and hashes nested credential changes", async () => {
  const f = agentFixture();
  const first = await drive(f, request("PUT", `tools/${TOOL_ID}`, toolBody));
  assertEquals(first.status, 200); const saved = await first.json();
  assert(!JSON.stringify(saved).includes("credential-v1"));
  assertEquals(await (await drive(f, request("PUT", `tools/${TOOL_ID}`, toolBody))).json(), saved);
  const changed = await drive(f, request("PUT", `tools/${TOOL_ID}`, { ...toolBody, credentials: { secret: "credential-v2" } }));
  assertEquals((await changed.json()).error.code, "idempotency_conflict");
  assertEquals(f.writes.filter((write) => write.table === "upsert_connector_credential_secret").length, 1);
});
Deno.test("sharing PUT settles through its RPC and replays its stored response", async () => {
  const f = agentFixture(); const body = { social_account_ids: [ACCOUNT_ID] };
  const first = await drive(f, request("PUT", `tools/${TOOL_ID}/accounts`, body));
  assertEquals(first.status, 200); const saved = await first.json();
  assertEquals(await (await drive(f, request("PUT", `tools/${TOOL_ID}/accounts`, body))).json(), saved);
  assertEquals(f.writes.filter((write) => write.table === "set_ai_agent_tool_accounts").length, 1);
});
