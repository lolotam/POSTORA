import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { NumberMismatchError } from "../_shared/evolutionQrAccount.ts";

type HandleConnectionUpdateFn = (deps: any, input: any) => Promise<"number_mismatch" | void>;

async function loadHandleConnectionUpdate(): Promise<HandleConnectionUpdateFn> {
  const mod = await import("./connectionUpdate.ts");
  return mod.handleConnectionUpdate;
}

interface RecordedCall {
  target: string;
  args: unknown[];
}

function createDeps(overrides: {
  syncError?: unknown;
  ownerNumber?: string;
} = {}) {
  const calls: RecordedCall[] = [];

  const admin = {
    updates: [] as Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }>,
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        return {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            admin.updates.push({ table, values, filters });
            return Promise.resolve({ error: null });
          },
        };
      },
    }),
  };

  const deps = {
    admin,
    api: {
      logout: (...args: unknown[]) => {
        calls.push({ target: "api.logout", args });
        return Promise.resolve({ status: "SUCCESS" });
      },
    },
    handleNumberMismatch: (...args: unknown[]) => {
      calls.push({ target: "handleNumberMismatch", args });
      return Promise.resolve();
    },
    syncEvolutionAccountConnection: (...args: unknown[]) => {
      calls.push({ target: "syncEvolutionAccountConnection", args });
      if (overrides.syncError) return Promise.reject(overrides.syncError);
      return Promise.resolve(overrides.ownerNumber ?? "96597950350");
    },
    importEvolutionHistory: (...args: unknown[]) => {
      calls.push({ target: "importEvolutionHistory", args });
      return Promise.resolve();
    },
    runInBackground: async (name: string, fn: () => Promise<any>) => {
      calls.push({ target: "runInBackground", args: [name] });
      await fn();
    },
  };

  return { deps, calls, admin };
}

Deno.test("handleConnectionUpdate: on NumberMismatchError calls handleNumberMismatch, returns number_mismatch, and runs nothing after sync", async () => {
  const handleConnectionUpdate = await loadHandleConnectionUpdate();
  const { deps, calls, admin } = createDeps({
    syncError: new NumberMismatchError("acc-1"),
  });

  const account = { id: "acc-1", platform_user_id: "96597950350" };
  const instance = { instance_name: "postora_acc-1", last_sync_at: null };
  const data = { state: "open" };

  const result = await handleConnectionUpdate(deps, { account, instance, data });

  assertEquals(result, "number_mismatch");

  const mismatchCalls = calls.filter((c) => c.target === "handleNumberMismatch");
  assertEquals(mismatchCalls.length, 1);
  assertEquals(mismatchCalls[0].args, [
    deps.admin,
    deps.api,
    { accountId: "acc-1", instanceName: "postora_acc-1" },
  ]);

  const importCalls = calls.filter((c) => c.target === "importEvolutionHistory");
  assertEquals(importCalls.length, 0);

  const backgroundCalls = calls.filter((c) => c.target === "runInBackground");
  assertEquals(backgroundCalls.length, 0);
});

Deno.test("handleConnectionUpdate: unexpected sync error propagates and runs nothing after sync", async () => {
  const handleConnectionUpdate = await loadHandleConnectionUpdate();
  const syncError = new Error("unexpected error");
  const { deps, calls } = createDeps({ syncError });

  const account = { id: "acc-1", platform_user_id: "96597950350" };
  const instance = { instance_name: "postora_acc-1", last_sync_at: null };
  const data = { state: "open" };

  await assertRejects(
    () => handleConnectionUpdate(deps, { account, instance, data }),
    Error,
    "unexpected error",
  );

  const mismatchCalls = calls.filter((c) => c.target === "handleNumberMismatch");
  assertEquals(mismatchCalls.length, 0);

  const importCalls = calls.filter((c) => c.target === "importEvolutionHistory");
  assertEquals(importCalls.length, 0);
});

Deno.test("handleConnectionUpdate: open without mismatch runs history import", async () => {
  const handleConnectionUpdate = await loadHandleConnectionUpdate();
  const { deps, calls } = createDeps({
    ownerNumber: "96597950350",
  });

  const account = { id: "acc-1", platform_user_id: "pending_acc-1" };
  const instance = { instance_name: "postora_acc-1", last_sync_at: null };
  const data = { state: "open" };

  const result = await handleConnectionUpdate(deps, { account, instance, data });

  assertEquals(result, undefined);

  const mismatchCalls = calls.filter((c) => c.target === "handleNumberMismatch");
  assertEquals(mismatchCalls.length, 0);

  const importCalls = calls.filter((c) => c.target === "importEvolutionHistory");
  assertEquals(importCalls.length, 1);
});
