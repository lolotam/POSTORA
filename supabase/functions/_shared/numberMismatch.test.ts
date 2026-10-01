import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

type HandleNumberMismatchFn = (
  admin: any,
  api: any,
  input: { accountId: string; instanceName: string },
) => Promise<void>;

async function loadHandleNumberMismatch(): Promise<HandleNumberMismatchFn> {
  const mod = await import("./numberMismatch.ts");
  return mod.handleNumberMismatch;
}

interface RecordedUpdate {
  table: string;
  values: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function fakeAdmin(options: { updateError?: unknown } = {}) {
  const updates: RecordedUpdate[] = [];
  const admin = {
    updates,
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        return {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            updates.push({ table, values, filters });
            return Promise.resolve({ error: options.updateError ?? null });
          },
        };
      },
    }),
  };
  return admin;
}

function fakeApi(options: { logoutError?: unknown } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const api = {
    calls,
    logout: (...args: unknown[]) => {
      calls.push({ method: "logout", args });
      if (options.logoutError) return Promise.reject(options.logoutError);
      return Promise.resolve({ status: "SUCCESS" });
    },
  };
  return api;
}

Deno.test("handleNumberMismatch: calls api.logout once with instanceName", async () => {
  const handleNumberMismatch = await loadHandleNumberMismatch();
  const admin = fakeAdmin();
  const api = fakeApi();

  await handleNumberMismatch(admin, api, {
    accountId: "acc-1",
    instanceName: "postora_acc-1",
  });

  const logoutCalls = api.calls.filter((c) => c.method === "logout");
  assertEquals(logoutCalls.length, 1);
  assertEquals(logoutCalls[0].args, ["postora_acc-1"]);
});

Deno.test("handleNumberMismatch: persists state to whatsapp_evolution_instances", async () => {
  const handleNumberMismatch = await loadHandleNumberMismatch();
  const admin = fakeAdmin();
  const api = fakeApi();

  await handleNumberMismatch(admin, api, {
    accountId: "acc-1",
    instanceName: "postora_acc-1",
  });

  const updates = admin.updates.filter((u) => u.table === "whatsapp_evolution_instances");
  assertEquals(updates.length, 1);
  assertEquals(updates[0].values, { last_connection_state: "number_mismatch" });
  assertEquals(updates[0].filters, { social_account_id: "acc-1" });
});

Deno.test("handleNumberMismatch: logout failure still persists state", async () => {
  const handleNumberMismatch = await loadHandleNumberMismatch();
  const admin = fakeAdmin();
  const api = fakeApi({ logoutError: new Error("network failure") });

  await handleNumberMismatch(admin, api, {
    accountId: "acc-1",
    instanceName: "postora_acc-1",
  });

  const logoutCalls = api.calls.filter((c) => c.method === "logout");
  assertEquals(logoutCalls.length, 1);

  const updates = admin.updates.filter((u) => u.table === "whatsapp_evolution_instances");
  assertEquals(updates.length, 1);
  assertEquals(updates[0].values, { last_connection_state: "number_mismatch" });
  assertEquals(updates[0].filters, { social_account_id: "acc-1" });
});

Deno.test("handleNumberMismatch: update error throws", async () => {
  const handleNumberMismatch = await loadHandleNumberMismatch();
  const updateError = new Error("database error");
  const admin = fakeAdmin({ updateError });
  const api = fakeApi();

  await assertRejects(
    () =>
      handleNumberMismatch(admin, api, {
        accountId: "acc-1",
        instanceName: "postora_acc-1",
      }),
    Error,
    "database error",
  );
});
