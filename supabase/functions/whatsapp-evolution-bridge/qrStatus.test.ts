import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

type GetQrStatusResultFn = (deps: any, input: any) => Promise<any>;

async function loadGetQrStatusResult(): Promise<GetQrStatusResultFn> {
  const mod = await import("./qrStatus.ts");
  return mod.getQrStatusResult;
}

interface RecordedCall {
  target: string;
  args: unknown[];
}

function createDeps(overrides: {
  connectionState?: () => Promise<unknown>;
  reconcileResult?: { ownerNumber: string; mismatch: boolean };
  reconcileError?: unknown;
} = {}) {
  const calls: RecordedCall[] = [];

  const deps = {
    api: {
      connect: (...args: unknown[]) => {
        calls.push({ target: "api.connect", args });
        return Promise.resolve({ qrcode: { base64: "qr-data" } });
      },
      connectionState: (...args: unknown[]) => {
        calls.push({ target: "api.connectionState", args });
        if (overrides.connectionState) return overrides.connectionState();
        return Promise.resolve({ instance: { state: "open" } });
      },
      fetchInstance: (...args: unknown[]) => {
        calls.push({ target: "api.fetchInstance", args });
        return Promise.resolve({ ownerJid: "96597950350@s.whatsapp.net" });
      },
      logout: (...args: unknown[]) => {
        calls.push({ target: "api.logout", args });
        return Promise.resolve({ status: "SUCCESS" });
      },
    },
    saveConnectionState: (...args: unknown[]) => {
      calls.push({ target: "saveConnectionState", args });
      return Promise.resolve();
    },
    reconcile: (...args: unknown[]) => {
      calls.push({ target: "reconcile", args });
      if (overrides.reconcileError) return Promise.reject(overrides.reconcileError);
      return Promise.resolve(overrides.reconcileResult ?? { ownerNumber: "96597950350", mismatch: false });
    },
    autoImport: (...args: unknown[]) => {
      calls.push({ target: "autoImport", args });
      return Promise.resolve();
    },
  };

  return { deps, calls };
}

Deno.test("getQrStatusResult: account_metadata.number_mismatch true returns mismatch payload and calls neither connectionState nor autoImport", async () => {
  const getQrStatusResult = await loadGetQrStatusResult();
  const { deps, calls } = createDeps();

  const account = {
    id: "acc-1",
    platform_user_id: "96597950350",
    account_metadata: { number_mismatch: true },
  };
  const instance = {
    instance_name: "postora_acc-1",
    last_qr: "existing-qr",
  };

  const result = await getQrStatusResult(deps, { account, instance, refreshQr: false });

  assertEquals(result, {
    success: true,
    social_account_id: "acc-1",
    qr: null,
    state: "number_mismatch",
    expected_last4: "0350",
  });

  const connectionStateCalls = calls.filter((c) => c.target === "api.connectionState");
  assertEquals(connectionStateCalls.length, 0);

  const autoImportCalls = calls.filter((c) => c.target === "autoImport");
  assertEquals(autoImportCalls.length, 0);
});

Deno.test("getQrStatusResult: reconcile returns mismatch:true returns mismatch payload and does not call autoImport", async () => {
  const getQrStatusResult = await loadGetQrStatusResult();
  const { deps, calls } = createDeps({
    reconcileResult: { ownerNumber: "96597950350", mismatch: true },
  });

  const account = {
    id: "acc-1",
    platform_user_id: "96597950350",
    account_metadata: {},
  };
  const instance = {
    instance_name: "postora_acc-1",
    last_qr: "existing-qr",
  };

  const result = await getQrStatusResult(deps, { account, instance, refreshQr: false });

  assertEquals(result, {
    success: true,
    social_account_id: "acc-1",
    qr: null,
    state: "number_mismatch",
    expected_last4: "0350",
  });

  const autoImportCalls = calls.filter((c) => c.target === "autoImport");
  assertEquals(autoImportCalls.length, 0);
});

Deno.test("getQrStatusResult: open + no mismatch calls autoImport once with ownerNumber", async () => {
  const getQrStatusResult = await loadGetQrStatusResult();
  const { deps, calls } = createDeps({
    reconcileResult: { ownerNumber: "96597950350", mismatch: false },
  });

  const account = {
    id: "acc-1",
    platform_user_id: "pending_acc-1",
    account_metadata: {},
  };
  const instance = {
    instance_name: "postora_acc-1",
    last_qr: "existing-qr",
  };

  const result = await getQrStatusResult(deps, { account, instance, refreshQr: false });

  assertEquals(result.success, true);
  assertEquals(result.state, "open");

  const autoImportCalls = calls.filter((c) => c.target === "autoImport");
  assertEquals(autoImportCalls.length, 1);
  assertEquals(autoImportCalls[0].args[0], {
    ...account,
    platform_user_id: "96597950350",
  });
  assertEquals(autoImportCalls[0].args[1], instance);
});

Deno.test("getQrStatusResult: when provider reports close for ACTIVE account, reconcile runs BEFORE saveConnectionState", async () => {
  const getQrStatusResult = await loadGetQrStatusResult();
  const { deps, calls } = createDeps({
    connectionState: () => Promise.resolve({ instance: { state: "close" } }),
    reconcileResult: { ownerNumber: "96597950350", mismatch: false },
  });

  const account = {
    id: "acc-active-1",
    platform_user_id: "96597950350",
    is_active: true,
    account_metadata: {},
  };
  const instance = {
    instance_name: "postora_acc-1",
    last_qr: "existing-qr",
  };

  const result = await getQrStatusResult(deps, { account, instance, refreshQr: false });
  assertEquals(result.state, "close");

  const callTargets = calls.map((c) => c.target);
  const reconcileIdx = callTargets.indexOf("reconcile");
  const saveIdx = callTargets.indexOf("saveConnectionState");

  assert(reconcileIdx !== -1, "Expected reconcile to be called");
  assert(saveIdx !== -1, "Expected saveConnectionState to be called");
  assert(reconcileIdx < saveIdx, "Expected reconcile to run BEFORE saveConnectionState");
});

Deno.test("getQrStatusResult: when provider reports close for ACTIVE account and reconcile throws, saveConnectionState is NOT called", async () => {
  const getQrStatusResult = await loadGetQrStatusResult();
  const { deps, calls } = createDeps({
    connectionState: () => Promise.resolve({ instance: { state: "close" } }),
    reconcileError: new Error("reconcile deactivation failed"),
  });

  const account = {
    id: "acc-active-1",
    platform_user_id: "96597950350",
    is_active: true,
    account_metadata: {},
  };
  const instance = {
    instance_name: "postora_acc-1",
    last_qr: "existing-qr",
  };

  await assertRejects(
    () => getQrStatusResult(deps, { account, instance, refreshQr: false }),
    Error,
    "reconcile deactivation failed",
  );

  const saveCalls = calls.filter((c) => c.target === "saveConnectionState");
  assertEquals(saveCalls.length, 0, "saveConnectionState must NOT be called if reconcile throws");
});

type BuildQrStatusDepsFn = (
  admin: any,
  ctx: { userId: string },
  api?: any,
) => any;

async function loadBuildQrStatusDeps(): Promise<BuildQrStatusDepsFn> {
  const mod = await import("./qrStatus.ts");
  const fn = (mod as any).buildQrStatusDeps;
  assert(typeof fn === "function", "buildQrStatusDeps must be exported from ./qrStatus.ts");
  return fn;
}

interface RecordedRpc {
  name: string;
  args: Record<string, unknown>;
}

interface RecordedFrom {
  table: string;
}

function createMockAdminForDeps(options: {
  rpcResult?: { data: unknown; error: unknown };
} = {}) {
  const rpcCalls: RecordedRpc[] = [];
  const fromCalls: RecordedFrom[] = [];

  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve(options.rpcResult ?? { data: true, error: null });
    },
    from(table: string) {
      fromCalls.push({ table });
      return {
        update() {
          return {
            eq() {
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  return { admin, rpcCalls, fromCalls };
}

Deno.test("buildQrStatusDeps: saveConnectionState makes exactly one admin.rpc('save_owned_evolution_state') with user scope and no .from('whatsapp_evolution_instances')", async () => {
  const buildQrStatusDeps = await loadBuildQrStatusDeps();
  const { admin, rpcCalls, fromCalls } = createMockAdminForDeps({
    rpcResult: { data: true, error: null },
  });
  const ctx = { userId: "user-123" };
  const fakeApi = {} as any;
  const deps = buildQrStatusDeps(admin, ctx, fakeApi);

  await deps.saveConnectionState("acc-1", "open");

  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0], {
    name: "save_owned_evolution_state",
    args: {
      p_account_id: "acc-1",
      p_user_id: "user-123",
      p_state: "open",
    },
  });
  const instanceFromCalls = fromCalls.filter((c) => c.table === "whatsapp_evolution_instances");
  assertEquals(instanceFromCalls.length, 0, "Must not update whatsapp_evolution_instances directly");
});

Deno.test("buildQrStatusDeps: saveConnectionState throws when save_owned_evolution_state returns an rpc error", async () => {
  const buildQrStatusDeps = await loadBuildQrStatusDeps();
  const dbError = new Error("rpc statement timeout");
  const { admin } = createMockAdminForDeps({
    rpcResult: { data: null, error: dbError },
  });
  const ctx = { userId: "user-123" };
  const fakeApi = {} as any;
  const deps = buildQrStatusDeps(admin, ctx, fakeApi);

  await assertRejects(
    () => deps.saveConnectionState("acc-1", "open"),
    Error,
    "rpc statement timeout",
  );
});

Deno.test("buildQrStatusDeps: saveConnectionState throws when save_owned_evolution_state returns false", async () => {
  const buildQrStatusDeps = await loadBuildQrStatusDeps();
  const { admin, rpcCalls } = createMockAdminForDeps({
    rpcResult: { data: false, error: null },
  });
  const ctx = { userId: "user-123" };
  const fakeApi = {} as any;
  const deps = buildQrStatusDeps(admin, ctx, fakeApi);

  await assertRejects(
    () => deps.saveConnectionState("acc-alien", "open"),
    Error,
  );
  assertEquals(rpcCalls.length, 1);
});

Deno.test("buildQrStatusDeps: saveQr makes exactly one admin.rpc('save_owned_evolution_qr') with user scope and no .from('whatsapp_evolution_instances')", async () => {
  const buildQrStatusDeps = await loadBuildQrStatusDeps();
  const { admin, rpcCalls, fromCalls } = createMockAdminForDeps({
    rpcResult: { data: true, error: null },
  });
  const ctx = { userId: "user-123" };
  const fakeApi = {} as any;
  const deps = buildQrStatusDeps(admin, ctx, fakeApi);

  await deps.saveQr("acc-1", "qr-data");

  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0], {
    name: "save_owned_evolution_qr",
    args: {
      p_account_id: "acc-1",
      p_user_id: "user-123",
      p_qr: "qr-data",
      p_state: null,
    },
  });
  const instanceFromCalls = fromCalls.filter((c) => c.table === "whatsapp_evolution_instances");
  assertEquals(instanceFromCalls.length, 0, "Must not update whatsapp_evolution_instances directly");
});

Deno.test("buildQrStatusDeps: saveQr throws when save_owned_evolution_qr returns an rpc error", async () => {
  const buildQrStatusDeps = await loadBuildQrStatusDeps();
  const dbError = new Error("rpc statement timeout");
  const { admin } = createMockAdminForDeps({
    rpcResult: { data: null, error: dbError },
  });
  const ctx = { userId: "user-123" };
  const fakeApi = {} as any;
  const deps = buildQrStatusDeps(admin, ctx, fakeApi);

  await assertRejects(
    () => deps.saveQr("acc-1", "qr-data"),
    Error,
    "rpc statement timeout",
  );
});

Deno.test("buildQrStatusDeps: saveQr throws when save_owned_evolution_qr returns false", async () => {
  const buildQrStatusDeps = await loadBuildQrStatusDeps();
  const { admin, rpcCalls } = createMockAdminForDeps({
    rpcResult: { data: false, error: null },
  });
  const ctx = { userId: "user-123" };
  const fakeApi = {} as any;
  const deps = buildQrStatusDeps(admin, ctx, fakeApi);

  await assertRejects(
    () => deps.saveQr("acc-alien", "qr-data"),
    Error,
  );
  assertEquals(rpcCalls.length, 1);
});
