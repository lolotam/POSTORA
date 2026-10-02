import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { EvolutionApiError, type EvolutionEvent } from "../_shared/evolutionApi.ts";
import { reconnectQr, ReconnectError, type ReconnectDeps } from "./reconnect.ts";

function createDeps(
  overrides: {
    account?: { id: string; platform_user_id: string; connection_mode: string | null; is_active?: boolean } | null;
    instance?: { instance_name: string; jwt_key: string } | null;
    fetchInstance?: () => Promise<unknown>;
    connectionState?: () => Promise<unknown>;
    connect?: () => Promise<unknown>;
    logoutError?: unknown;
    setWebhookError?: unknown;
    createInstanceError?: unknown;
    clearMismatchError?: unknown;
    logRefusalError?: unknown;
  } = {},
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const account = overrides.account === undefined
    ? { id: "acc-1", platform_user_id: "96597950350", connection_mode: "evolution_qr", is_active: false }
    : overrides.account;
  const instance = overrides.instance === undefined
    ? { instance_name: "postora_acc-1", jwt_key: "jwt-stored-key" }
    : overrides.instance;

  const deps: ReconnectDeps & {
    logRefusal?: (refusal: { userId: string; accountId: string; reason: "already_connected" | "not_reconnectable" | "not_found" }) => Promise<void> | void;
  } = {
    findAccount: (userId: string, id: string) => {
      calls.push({ method: "findAccount", args: [userId, id] });
      return Promise.resolve(account);
    },
    findInstance: (id: string) => {
      calls.push({ method: "findInstance", args: [id] });
      return Promise.resolve(instance);
    },
    api: {
      fetchInstance: (instanceName: string) => {
        calls.push({ method: "fetchInstance", args: [instanceName] });
        if (overrides.fetchInstance) return overrides.fetchInstance() as any;
        return Promise.resolve({ instance: { instanceName } });
      },
      connectionState: (instanceName: string) => {
        calls.push({ method: "connectionState", args: [instanceName] });
        if (overrides.connectionState) return overrides.connectionState() as any;
        return Promise.resolve({ instance: { state: "close" } });
      },
      createInstance: (payload: unknown) => {
        calls.push({ method: "createInstance", args: [payload] });
        if (overrides.createInstanceError) return Promise.reject(overrides.createInstanceError);
        return Promise.resolve({ instance: payload });
      },
      connect: (instanceName: string) => {
        calls.push({ method: "connect", args: [instanceName] });
        if (overrides.connect) return overrides.connect() as any;
        return Promise.resolve({
          qrcode: { base64: "reconnect-qr-base64" },
          instance: { state: "connecting" },
        });
      },
      logout: (instanceName: string) => {
        calls.push({ method: "logout", args: [instanceName] });
        if (overrides.logoutError) return Promise.reject(overrides.logoutError);
        return Promise.resolve({ status: "SUCCESS" });
      },
      setWebhook: (instanceName: string, webhook: unknown) => {
        calls.push({ method: "setWebhook", args: [instanceName, webhook] });
        if (overrides.setWebhookError) return Promise.reject(overrides.setWebhookError);
        return Promise.resolve({ status: "SUCCESS" });
      },
    },
    webhook: {
      url: "https://api.postora.cloud/functions/v1/whatsapp-evolution-webhook",
      events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"] as EvolutionEvent[],
    },
    saveQr: (id: string, qr: string | null, state: string | null) => {
      calls.push({ method: "saveQr", args: [id, qr, state] });
      return Promise.resolve();
    },
    clearMismatch: (id: string) => {
      calls.push({ method: "clearMismatch", args: [id] });
      if (overrides.clearMismatchError) return Promise.reject(overrides.clearMismatchError);
      return Promise.resolve();
    },
    logRefusal: (refusal: { userId: string; accountId: string; reason: "already_connected" | "not_reconnectable" | "not_found" }) => {
      calls.push({ method: "logRefusal", args: [refusal] });
      if (overrides.logRefusalError) throw overrides.logRefusalError;
      return Promise.resolve();
    },
  };

  return { deps, calls };
}

Deno.test("reconnectQr: account not found throws ReconnectError 404", async () => {
  const { deps, calls } = createDeps({ account: null });
  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-missing"),
    ReconnectError,
  )) as ReconnectError;
  assertEquals(error.status, 404);
  const refusalCalls = calls.filter((c) => c.method === "logRefusal");
  assertEquals(refusalCalls.length, 1);
  assertEquals(refusalCalls[0].args, [{ userId: "user-1", accountId: "acc-missing", reason: "not_found" }]);
});

Deno.test("reconnectQr: pending_ account throws ReconnectError 409", async () => {
  const { deps, calls } = createDeps({
    account: { id: "acc-1", platform_user_id: "pending_acc-1", connection_mode: "evolution_qr", is_active: false },
  });
  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-1"),
    ReconnectError,
  )) as ReconnectError;
  assertEquals(error.status, 409);
  const refusalCalls = calls.filter((c) => c.method === "logRefusal");
  assertEquals(refusalCalls.length, 1);
  assertEquals(refusalCalls[0].args, [{ userId: "user-1", accountId: "acc-1", reason: "not_reconnectable" }]);
});

Deno.test("reconnectQr: retired_ account throws ReconnectError 409", async () => {
  const { deps, calls } = createDeps({
    account: { id: "acc-1", platform_user_id: "retired_96597950350", connection_mode: "evolution_qr", is_active: false },
  });
  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-1"),
    ReconnectError,
  )) as ReconnectError;
  assertEquals(error.status, 409);
  const refusalCalls = calls.filter((c) => c.method === "logRefusal");
  assertEquals(refusalCalls.length, 1);
  assertEquals(refusalCalls[0].args, [{ userId: "user-1", accountId: "acc-1", reason: "not_reconnectable" }]);
});

Deno.test("reconnectQr: non evolution_qr connection mode throws ReconnectError 409", async () => {
  const { deps, calls } = createDeps({
    account: { id: "acc-1", platform_user_id: "96597950350", connection_mode: "cloud_api", is_active: false },
  });
  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-1"),
    ReconnectError,
  )) as ReconnectError;
  assertEquals(error.status, 409);
  const refusalCalls = calls.filter((c) => c.method === "logRefusal");
  assertEquals(refusalCalls.length, 1);
  assertEquals(refusalCalls[0].args, [{ userId: "user-1", accountId: "acc-1", reason: "not_reconnectable" }]);
});

Deno.test("reconnectQr: an active account throws ReconnectError 409 without calling Evolution", async () => {
  const { deps, calls } = createDeps({
    account: { id: "acc-1", platform_user_id: "96597950350", connection_mode: "evolution_qr", is_active: true },
  });
  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-1"),
    ReconnectError,
  )) as ReconnectError;
  assertEquals(error.status, 409);
  const evolutionCalls = calls.filter((c) =>
    ["fetchInstance", "connectionState", "createInstance", "connect", "logout", "setWebhook"].includes(c.method),
  );
  assertEquals(evolutionCalls.length, 0);
  const refusalCalls = calls.filter((c) => c.method === "logRefusal");
  assertEquals(refusalCalls.length, 1);
  assertEquals(refusalCalls[0].args, [{ userId: "user-1", accountId: "acc-1", reason: "already_connected" }]);
});

Deno.test("reconnectQr: logRefusal throwing must not change the ReconnectError thrown", async () => {
  for (const tc of [
    {
      account: null,
      id: "acc-missing",
      expectedStatus: 404,
      expectedReason: "not_found",
    },
    {
      account: { id: "acc-1", platform_user_id: "96597950350", connection_mode: "evolution_qr", is_active: true },
      id: "acc-1",
      expectedStatus: 409,
      expectedReason: "already_connected",
    },
    {
      account: { id: "acc-1", platform_user_id: "pending_acc-1", connection_mode: "evolution_qr", is_active: false },
      id: "acc-1",
      expectedStatus: 409,
      expectedReason: "not_reconnectable",
    },
  ] as const) {
    const { deps, calls } = createDeps({
      account: tc.account,
      logRefusalError: new Error("log failure from logging system"),
    });
    const error = (await assertRejects(
      () => reconnectQr(deps, "user-1", tc.id),
      ReconnectError,
    )) as ReconnectError;
    assertEquals(error.status, tc.expectedStatus);
    const refusalCalls = calls.filter((c) => c.method === "logRefusal");
    assertEquals(refusalCalls.length, 1);
    assertEquals(refusalCalls[0].args, [{ userId: "user-1", accountId: tc.id, reason: tc.expectedReason }]);
  }
});

Deno.test("reconnectQr: instance row missing throws ReconnectError 409 reconnect_unavailable", async () => {
  const { deps } = createDeps({ instance: null });
  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-1"),
    ReconnectError,
    "reconnect_unavailable",
  )) as ReconnectError;
  assertEquals(error.status, 409);
});

Deno.test("reconnectQr: remote instance missing shape 1 (fetchInstance resolves null) creates instance, connects, sets webhook, clears mismatch, and saves QR", async () => {
  const { deps, calls } = createDeps({
    fetchInstance: () => Promise.resolve(null),
  });

  const result = await reconnectQr(deps, "user-1", "acc-1");

  assertEquals(result, {
    success: true,
    social_account_id: "acc-1",
    qr: "reconnect-qr-base64",
    state: "connecting",
  });

  const findAccountCalls = calls.filter((c) => c.method === "findAccount");
  assertEquals(findAccountCalls.length, 1);
  assertEquals(findAccountCalls[0].args, ["user-1", "acc-1"]);

  const createCalls = calls.filter((c) => c.method === "createInstance");
  assertEquals(createCalls.length, 1);
  assertEquals(createCalls[0].args[0], {
    instanceName: "postora_acc-1",
    webhook: {
      url: deps.webhook.url,
      headers: { jwt_key: "jwt-stored-key" },
      events: deps.webhook.events,
    },
  });

  const webhookCalls = calls.filter((c) => c.method === "setWebhook");
  assertEquals(webhookCalls.length, 1);
  assertEquals(webhookCalls[0].args, [
    "postora_acc-1",
    {
      url: deps.webhook.url,
      headers: { jwt_key: "jwt-stored-key" },
      events: deps.webhook.events,
    },
  ]);

  const connectCalls = calls.filter((c) => c.method === "connect");
  assertEquals(connectCalls.length, 1);
  assertEquals(connectCalls[0].args, ["postora_acc-1"]);

  const clearCalls = calls.filter((c) => c.method === "clearMismatch");
  assertEquals(clearCalls.length, 1);
  assertEquals(clearCalls[0].args, ["acc-1"]);

  const saveCalls = calls.filter((c) => c.method === "saveQr");
  assertEquals(saveCalls.length, 1);
  assertEquals(saveCalls[0].args, ["acc-1", "reconnect-qr-base64", "connecting"]);

  const callOrder = calls.map((c) => c.method);
  const clearIndex = callOrder.indexOf("clearMismatch");
  const saveIndex = callOrder.indexOf("saveQr");
  assertEquals(clearIndex !== -1, true);
  assertEquals(saveIndex !== -1, true);
  assertEquals(clearIndex <= saveIndex, true);
});

Deno.test("reconnectQr: remote instance missing shape 2 (fetchInstance throws 404) creates instance, connects, and saves QR", async () => {
  const { deps, calls } = createDeps({
    fetchInstance: () => Promise.reject(new EvolutionApiError("Not found", 404, null)),
  });

  const result = await reconnectQr(deps, "user-1", "acc-1");

  assertEquals(result.success, true);
  assertEquals(result.social_account_id, "acc-1");

  const createCalls = calls.filter((c) => c.method === "createInstance");
  assertEquals(createCalls.length, 1);
  assertEquals(createCalls[0].args[0], {
    instanceName: "postora_acc-1",
    webhook: {
      url: deps.webhook.url,
      headers: { jwt_key: "jwt-stored-key" },
      events: deps.webhook.events,
    },
  });

  const saveCalls = calls.filter((c) => c.method === "saveQr");
  assertEquals(saveCalls.length, 1);
});

Deno.test("reconnectQr: fetchInstance throws EvolutionApiError 500 rejects with ReconnectError 502 without creating instance", async () => {
  const { deps, calls } = createDeps({
    fetchInstance: () => Promise.reject(new EvolutionApiError("Server error", 500, null)),
  });

  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-1"),
    ReconnectError,
  )) as ReconnectError;
  assertEquals(error.status, 502);

  const createCalls = calls.filter((c) => c.method === "createInstance");
  assertEquals(createCalls.length, 0);

  const saveCalls = calls.filter((c) => c.method === "saveQr");
  assertEquals(saveCalls.length, 0);
});

Deno.test("reconnectQr: remote present and connectionState is open calls logout then connect in order", async () => {
  const { deps, calls } = createDeps({
    connectionState: () => Promise.resolve({ instance: { state: "open" } }),
  });

  const result = await reconnectQr(deps, "user-1", "acc-1");
  assertEquals(result.success, true);

  const callOrder = calls.map((c) => c.method);
  const logoutIndex = callOrder.indexOf("logout");
  const connectIndex = callOrder.indexOf("connect");
  assertEquals(logoutIndex !== -1, true);
  assertEquals(connectIndex !== -1, true);
  assertEquals(logoutIndex < connectIndex, true);

  const createCalls = calls.filter((c) => c.method === "createInstance");
  assertEquals(createCalls.length, 0);
});

Deno.test("reconnectQr: remote present and connectionState is close calls connect without logout", async () => {
  const { deps, calls } = createDeps({
    connectionState: () => Promise.resolve({ instance: { state: "close" } }),
  });

  const result = await reconnectQr(deps, "user-1", "acc-1");
  assertEquals(result.success, true);

  const logoutCalls = calls.filter((c) => c.method === "logout");
  assertEquals(logoutCalls.length, 0);

  const connectCalls = calls.filter((c) => c.method === "connect");
  assertEquals(connectCalls.length, 1);
});

const failingSteps = [
  {
    step: "createInstance",
    overrides: {
      fetchInstance: () => Promise.resolve(null),
      createInstanceError: new EvolutionApiError("create fail", 500, null),
    },
  },
  {
    step: "setWebhook",
    overrides: {
      setWebhookError: new EvolutionApiError("webhook fail", 500, null),
    },
  },
  {
    step: "connect",
    overrides: {
      connect: () => Promise.reject(new EvolutionApiError("connect fail", 500, null)),
    },
  },
  {
    step: "clearMismatch",
    overrides: {
      clearMismatchError: new Error("clearMismatch fail"),
    },
  },
  {
    step: "logout when state is open",
    overrides: {
      connectionState: () => Promise.resolve({ instance: { state: "open" } }),
      logoutError: new EvolutionApiError("logout fail", 500, null),
    },
  },
];

for (const { step, overrides } of failingSteps) {
  Deno.test(`reconnectQr: failing step ${step} throws ReconnectError 502 and never calls saveQr`, async () => {
    const { deps, calls } = createDeps(overrides);
    const error = (await assertRejects(
      () => reconnectQr(deps, "user-1", "acc-1"),
      ReconnectError,
      "reconnect_failed",
    )) as ReconnectError;
    assertEquals(error.status, 502);
    const saveCalls = calls.filter((c) => c.method === "saveQr");
    assertEquals(saveCalls.length, 0);
  });
}

type ClearMismatchForFn = (admin: any, userId: string, accountId: string) => Promise<void>;

async function loadClearMismatchFor(): Promise<ClearMismatchForFn> {
  try {
    const mod = await import("./clearMismatch.ts");
    if (typeof mod.clearMismatchFor === "function") return mod.clearMismatchFor;
  } catch {
    // try reconnect.ts fallback
  }
  try {
    const mod2 = await import("./reconnect.ts");
    if (typeof (mod2 as any).clearMismatchFor === "function") return (mod2 as any).clearMismatchFor;
  } catch {
    //
  }
  throw new Error("clearMismatchFor not exported from clearMismatch.ts or reconnect.ts");
}

interface RecordedRpcCall {
  name: string;
  args: Record<string, unknown>;
}

function createClearMismatchAdmin(options: {
  rpcError?: unknown;
} = {}) {
  const rpcCalls: RecordedRpcCall[] = [];
  const fromCalls: Array<{ table: string; method: string }> = [];

  const admin = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({
        data: options.rpcError ? null : true,
        error: options.rpcError ?? null,
      });
    },
    from: (table: string) => {
      const builder: any = {
        select: (_cols?: string) => {
          fromCalls.push({ table, method: "select" });
          return builder;
        },
        update: (_payload: Record<string, unknown>) => {
          fromCalls.push({ table, method: "update" });
          return builder;
        },
        eq: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (onfulfilled?: (res: any) => any) => Promise.resolve({ error: null }).then(onfulfilled),
      };
      return builder;
    },
  };

  return { admin, rpcCalls, fromCalls };
}

Deno.test("clearMismatchFor: makes exactly one clear_whatsapp_number_mismatch rpc with user scope and no direct social_accounts access", async () => {
  const clearMismatchFor = await loadClearMismatchFor();
  const { admin, rpcCalls, fromCalls } = createClearMismatchAdmin();

  await clearMismatchFor(admin, "user-caller", "acc-target");

  assertEquals(rpcCalls.length, 1, "Expected exactly one rpc call");
  assertEquals(rpcCalls[0], {
    name: "clear_whatsapp_number_mismatch",
    args: {
      p_account_id: "acc-target",
      p_user_id: "user-caller",
      p_workspace_id: null,
    },
  });
  assertEquals(fromCalls.length, 0, "Must not select or update social_accounts directly");
});

Deno.test("clearMismatchFor: an error on clear_whatsapp_number_mismatch rpc throws", async () => {
  const clearMismatchFor = await loadClearMismatchFor();
  const rpcError = new Error("clear_whatsapp_number_mismatch rpc failure");
  const { admin } = createClearMismatchAdmin({ rpcError });

  await assertRejects(
    () => clearMismatchFor(admin, "user-1", "acc-1"),
    Error,
    "clear_whatsapp_number_mismatch rpc failure",
  );
});
