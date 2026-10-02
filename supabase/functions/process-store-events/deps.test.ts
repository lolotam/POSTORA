import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { WhatsAppOpError } from "../_shared/whatsappPartnerOps.ts";
import {
  classifyQrTextResult,
  classifySendError,
  classifyStoreReadOutput,
  createStoreEventPorts,
  optedOutFromLookup,
  optOutLookupPhone,
  storeBindingMatches,
} from "./deps.ts";
import type { RecordOpenerInput } from "./worker.ts";

const event = {
  connector_id: "connector-1",
  social_account_id: "account-1",
  user_id: "user-1",
};
const binding = { ...event };

Deno.test("classifySendError and a QR send without a message id", () => {
  const timedOut = new Error("request timed out");
  const aborted = new Error("operation aborted");
  const denied = new Error("unauthorized");
  (denied as Error & { status: number }).status = 401;
  const upstream = new Error("upstream");
  (upstream as Error & { status: number }).status = 500;
  const cases: Array<{ name: string; outcome: { accepted: false; definite: boolean; reason?: string } | { accepted: true; messageId: string } }> = [
    {
      name: "WhatsAppOpError indeterminate",
      outcome: classifySendError(new WhatsAppOpError("maybe sent", "internal_error", 500, undefined, true)),
    },
    { name: "status 500", outcome: classifySendError(upstream) },
    { name: "timed out", outcome: classifySendError(timedOut) },
    { name: "aborted", outcome: classifySendError(aborted) },
    { name: "401", outcome: classifySendError(denied) },
    { name: "QR send without messageId", outcome: classifyQrTextResult(undefined) },
  ];
  const expected: Array<{ accepted: false; definite: boolean; reason?: string } | { accepted: true; messageId: string }> = [
    { accepted: false, definite: false },
    { accepted: false, definite: false },
    { accepted: false, definite: false },
    { accepted: false, definite: false },
    { accepted: false, definite: true, reason: "unauthorized" },
    { accepted: false, definite: false },
  ];
  cases.forEach((item, index) => {
    assertEquals(item.outcome, expected[index], item.name);
  });
  assertEquals(classifyQrTextResult("wamid.1"), { accepted: true, messageId: "wamid.1" });
});

Deno.test("store binding must match the event connector and user, ignoring social_account_id", () => {
  const cases: Array<{ name: string; binding: typeof binding | null; matches: boolean }> = [
    { name: "match", binding, matches: true },
    { name: "null", binding: null, matches: false },
    { name: "connector", binding: { ...binding, connector_id: "other" }, matches: false },
    { name: "account differs", binding: { ...binding, social_account_id: "other" }, matches: true },
    { name: "user", binding: { ...binding, user_id: "other" }, matches: false },
  ];
  for (const item of cases) {
    assertEquals(storeBindingMatches(item.binding, event), item.matches, item.name);
  }
});

Deno.test("a timed-out store read is retried and a missing product is final", () => {
  const cases: Array<{ name: string; output: string; kind: "transient" | "absent" | "ready" }> = [
    {
      name: "timeout",
      output: 'Connector "woo" failed via connector adapter: request timed out.',
      kind: "transient",
    },
    {
      name: "http 503",
      output: 'Connector "woo" failed via woocommerce adapter [woocommerce_http_error] (HTTP 503): WooCommerce rejected the request.',
      kind: "transient",
    },
    {
      name: "http 404",
      output: 'Connector "woo" failed via woocommerce adapter [woocommerce_http_error] (HTTP 404): WooCommerce rejected the request.',
      kind: "absent",
    },
    {
      name: "write denied",
      output: 'Connector "woo" failed via woocommerce adapter [store_write_denied] (HTTP 401): WooCommerce refused the write.',
      kind: "absent",
    },
    {
      name: "product body",
      output: 'Connector "woo" returned: {"stock_status":"instock"}',
      kind: "ready",
    },
  ];
  for (const item of cases) {
    assertEquals(classifyStoreReadOutput(item.output), item.kind, item.name);
  }
});

function openerInput(): RecordOpenerInput {
  return {
    event: {
      id: "11111111-1111-4111-8111-111111111111",
      user_id: "user-1",
      social_account_id: "account-1",
      connector_id: "connector-1",
      binding_id: "binding-1",
      flow: "cod_confirm",
      external_id: "1042",
      payload: { phone: "96555512345" },
      status: "sending",
      claim_token: "token-1",
      due_at: "2026-09-27T12:00:00.000Z",
      created_at: "2026-09-27T12:00:00.000Z",
      attempts: 1,
      outbound_message_id: "wamid.kept",
    },
    account: {
      platform: "whatsapp",
      connectionMode: "cloud_api",
      phoneNumberId: "pnid",
      platformUserId: "pnid",
      languageMode: "en",
      agentEnabled: true,
      defaultMode: "ai_first",
      settings: null,
      connectorVisible: true,
      connectorReadOnly: false,
      optedOut: false,
      connected: true,
    },
    threadId: "thread-1",
    conversationId: "conv-1",
    messageId: "wamid.kept",
    text: "Hello",
  };
}

function recordingAdmin(found: { message: boolean; thread: boolean; messageError?: boolean }) {
  const inserts: string[] = [];
  const admin = {
    from(table: string) {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        limit() { return builder; },
        maybeSingle() {
          if (found.messageError) return Promise.resolve({ data: null, error: { message: "message read failed" } });
          return Promise.resolve({ data: found.message ? { id: "row" } : null, error: null });
        },
        insert() {
          inserts.push(table);
          return Promise.resolve({ error: null });
        },
        then(resolve: (value: { data: unknown[]; error: null }) => void) {
          resolve({ data: found.thread ? [{ id: "row" }] : [], error: null });
        },
      };
      return builder;
    },
  };
  return { admin, inserts };
}

Deno.test("recordOpener writes only the inbox and thread rows that are missing", async () => {
  const both = recordingAdmin({ message: true, thread: true });
  await createStoreEventPorts(both.admin).recordOpener(openerInput());
  assertEquals(both.inserts, []);

  const neither = recordingAdmin({ message: false, thread: false });
  await createStoreEventPorts(neither.admin).recordOpener(openerInput());
  assertEquals(neither.inserts, ["whatsapp_messages", "ai_thread_messages"]);

  const threadOnly = recordingAdmin({ message: true, thread: false });
  await createStoreEventPorts(threadOnly.admin).recordOpener(openerInput());
  assertEquals(threadOnly.inserts, ["ai_thread_messages"]);
});

Deno.test("recordOpener does not insert when the inbox read fails", async () => {
  const broken = recordingAdmin({ message: false, thread: false, messageError: true });
  await assertRejects(() => createStoreEventPorts(broken.admin).recordOpener(openerInput()));
  assertEquals(broken.inserts, []);
});

Deno.test("alertAdmin records the attention row under category ai", async () => {
  const inserted: Array<Record<string, unknown>> = [];
  const admin = {
    from(table: string) {
      const builder = {
        insert(row: Record<string, unknown>) {
          if (table === "system_logs") inserted.push(row);
          return Promise.resolve({ error: null });
        },
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
  await createStoreEventPorts(admin).alertAdmin(openerInput().event, "indeterminate");
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].category, "ai");
  assertEquals(inserted[0].source, "process-store-events");
  assertEquals(inserted[0].level, "warn");
});

Deno.test("opt-out lookup runs only for a phone the event named", () => {
  const cases: Array<{ name: string; phone: string | undefined; row: unknown; lookup: string | null; optedOut: boolean }> = [
    { name: "row for the phone", phone: "96555512345", row: { user_id: "user-1" }, lookup: "96555512345", optedOut: true },
    { name: "no row", phone: "96555512345", row: null, lookup: "96555512345", optedOut: false },
    { name: "missing phone", phone: undefined, row: { user_id: "user-1" }, lookup: null, optedOut: false },
    { name: "empty phone", phone: "", row: { user_id: "user-1" }, lookup: null, optedOut: false },
  ];
  for (const item of cases) {
    const lookup = optOutLookupPhone(item.phone);
    assertEquals(lookup, item.lookup, item.name);
    assertEquals(optedOutFromLookup(lookup, item.row), item.optedOut, item.name);
  }
});

function fakeAccountAdmin(
  socialAccountRow: Record<string, unknown>,
  bindingRow?: Record<string, unknown> | null,
) {
  const bindingData = bindingRow === undefined
    ? {
        id: "binding-1",
        connector_id: "connector-1",
        social_account_id: "account-1",
        user_id: "user-1",
      }
    : bindingRow;

  const admin = {
    from(table: string) {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        maybeSingle() {
          if (table === "social_accounts") {
            return Promise.resolve({ data: socialAccountRow, error: null });
          }
          if (table === "store_webhook_bindings") {
            return Promise.resolve({
              data: bindingData,
              error: null,
            });
          }
          if (table === "ai_agent_configs") {
            return Promise.resolve({
              data: {
                user_id: "user-1",
                social_account_id: "account-1",
                is_enabled: true,
                language_mode: "en",
                default_mode: "ai_first",
                agent_behavior: { procedures: { cod_confirm: { enabled: true } } },
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (value: { data: unknown[]; error: null }) => void) {
          if (table === "ai_agent_tools") {
            resolve({
              data: [{
                id: "connector-1",
                name: "woo",
                connector_type: "woocommerce",
                is_enabled: true,
                read_only_mode: false,
                scope: "account",
              }],
              error: null,
            });
            return;
          }
          if (table === "ai_agent_tool_accounts") {
            resolve({
              data: [{ tool_id: "connector-1", social_account_id: "account-1" }],
              error: null,
            });
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };
  return admin;
}

Deno.test("loadAccount maps is_active and retired platform_user_id to connected boolean", async () => {
  const cases: Array<{
    name: string;
    isActive: boolean;
    platformUserId: string;
    expectedConnected: boolean;
  }> = [
    {
      name: "is_active:false -> connected:false",
      isActive: false,
      platformUserId: "96500000001",
      expectedConnected: false,
    },
    {
      name: 'platform_user_id "retired_x" -> connected:false',
      isActive: true,
      platformUserId: "retired_x",
      expectedConnected: false,
    },
    {
      name: "is_active:true with a digits number -> connected:true",
      isActive: true,
      platformUserId: "96500000001",
      expectedConnected: true,
    },
  ];
  for (const item of cases) {
    const admin = fakeAccountAdmin({
      id: "account-1",
      user_id: "user-1",
      platform: "whatsapp",
      connection_mode: "cloud_api",
      is_active: item.isActive,
      platform_user_id: item.platformUserId,
      access_token: null,
      account_metadata: {},
      workspace_id: null,
    });
    const ports = createStoreEventPorts(admin);
    const account = await ports.loadAccount(openerInput().event);
    assertEquals(account?.connected, item.expectedConnected, item.name);
  }
});

Deno.test("loadAccount sets bindingAccountId from the binding row and keeps connectorVisible true when binding account differs", async () => {
  const admin = fakeAccountAdmin(
    {
      id: "account-event",
      user_id: "user-1",
      platform: "whatsapp",
      connection_mode: "cloud_api",
      is_active: true,
      platform_user_id: "96500000001",
      access_token: null,
      account_metadata: {},
      workspace_id: null,
    },
    {
      id: "binding-1",
      connector_id: "connector-1",
      social_account_id: "account-binding-other",
      user_id: "user-1",
    },
  );
  const ports = createStoreEventPorts(admin);
  const account = await ports.loadAccount(openerInput().event);
  assertEquals(account?.bindingAccountId, "account-binding-other");
  assertEquals(account?.connectorVisible, true);
});

Deno.test("retargetEvent issues one update filtered by id and claim_token with target account and pending status", async () => {
  let updateTable = "";
  let updatePayload: Record<string, unknown> = {};
  const eqFilters: Array<[string, unknown]> = [];

  const admin = {
    from(table: string) {
      updateTable = table;
      const builder = {
        update(patch: Record<string, unknown>) {
          updatePayload = patch;
          return builder;
        },
        eq(col: string, val: unknown) {
          eqFilters.push([col, val]);
          return builder;
        },
        select(_cols?: string) {
          return Promise.resolve({ data: [{ id: "event-1" }], error: null });
        },
      };
      return builder;
    },
  };

  const ports = createStoreEventPorts(admin as any);
  const result = await ports.retargetEvent!("event-1", "claim-token-123", "target-account-id");

  assertEquals(result, true);
  assertEquals(updateTable, "store_events");
  assertEquals(updatePayload, {
    social_account_id: "target-account-id",
    status: "pending",
    claimed_at: null,
    claim_token: null,
    send_attempt_id: null,
  });
  assertEquals(eqFilters, [
    ["id", "event-1"],
    ["claim_token", "claim-token-123"],
  ]);
});

Deno.test("(D2) retargetEvent returns false when the update matched no row (data [])", async () => {
  const admin = {
    from(_table: string) {
      const builder = {
        update(_patch: Record<string, unknown>) {
          return builder;
        },
        eq(_col: string, _val: unknown) {
          return builder;
        },
        select(_cols?: string) {
          return Promise.resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };

  const ports = createStoreEventPorts(admin as any);
  const result = await ports.retargetEvent!("event-1", "claim-token-123", "target-account-id");
  assertEquals(result, false);
});

