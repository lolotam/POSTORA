import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mismatchStatus, reconcileAccountConnection } from "./reconcile.ts";
import type { EvolutionApi } from "../_shared/evolutionApi.ts";

interface RecordedUpdate {
  table: string;
  values: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function fakeAdmin(options: {
  instanceUpdateError?: unknown;
  accountMetadata?: Record<string, unknown> | null;
} = {}) {
  const updates: RecordedUpdate[] = [];
  const admin = {
    updates,
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          const filters: Record<string, unknown> = {};
          return {
            eq(column: string, value: unknown) {
              filters[column] = value;
              updates.push({ table, values, filters });
              if (table === "whatsapp_evolution_instances" && options.instanceUpdateError) {
                return Promise.resolve({ error: options.instanceUpdateError });
              }
              return Promise.resolve({ error: null });
            },
          };
        },
        select() {
          return {
            eq() {
              return {
                maybeSingle() {
                  return Promise.resolve({
                    data: {
                      account_metadata: options.accountMetadata ?? null,
                      is_active: false,
                      workspace_id: "ws-1",
                      updated_at: new Date().toISOString(),
                    },
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
  };
  return admin;
}

function fakeApi(options: {
  fetchInstanceResult?: unknown;
  logoutError?: unknown;
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const api = {
    calls,
    fetchInstance(...args: unknown[]) {
      calls.push({ method: "fetchInstance", args });
      return Promise.resolve(options.fetchInstanceResult ?? { ownerJid: "96597950350@s.whatsapp.net" });
    },
    logout(...args: unknown[]) {
      calls.push({ method: "logout", args });
      if (options.logoutError) return Promise.reject(options.logoutError);
      return Promise.resolve({ status: "SUCCESS" });
    },
  };
  return api;
}

Deno.test("reconcileAccountConnection: on NumberMismatchError calls api.logout once, updates last_connection_state = number_mismatch, and returns mismatch:true", async () => {
  const admin = fakeAdmin();
  const api = fakeApi({
    fetchInstanceResult: { ownerJid: "99999999@s.whatsapp.net" },
  });

  const account = {
    id: "acc-established",
    platform_user_id: "96597950350",
    is_active: false,
    account_metadata: {},
  };

  const result = await reconcileAccountConnection({
    admin,
    api: api as unknown as EvolutionApi,
    account,
    instanceName: "postora_acc-established",
    state: "open",
  });

  assertEquals(result, {
    ownerNumber: "96597950350",
    mismatch: true,
  });

  const logoutCalls = api.calls.filter((c) => c.method === "logout");
  assertEquals(logoutCalls.length, 1);
  assertEquals(logoutCalls[0].args, ["postora_acc-established"]);

  const instanceUpdates = admin.updates.filter((u) => u.table === "whatsapp_evolution_instances");
  assertEquals(instanceUpdates.length, 1);
  assertEquals(instanceUpdates[0].values, { last_connection_state: "number_mismatch" });
  assertEquals(instanceUpdates[0].filters, { social_account_id: "acc-established" });
});

Deno.test("reconcileAccountConnection: swallows api.logout rejection on mismatch and still persists state", async () => {
  const admin = fakeAdmin();
  const api = fakeApi({
    fetchInstanceResult: { ownerJid: "99999999@s.whatsapp.net" },
    logoutError: new Error("network down"),
  });

  const account = {
    id: "acc-established",
    platform_user_id: "96597950350",
    is_active: false,
    account_metadata: {},
  };

  const result = await reconcileAccountConnection({
    admin,
    api: api as unknown as EvolutionApi,
    account,
    instanceName: "postora_acc-established",
    state: "open",
  });

  assertEquals(result, {
    ownerNumber: "96597950350",
    mismatch: true,
  });
  const instanceUpdates = admin.updates.filter((u) => u.table === "whatsapp_evolution_instances");
  assertEquals(instanceUpdates.length, 1);
  assertEquals(instanceUpdates[0].values, { last_connection_state: "number_mismatch" });
});

Deno.test("reconcileAccountConnection: throws if updating whatsapp_evolution_instances fails on mismatch", async () => {
  const dbError = new Error("db failure");
  const admin = fakeAdmin({ instanceUpdateError: dbError });
  const api = fakeApi({
    fetchInstanceResult: { ownerJid: "99999999@s.whatsapp.net" },
  });

  const account = {
    id: "acc-established",
    platform_user_id: "96597950350",
    is_active: false,
    account_metadata: {},
  };

  await assertRejects(
    () => reconcileAccountConnection({
      admin,
      api: api as unknown as EvolutionApi,
      account,
      instanceName: "postora_acc-established",
      state: "open",
    }),
    Error,
    "db failure",
  );
});

Deno.test("reconcileAccountConnection: open on an active established row returns mismatch:false without calling sync or fetchInstance", async () => {
  const admin = fakeAdmin();
  const api = fakeApi();

  const account = {
    id: "acc-active",
    platform_user_id: "96597950350",
    is_active: true,
    account_metadata: {},
  };

  const result = await reconcileAccountConnection({
    admin,
    api: api as unknown as EvolutionApi,
    account,
    instanceName: "postora_acc-active",
    state: "open",
  });

  assertEquals(result, {
    ownerNumber: "96597950350",
    mismatch: false,
  });
  assertEquals(api.calls, []);
  assertEquals(admin.updates, []);
});

Deno.test("mismatchStatus: returns expected payload when account_metadata.number_mismatch === true", () => {
  const account = {
    id: "acc-1",
    platform_user_id: "96597950350",
    account_metadata: { number_mismatch: true },
  };

  const status = mismatchStatus(account);
  assertEquals(status, {
    success: true,
    social_account_id: "acc-1",
    qr: null,
    state: "number_mismatch",
    expected_last4: "0350",
  });
});

Deno.test("mismatchStatus: returns null when account_metadata.number_mismatch is absent, false, or metadata is null", () => {
  assertEquals(mismatchStatus({ id: "acc-1", platform_user_id: "96597950350", account_metadata: { number_mismatch: false } }), null);
  assertEquals(mismatchStatus({ id: "acc-1", platform_user_id: "96597950350", account_metadata: {} }), null);
  assertEquals(mismatchStatus({ id: "acc-1", platform_user_id: "96597950350", account_metadata: null }), null);
  assertEquals(mismatchStatus({ id: "acc-1", platform_user_id: "96597950350" }), null);
});
