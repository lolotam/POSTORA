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
