import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
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
  } = {},
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const account = overrides.account === undefined
    ? { id: "acc-1", platform_user_id: "96597950350", connection_mode: "evolution_qr", is_active: false }
    : overrides.account;
  const instance = overrides.instance === undefined
    ? { instance_name: "postora_acc-1", jwt_key: "jwt-stored-key" }
    : overrides.instance;

  const deps: ReconnectDeps = {
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
  };

  return { deps, calls };
}

Deno.test("reconnectQr: account not found throws ReconnectError 404", async () => {
  const { deps } = createDeps({ account: null });
  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-missing"),
    ReconnectError,
  )) as ReconnectError;
  assertEquals(error.status, 404);
});

Deno.test("reconnectQr: pending_ account throws ReconnectError 409", async () => {
  const { deps } = createDeps({
    account: { id: "acc-1", platform_user_id: "pending_acc-1", connection_mode: "evolution_qr", is_active: false },
  });
  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-1"),
    ReconnectError,
  )) as ReconnectError;
  assertEquals(error.status, 409);
});

Deno.test("reconnectQr: retired_ account throws ReconnectError 409", async () => {
  const { deps } = createDeps({
    account: { id: "acc-1", platform_user_id: "retired_96597950350", connection_mode: "evolution_qr", is_active: false },
  });
  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-1"),
    ReconnectError,
  )) as ReconnectError;
  assertEquals(error.status, 409);
});

Deno.test("reconnectQr: non evolution_qr connection mode throws ReconnectError 409", async () => {
  const { deps } = createDeps({
    account: { id: "acc-1", platform_user_id: "96597950350", connection_mode: "cloud_api", is_active: false },
  });
  const error = (await assertRejects(
    () => reconnectQr(deps, "user-1", "acc-1"),
    ReconnectError,
  )) as ReconnectError;
  assertEquals(error.status, 409);
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
