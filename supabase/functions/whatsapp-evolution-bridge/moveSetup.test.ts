import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dismissSetupMove,
  moveSetup,
  MoveSetupError,
  type MoveSetupDeps,
} from "./moveSetup.ts";

function createDeps(
  overrides: {
    // Keyed by `${userId}:${id}`: an account owned by another user returns null
    ownedAccounts?: Record<string, { id: string } | null>;
    rpcHandler?: (
      name: "move_whatsapp_account_setup" | "dismiss_whatsapp_setup_move",
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  } = {},
) {
  const rpcCalls: Array<{
    name: "move_whatsapp_account_setup" | "dismiss_whatsapp_setup_move";
    args: Record<string, unknown>;
  }> = [];
  const findAccountCalls: Array<{ userId: string; id: string }> = [];

  const deps: MoveSetupDeps = {
    findOwnedWhatsAppAccount: (userId: string, id: string) => {
      findAccountCalls.push({ userId, id });
      if (overrides.ownedAccounts) {
        const key = `${userId}:${id}`;
        return Promise.resolve(overrides.ownedAccounts[key] ?? null);
      }
      return Promise.resolve({ id });
    },
    rpc: (
      name: "move_whatsapp_account_setup" | "dismiss_whatsapp_setup_move",
      args: Record<string, unknown>,
    ) => {
      rpcCalls.push({ name, args });
      if (overrides.rpcHandler) {
        return overrides.rpcHandler(name, args);
      }
      return Promise.resolve({
        data: { status: "moved", moved: { agent_config: 1 } },
        error: null,
      });
    },
  };

  return { deps, rpcCalls, findAccountCalls };
}

Deno.test("moveSetup: throws MoveSetupError 404 when 'from' account is not owned (no rpc)", async () => {
  const { deps, rpcCalls } = createDeps({
    ownedAccounts: {
      "user-1:acc-from": null,
      "user-1:acc-to": { id: "acc-to" },
    },
  });

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-from",
        to: "acc-to",
        choices: { agent_config: "source" },
      }),
    MoveSetupError,
  )) as MoveSetupError;

  assertEquals(error.status, 404);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("moveSetup: (S1) account owned by another user is 404 even if the id exists", async () => {
  const { deps, rpcCalls } = createDeps({
    ownedAccounts: {
      "user-2:acc-from": { id: "acc-from" }, // exists in DB, but owned by user-2
      "user-1:acc-to": { id: "acc-to" },
    },
  });

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-from",
        to: "acc-to",
        choices: { agent_config: "source" },
      }),
    MoveSetupError,
  )) as MoveSetupError;

  assertEquals(error.status, 404);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("moveSetup: (S1) destination account owned by another user is 404 even if the id exists", async () => {
  const { deps, rpcCalls } = createDeps({
    ownedAccounts: {
      "user-1:acc-from": { id: "acc-from" },
      "user-2:acc-to": { id: "acc-to" }, // exists in DB, but owned by user-2
    },
  });

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-from",
        to: "acc-to",
        choices: { agent_config: "source" },
      }),
    MoveSetupError,
  )) as MoveSetupError;

  assertEquals(error.status, 404);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("moveSetup: throws MoveSetupError 404 when 'to' account is not owned (no rpc)", async () => {
  const { deps, rpcCalls } = createDeps({
    ownedAccounts: {
      "user-1:acc-from": { id: "acc-from" },
      "user-1:acc-to": null,
    },
  });

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-from",
        to: "acc-to",
        choices: { agent_config: "source" },
      }),
    MoveSetupError,
  )) as MoveSetupError;

  assertEquals(error.status, 404);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("moveSetup: throws MoveSetupError 400 when from === to (no rpc)", async () => {
  const { deps, rpcCalls } = createDeps();

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-same",
        to: "acc-same",
        choices: { agent_config: "source" },
      }),
    MoveSetupError,
  )) as MoveSetupError;

  assertEquals(error.status, 400);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("moveSetup: success calls rpc once with p_from, p_to, p_mode:'interactive', p_choices and returns its data", async () => {
  const expectedData = {
    status: "moved",
    moved: { agent_config: 1, connectors: 1 },
    left: [],
    conflicts: [],
  };
  const { deps, rpcCalls } = createDeps({
    rpcHandler: () => Promise.resolve({ data: expectedData, error: null }),
  });

  const choices = { agent_config: "source", connectors: { woo: "replace" } };
  const result = await moveSetup(deps, "user-1", {
    from: "acc-src",
    to: "acc-dst",
    choices,
  });

  assertEquals(result, expectedData);
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0], {
    name: "move_whatsapp_account_setup",
    args: {
      p_from: "acc-src",
      p_to: "acc-dst",
      p_mode: "interactive",
      p_choices: choices,
    },
  });
});

Deno.test("moveSetup: choices undefined is treated as {} in rpc call", async () => {
  const expectedData = { status: "moved" };
  const { deps, rpcCalls } = createDeps({
    rpcHandler: () => Promise.resolve({ data: expectedData, error: null }),
  });

  const result = await moveSetup(deps, "user-1", {
    from: "acc-src",
    to: "acc-dst",
  });

  assertEquals(result, expectedData);
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0], {
    name: "move_whatsapp_account_setup",
    args: {
      p_from: "acc-src",
      p_to: "acc-dst",
      p_mode: "interactive",
      p_choices: {},
    },
  });
});

Deno.test("moveSetup: accounts_not_compatible maps to 409 code 'accounts_not_compatible'", async () => {
  const { deps } = createDeps({
    rpcHandler: () =>
      Promise.resolve({
        data: null,
        error: { code: "22023", message: "move_whatsapp_account_setup: accounts_not_compatible" },
      }),
  });

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-src",
        to: "acc-dst",
        choices: {},
      }),
    MoveSetupError,
  )) as MoveSetupError & { code?: string };

  assertEquals(error.status, 409);
  assertEquals(error.code, "accounts_not_compatible");
});

Deno.test("moveSetup: connector_name_clash maps to 409 code 'connector_name_clash'", async () => {
  const { deps } = createDeps({
    rpcHandler: () =>
      Promise.resolve({
        data: null,
        error: { code: "22023", message: "move_whatsapp_account_setup: connector_name_clash" },
      }),
  });

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-src",
        to: "acc-dst",
        choices: {},
      }),
    MoveSetupError,
  )) as MoveSetupError & { code?: string };

  assertEquals(error.status, 409);
  assertEquals(error.code, "connector_name_clash");
});

Deno.test("moveSetup: store_connector_left_behind maps to 409 code 'store_connector_left_behind'", async () => {
  const { deps } = createDeps({
    rpcHandler: () =>
      Promise.resolve({
        data: null,
        error: { code: "22023", message: "move_whatsapp_account_setup: store_connector_left_behind" },
      }),
  });

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-src",
        to: "acc-dst",
        choices: {},
      }),
    MoveSetupError,
  )) as MoveSetupError & { code?: string };

  assertEquals(error.status, 409);
  assertEquals(error.code, "store_connector_left_behind");
});

Deno.test("moveSetup: replaced_connector_has_store_webhook maps to 409 code 'replaced_connector_has_store_webhook'", async () => {
  const { deps } = createDeps({
    rpcHandler: () =>
      Promise.resolve({
        data: null,
        error: { code: "22023", message: "move_whatsapp_account_setup: replaced_connector_has_store_webhook" },
      }),
  });

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-src",
        to: "acc-dst",
        choices: {},
      }),
    MoveSetupError,
  )) as MoveSetupError & { code?: string };

  assertEquals(error.status, 409);
  assertEquals(error.code, "replaced_connector_has_store_webhook");
});

Deno.test("moveSetup: 55006 maps to 409 code 'order_in_flight'", async () => {
  const { deps } = createDeps({
    rpcHandler: () =>
      Promise.resolve({
        data: null,
        error: { code: "55006", message: "move_whatsapp_account_setup: a store order message is being sent" },
      }),
  });

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-src",
        to: "acc-dst",
        choices: {},
      }),
    MoveSetupError,
  )) as MoveSetupError & { code?: string };

  assertEquals(error.status, 409);
  assertEquals(error.code, "order_in_flight");
  assertEquals(
    error.message,
    "An order message is being sent right now. Try again in a minute.",
  );
});

Deno.test("moveSetup: other rpc error maps to MoveSetupError 500 code 'move_failed' without leaking internal message", async () => {
  const sensitiveDbMessage = "syntax error at or near 'SELECT' in private_schema_table";
  const { deps } = createDeps({
    rpcHandler: () =>
      Promise.resolve({
        data: null,
        error: { code: "42601", message: sensitiveDbMessage },
      }),
  });

  const error = (await assertRejects(
    () =>
      moveSetup(deps, "user-1", {
        from: "acc-src",
        to: "acc-dst",
        choices: {},
      }),
    MoveSetupError,
  )) as MoveSetupError & { code?: string };

  assertEquals(error.status, 500);
  assertEquals(error.code, "move_failed");
  assertEquals(error.message.includes(sensitiveDbMessage), false);
});

Deno.test("dismissSetupMove: throws MoveSetupError 404 when 'from' account is not owned (no rpc)", async () => {
  const { deps, rpcCalls } = createDeps({
    ownedAccounts: {
      "user-1:acc-from": null,
      "user-1:acc-to": { id: "acc-to" },
    },
  });

  const error = (await assertRejects(
    () =>
      dismissSetupMove(deps, "user-1", {
        from: "acc-from",
        to: "acc-to",
      }),
    MoveSetupError,
  )) as MoveSetupError;

  assertEquals(error.status, 404);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("dismissSetupMove: throws MoveSetupError 404 when 'to' account is not owned (no rpc)", async () => {
  const { deps, rpcCalls } = createDeps({
    ownedAccounts: {
      "user-1:acc-from": { id: "acc-from" },
      "user-1:acc-to": null,
    },
  });

  const error = (await assertRejects(
    () =>
      dismissSetupMove(deps, "user-1", {
        from: "acc-from",
        to: "acc-to",
      }),
    MoveSetupError,
  )) as MoveSetupError;

  assertEquals(error.status, 404);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("dismissSetupMove: success calls rpc once with p_to and p_from and returns { success: true }", async () => {
  const { deps, rpcCalls } = createDeps({
    rpcHandler: () => Promise.resolve({ data: null, error: null }),
  });

  const result = await dismissSetupMove(deps, "user-1", {
    from: "acc-src",
    to: "acc-dst",
  });

  assertEquals(result, { success: true });
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0], {
    name: "dismiss_whatsapp_setup_move",
    args: {
      p_to: "acc-dst",
      p_from: "acc-src",
    },
  });
});

Deno.test("dismissSetupMove: rpc error maps to MoveSetupError 500 without leaking internal message", async () => {
  const sensitiveDbMessage = "permission denied on internal function dismiss_whatsapp_setup_move";
  const { deps } = createDeps({
    rpcHandler: () =>
      Promise.resolve({
        data: null,
        error: { code: "42501", message: sensitiveDbMessage },
      }),
  });

  const error = (await assertRejects(
    () =>
      dismissSetupMove(deps, "user-1", {
        from: "acc-src",
        to: "acc-dst",
      }),
    MoveSetupError,
  )) as MoveSetupError;

  assertEquals(error.status, 500);
  assertEquals(error.message.includes(sensitiveDbMessage), false);
});
