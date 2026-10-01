import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dismissSetupMove,
  moveSetup,
  MoveSetupError,
  type MoveSetupDeps,
} from "./moveSetup.ts";

function createDeps(
  overrides: {
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
      if (overrides.ownedAccounts && id in overrides.ownedAccounts) {
        return Promise.resolve(overrides.ownedAccounts[id]);
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
      "acc-from": null,
      "acc-to": { id: "acc-to" },
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
      "acc-from": { id: "acc-from" },
      "acc-to": null,
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

Deno.test("moveSetup: rpc error code 22023 maps to MoveSetupError 409 with specific message", async () => {
  const { deps } = createDeps({
    rpcHandler: () =>
      Promise.resolve({
        data: null,
        error: { code: "22023", message: "move_whatsapp_account_setup: workspace mismatch" },
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
  )) as MoveSetupError;

  assertEquals(error.status, 409);
  assertEquals(
    error.message,
    "These two connections can't share setup (different workspace or not finished connecting)",
  );
});

Deno.test("moveSetup: rpc error code 55006 maps to MoveSetupError 409 with specific message", async () => {
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
  )) as MoveSetupError;

  assertEquals(error.status, 409);
  assertEquals(
    error.message,
    "An order message is being sent right now. Try again in a minute.",
  );
});

Deno.test("moveSetup: other rpc error maps to MoveSetupError 500 without leaking internal message", async () => {
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
  )) as MoveSetupError;

  assertEquals(error.status, 500);
  assertEquals(error.message.includes(sensitiveDbMessage), false);
});

Deno.test("dismissSetupMove: throws MoveSetupError 404 when 'from' account is not owned (no rpc)", async () => {
  const { deps, rpcCalls } = createDeps({
    ownedAccounts: {
      "acc-from": null,
      "acc-to": { id: "acc-to" },
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
      "acc-from": { id: "acc-from" },
      "acc-to": null,
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
