import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { ACCOUNT_ID, OTHER_ID, agentFixture } from "../../_shared/agentConfigTestSupport.ts";
import { AGENT_PLATFORM_FEATURE_KEYS } from "../../_shared/partnerEntitlement.ts";

function request(method = "PUT", suffix = "handlers", body?: unknown, query = `platform=facebook&account_id=${ACCOUNT_ID}`) {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/automation/${suffix}?${query}`, {
    method, headers: { "x-postora-key": "pk_live_test", "idempotency-key": "handlers-1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const drive = (f: ReturnType<typeof agentFixture>, req: Request) => handleRequest(req, () => f.admin);
const rpc = "patch_account_metadata_in_workspace";
const routes = [["GET", "handlers", "get_automation_handlers"], ["PUT", "handlers", "set_automation_handlers"], ["GET", "audience", "get_audience"]] as const;
for (const platform of Object.keys(AGENT_PLATFORM_FEATURE_KEYS)) {
  Deno.test(`handlers and audience use ${platform}'s own feature flag`, async () => {
    for (const [method, suffix] of routes.filter(([, suffix]) => suffix !== "audience" || platform !== "whatsapp")) {
      const f = agentFixture({ platform });
      f.rows.app_settings.forEach((row) => row.value = AGENT_PLATFORM_FEATURE_KEYS[platform].includes(String(row.key)));
      const response = await drive(f, request(method, suffix, method === "PUT" ? { automation_handler: "off" } : undefined, `platform=${platform}`));
      assertEquals(response.status, 200);
    }
  });
}
for (const [method, suffix, action] of routes) {
  Deno.test(`${action}: entitlement refusal records both system and usage logs before account lookup`, async () => {
    const f = agentFixture({ platform: "facebook", entitled: false });
    const response = await drive(f, request(method, suffix));
    assertEquals(response.status, 403); assertEquals((await response.json()).error.code, "feature_not_entitled");
    assert(!f.reads.some((url) => /\/(social_accounts|partner_api_key_accounts|social_contacts)$/.test(url.pathname)));
    assertEquals((f.writes.find((w) => w.table === "system_logs")!.row.metadata as Record<string, unknown>).action, action);
    assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "feature_not_entitled");
  });
  Deno.test(`${action}: unbound account refuses before account lookup or claim`, async () => {
    const f = agentFixture({ platform: "facebook" });
    const response = await drive(f, request(method, suffix, undefined, `platform=facebook&account_id=${OTHER_ID}`));
    assertEquals(response.status, 404);
    assertEquals((await response.json()).error.code, "resource_not_found");
    assert(!f.reads.some((url) => /\/(social_accounts|social_contacts)$/.test(url.pathname)));
    assertEquals(f.claims, []);
    assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "resource_not_found");
  });
}
for (const outcome of ["replay", "conflict", "in_progress", "indeterminate"]) {
  Deno.test(`handler PUT claim ${outcome} never calls metadata RPC`, async () => {
    const f = agentFixture({ platform: "facebook", claim: outcome });
    const response = await drive(f, request("PUT", "handlers", { automation_handler: "off" }));
    if (outcome === "replay") {
      assertEquals(await response.json(), { stored: true });
      assertEquals(response.headers.get("Idempotency-Replayed"), "true");
    } else {
      assertEquals(response.status, 409);
      assertEquals((await response.json()).error.code, `idempotency_${outcome}`);
    }
    assert(!f.writes.some((w) => w.table === rpc));
  });
}
Deno.test("claimed handler PUT settles all fields, replays stored body without a second RPC, and hashes changed media mode", async () => {
  const f = agentFixture({ platform: "facebook" });
  f.rows.social_accounts[0].account_metadata = { media_understanding: "audio", ig_igid: "keep" };
  const patch = { automation_handler: "n8n" };
  const response = await drive(f, request("PUT", "handlers", patch));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.automation_handler, "n8n"); assertEquals(body.comment_automation_handler, "off"); assertEquals(body.media_understanding, "audio");
  assertEquals(f.writes.find((w) => w.table === rpc)!.row, { p_account_id: ACCOUNT_ID, p_workspace_id: "ws", p_patch: patch });
  const settle = f.writes.find((w) => w.table === "partner_api_idempotency")!;
  assertEquals(settle.url.searchParams.get("attempt_token"), "eq.attempt-1");
  assertEquals(settle.row.http_status, 200); assertEquals(settle.row.response_body, body);
  const replay = await drive(f, request("PUT", "handlers", patch));
  assertEquals(await replay.json(), body);
  assertEquals(replay.headers.get("Idempotency-Replayed"), "true");
  const conflict = await drive(f, request("PUT", "handlers", { ...patch, media_understanding: "off" }));
  assertEquals((await conflict.json()).error.code, "idempotency_conflict");
  assertEquals(f.writes.filter((w) => w.table === rpc).length, 1);
});
for (const opts of [{ writeFails: true }, { settleFails: true }]) {
  Deno.test(`handler mutation or settlement failure fences the attempt: ${JSON.stringify(opts)}`, async () => {
    const f = agentFixture({ ...opts, platform: "facebook" });
    const response = await drive(f, request("PUT", "handlers", { automation_handler: "off" }));
    assertEquals((await response.json()).error.code, "idempotency_indeterminate");
    const mark = f.writes.find((w) => w.table === "partner_api_idempotency" && w.row.state === "indeterminate")!;
    assertEquals(mark.url.searchParams.get("attempt_token"), "eq.attempt-1");
  });
}
Deno.test("handler routes reject a mismatched account platform and refuse missing platform without a default", async () => {
  for (const method of ["GET", "PUT"]) {
    for (const query of [`platform=instagram&account_id=${ACCOUNT_ID}`, `account_id=${ACCOUNT_ID}`]) {
      const f = agentFixture({ platform: "facebook" });
      const response = await drive(f, request(method, "handlers", undefined, query));
      const code = query.startsWith("platform") ? "resource_not_found" : "feature_not_entitled";
      assertEquals((await response.json()).error.code, code);
      assertEquals(f.claims, []);
      assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, code);
    }
  }
});
Deno.test("handler GET returns all resolved fields", async () => {
  const f = agentFixture({ platform: "facebook" });
  const response = await drive(f, request("GET"));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals([body.automation_handler, body.comment_automation_handler, body.media_understanding], ["internal", "off", "off"]);
});
Deno.test("empty handler PUT is a logged invalid_request and never reaches the RPC", async () => {
  const f = agentFixture({ platform: "facebook" });
  const response = await drive(f, request("PUT", "handlers", {}));
  assertEquals(response.status, 400); assertEquals((await response.json()).error.code, "invalid_request");
  assert(!f.writes.some((w) => w.table === rpc));
  assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "invalid_request");
});
Deno.test("audience failed read is a logged error, never an empty page", async () => {
  const f = agentFixture({ platform: "facebook", failTable: "social_contacts" });
  const response = await drive(f, request("GET", "audience"));
  assertEquals(response.status, 500);
  assertEquals((await response.json()).error.code, "internal_error");
  assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "internal_error");
});
Deno.test("audience route rejects unsupported platform before entitlement or contact queries", async () => {
  for (const platform of ["whatsapp", "tiktok", ""]) {
    const f = agentFixture();
    const response = await drive(f, request("GET", "audience", undefined, `platform=${platform}`));
    assertEquals(response.status, 400); assertEquals((await response.json()).error.code, "invalid_request");
    assert(!f.reads.some((url) => /\/(partner_provisioned_workspaces|social_accounts|social_contacts)$/.test(url.pathname)));
    assertEquals(f.writes.find((w) => w.table === "partner_api_usage")?.row.error_code, "invalid_request");
  }
});
Deno.test("audience route exposes only bound contacts even when another contact shares workspace", async () => {
  const f = agentFixture({ platform: "facebook" });
  f.rows.social_contacts.push(
    { id: ACCOUNT_ID, social_account_id: ACCOUNT_ID, workspace_id: null, platform: "facebook" },
    { id: OTHER_ID, social_account_id: OTHER_ID, workspace_id: "ws", platform: "facebook" },
  );
  const response = await drive(f, request("GET", "audience"));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data.map((row: { id: string }) => row.id), [ACCOUNT_ID]);
  assertEquals(body.next_cursor, null);
});
