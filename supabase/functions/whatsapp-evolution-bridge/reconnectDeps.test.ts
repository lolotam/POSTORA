import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildReconnectDeps } from "./reconnectDeps.ts";

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

interface FromCall {
  table: string;
  method: string;
  args?: unknown;
}

function createMockAdmin(options: {
  rpcResult?: { data: unknown; error: unknown };
  rpcHandler?: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown };
  fromHandler?: (table: string) => any;
} = {}) {
  const rpcCalls: RpcCall[] = [];
  const fromCalls: FromCall[] = [];

  const admin = {
    rpcCalls,
    fromCalls,
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (options.rpcHandler) {
        return Promise.resolve(options.rpcHandler(name, args));
      }
      return Promise.resolve(options.rpcResult ?? { data: null, error: null });
    },
    from: (table: string) => {
      fromCalls.push({ table, method: "from" });
      if (options.fromHandler) {
        return options.fromHandler(table);
      }
      const builder: any = {
        select: (...args: unknown[]) => {
          fromCalls.push({ table, method: "select", args });
          return builder;
        },
        update: (...args: unknown[]) => {
          fromCalls.push({ table, method: "update", args });
          return builder;
        },
        insert: (...args: unknown[]) => {
          fromCalls.push({ table, method: "insert", args });
          return builder;
        },
        eq: (...args: unknown[]) => {
          fromCalls.push({ table, method: "eq", args });
          return builder;
        },
        maybeSingle: () => {
          fromCalls.push({ table, method: "maybeSingle" });
          return Promise.resolve({ data: null, error: null });
        },
        then: (onfulfilled?: (res: any) => any) => {
          return Promise.resolve({ error: null }).then(onfulfilled);
        },
      };
      return builder;
    },
  };

  return { admin, rpcCalls, fromCalls };
}

Deno.test("buildReconnectDeps: findInstance makes exactly one admin.rpc('get_owned_evolution_instance') with user scope and no .from('whatsapp_evolution_instances')", async () => {
  const { admin, rpcCalls, fromCalls } = createMockAdmin({
    rpcResult: {
      data: { instance_name: "postora_acc-1", jwt_key: "jwt-test-key" },
      error: null,
    },
  });
  const ctx = { userId: "user-123", webhookBaseUrl: "https://api.postora.cloud" };
  const fakeApi = {} as any;
  const deps = buildReconnectDeps(admin, ctx, fakeApi);

  const result = await deps.findInstance("acc-1");

  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0], {
    name: "get_owned_evolution_instance",
    args: { p_account_id: "acc-1", p_user_id: "user-123" },
  });
  assertEquals(result, { instance_name: "postora_acc-1", jwt_key: "jwt-test-key" });
  const instanceFromCalls = fromCalls.filter((c) => c.table === "whatsapp_evolution_instances");
  assertEquals(instanceFromCalls.length, 0, "Must not query whatsapp_evolution_instances directly");
});

Deno.test("buildReconnectDeps: findInstance returns null when get_owned_evolution_instance returns null", async () => {
  const { admin, rpcCalls } = createMockAdmin({
    rpcResult: { data: null, error: null },
  });
  const ctx = { userId: "user-123", webhookBaseUrl: "https://api.postora.cloud" };
  const fakeApi = {} as any;
  const deps = buildReconnectDeps(admin, ctx, fakeApi);

  const result = await deps.findInstance("acc-not-found");

  assertEquals(rpcCalls.length, 1);
  assertEquals(result, null);
});

Deno.test("buildReconnectDeps: findInstance throws when get_owned_evolution_instance returns an rpc error", async () => {
  const dbError = new Error("rpc statement timeout");
  const { admin } = createMockAdmin({
    rpcResult: { data: null, error: dbError },
  });
  const ctx = { userId: "user-123", webhookBaseUrl: "https://api.postora.cloud" };
  const fakeApi = {} as any;
  const deps = buildReconnectDeps(admin, ctx, fakeApi);

  await assertRejects(
    () => deps.findInstance("acc-1"),
    Error,
    "rpc statement timeout",
  );
});

Deno.test("buildReconnectDeps: saveQr makes exactly one admin.rpc('save_owned_evolution_qr') with user scope and no .from('whatsapp_evolution_instances')", async () => {
  const { admin, rpcCalls, fromCalls } = createMockAdmin({
    rpcResult: { data: true, error: null },
  });
  const ctx = { userId: "user-123", webhookBaseUrl: "https://api.postora.cloud" };
  const fakeApi = {} as any;
  const deps = buildReconnectDeps(admin, ctx, fakeApi);

  await deps.saveQr("acc-1", "qr-base64", "connecting");

  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0], {
    name: "save_owned_evolution_qr",
    args: {
      p_account_id: "acc-1",
      p_user_id: "user-123",
      p_qr: "qr-base64",
      p_state: "connecting",
    },
  });
  const instanceFromCalls = fromCalls.filter((c) => c.table === "whatsapp_evolution_instances");
  assertEquals(instanceFromCalls.length, 0, "Must not update whatsapp_evolution_instances directly");
});

Deno.test("buildReconnectDeps: saveQr throws 'instance not found for owner' when save_owned_evolution_qr returns false", async () => {
  const { admin, rpcCalls } = createMockAdmin({
    rpcResult: { data: false, error: null },
  });
  const ctx = { userId: "user-123", webhookBaseUrl: "https://api.postora.cloud" };
  const fakeApi = {} as any;
  const deps = buildReconnectDeps(admin, ctx, fakeApi);

  await assertRejects(
    () => deps.saveQr("acc-alien", "qr-code", "connecting"),
    Error,
    "instance not found for owner",
  );
  assertEquals(rpcCalls.length, 1);
});

Deno.test("buildReconnectDeps: saveQr throws when save_owned_evolution_qr returns an rpc error", async () => {
  const dbError = new Error("save_owned_evolution_qr rpc failure");
  const { admin } = createMockAdmin({
    rpcResult: { data: null, error: dbError },
  });
  const ctx = { userId: "user-123", webhookBaseUrl: "https://api.postora.cloud" };
  const fakeApi = {} as any;
  const deps = buildReconnectDeps(admin, ctx, fakeApi);

  await assertRejects(
    () => deps.saveQr("acc-1", "qr-code", "connecting"),
    Error,
    "save_owned_evolution_qr rpc failure",
  );
});

Deno.test("buildReconnectDeps: clearMismatch uses clear_whatsapp_number_mismatch with p_user_id ctx.userId", async () => {
  const { admin, rpcCalls, fromCalls } = createMockAdmin();
  const ctx = { userId: "user-123", webhookBaseUrl: "https://api.postora.cloud" };
  const fakeApi = {} as any;
  const deps = buildReconnectDeps(admin, ctx, fakeApi);

  await deps.clearMismatch("acc-1");

  const clearCalls = rpcCalls.filter((r) => r.name === "clear_whatsapp_number_mismatch");
  assertEquals(clearCalls.length, 1);
  assertEquals(clearCalls[0].args, {
    p_account_id: "acc-1",
    p_user_id: "user-123",
    p_workspace_id: null,
  });
  const socialFromCalls = fromCalls.filter((c) => c.table === "social_accounts");
  assertEquals(socialFromCalls.length, 0, "Must not query or update social_accounts directly");
});

Deno.test("buildReconnectDeps: logRefusal inserts the system_logs row", async () => {
  let insertedRow: Record<string, unknown> | null = null;
  const { admin, fromCalls } = createMockAdmin({
    fromHandler: (table: string) => {
      if (table === "system_logs") {
        return {
          insert: (row: Record<string, unknown>) => {
            insertedRow = row;
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  });
  const ctx = { userId: "user-123", webhookBaseUrl: "https://api.postora.cloud" };
  const fakeApi = {} as any;
  const deps = buildReconnectDeps(admin, ctx, fakeApi);

  await deps.logRefusal({
    userId: "user-123",
    accountId: "acc-1",
    reason: "not_reconnectable",
  });

  assertEquals(fromCalls.filter((c) => c.table === "system_logs").length, 1);
  assertEquals(insertedRow, {
    level: "info",
    category: "system",
    source: "whatsapp-evolution-bridge",
    message: "WhatsApp reconnect refused",
    user_id: "user-123",
    metadata: { account_id: "acc-1", reason: "not_reconnectable" },
  });
});
