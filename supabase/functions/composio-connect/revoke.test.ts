import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { ConnectError } from "./handler.ts";
import { ComposioError } from "../_shared/composioClient.ts";
import { revokeConnection } from "./revoke.ts";
import type { ComposioConnectDependencies } from "./dependencies.ts";

function setup(overrides: Partial<ComposioConnectDependencies> = {}) {
  let deleted = 0;
  const rpcCalls: unknown[][] = [];
  const deps: ComposioConnectDependencies = {
    composio: {
      async initiateConnection() {
        throw new Error("unused");
      },
      async getConnectedAccount() {
        throw new Error("unused");
      },
      async listConnectedAccounts() {
        return [];
      },
      async deleteConnectedAccount() {
        deleted++;
      },
      async listTools() {
        return [];
      },
      async executeTool() {
        throw new Error("unused");
      },
    },
    stateSecret: "secret",
    callbackUrl: "callback",
    appReturnUrl: "return",
    now: Date.now,
    newId: crypto.randomUUID,
    authConfigFor: () => undefined,
    isWorkspaceMember: async () => true,
    insertConnection: async () => {},
    updateConnection: async () => {},
    activateConnection: async () => true,
    loadPendingConnection: async () => null,
    loadConnectionForUser: async () => ({
      id: "connection-1",
      workspaceId: "workspace-1",
      connectorType: "slack",
      composioConnectedAccountId: "ca-1",
      status: "active",
      failureCode: null,
    }),
    revokeRpc: async (...args) => {
      rpcCalls.push(args);
    },
    recordCall: async () => {},
    loadSocialAccountProvider: async () => null,
    upsertSocialAccount: async () => {},
    ...overrides,
  };
  return { deps, rpcCalls, deleted: () => deleted };
}

Deno.test("revoke requires membership and does not call Composio", async () => {
  const state = setup({ loadConnectionForUser: async () => null });
  const error = await assertRejects(
    () =>
      revokeConnection(state.deps, {
        userId: "user-1",
        userClient: {},
        connectionId: "connection-1",
      }),
    ConnectError,
    "forbidden",
  );
  assertEquals(error.status, 403);
  assertEquals(state.deleted(), 0);
});

Deno.test("revoke treats provider deletion as best effort and uses the user JWT RPC client", async () => {
  const userClient = { kind: "jwt-client" };
  const state = setup({
    composio: {
      async initiateConnection() {
        throw new Error("unused");
      },
      async getConnectedAccount() {
        throw new Error("unused");
      },
      async listConnectedAccounts() {
        return [];
      },
      async deleteConnectedAccount() {
        throw new ComposioError("composio_unavailable");
      },
      async listTools() {
        return [];
      },
      async executeTool() {
        throw new Error("unused");
      },
    },
  });
  assertEquals(
    await revokeConnection(state.deps, {
      userId: "user-1",
      userClient,
      connectionId: "connection-1",
    }),
    { ok: true },
  );
  assertEquals(state.rpcCalls, [[userClient, "connection-1"]]);
});
