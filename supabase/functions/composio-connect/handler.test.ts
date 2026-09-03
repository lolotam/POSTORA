import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { ComposioError } from "../_shared/composioClient.ts";
import { ConnectError, initiateConnection } from "./handler.ts";
import type { ComposioConnectDependencies } from "./dependencies.ts";

function dependencies(overrides: Partial<ComposioConnectDependencies> = {}) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Array<{ id: string; values: Record<string, unknown> }> = [];
  const calls: Array<Record<string, unknown>> = [];
  const initiated: Array<Record<string, unknown>> = [];
  const deps: ComposioConnectDependencies = {
    composio: {
      async initiateConnection(input) {
        initiated.push(input);
        return {
          connectionRequestId: "request-1",
          redirectUrl: "https://provider.invalid/connect",
        };
      },
      async getConnectedAccount() {
        throw new Error("unused");
      },
      async listConnectedAccounts() {
        return [];
      },
      async deleteConnectedAccount() {},
      async listTools() {
        return [];
      },
      async executeTool() {
        throw new Error("unused");
      },
    },
    stateSecret: "state-secret",
    callbackUrl:
      "https://api.postora.cloud/functions/v1/composio-connect/callback",
    appReturnUrl: "https://postora.cloud/settings?tab=integrations",
    now: () => 1_000_000,
    newId: () => "connection-1",
    authConfigFor: () => "auth-config-1",
    isWorkspaceMember: async () => true,
    insertConnection: async (row) => inserted.push(row),
    updateConnection: async (id, values) => updated.push({ id, values }),
    loadPendingConnection: async () => null,
    loadConnectionForUser: async () => null,
    revokeRpc: async () => {},
    recordCall: async (meta, outcome) => calls.push({ ...meta, ...outcome }),
    ...overrides,
  };
  return { deps, inserted, updated, calls, initiated };
}

Deno.test("initiate refuses a caller outside the workspace before Composio", async () => {
  const state = dependencies({ isWorkspaceMember: async () => false });
  const error = await assertRejects(
    () =>
      initiateConnection(state.deps, {
        userId: "user-1",
        workspaceId: "workspace-1",
        connectorType: "slack",
      }),
    ConnectError,
    "forbidden",
  );
  assertEquals(error.status, 403);
  assertEquals(state.initiated.length, 0);
});

Deno.test("initiate rejects native connector types", async () => {
  const state = dependencies();
  const error = await assertRejects(
    () =>
      initiateConnection(state.deps, {
        userId: "user-1",
        workspaceId: "workspace-1",
        connectorType: "stripe",
      }),
    ConnectError,
    "connector_type_not_connectable",
  );
  assertEquals(error.status, 400);
});

Deno.test("initiate fails closed when auth config or client is unavailable and records refusal", async () => {
  for (
    const overrides of [
      { authConfigFor: () => undefined },
      { composio: null },
    ]
  ) {
    const state = dependencies(overrides);
    const error = await assertRejects(
      () =>
        initiateConnection(state.deps, {
          userId: "user-1",
          workspaceId: "workspace-1",
          connectorType: "slack",
        }),
      ConnectError,
      "connector_unavailable",
    );
    assertEquals(error.status, 503);
    assertEquals(state.calls[0].status, "refused");
    assertEquals(state.calls[0].errorCode, "connector_unavailable");
  }
});

Deno.test("initiate inserts pending state before creating a connect link", async () => {
  const state = dependencies();
  const result = await initiateConnection(state.deps, {
    userId: "user-1",
    workspaceId: "workspace-1",
    connectorType: "slack",
  });

  assertEquals(state.inserted[0].status, "initiated");
  assertEquals(state.inserted[0].initiated_by, "user-1");
  assertEquals(typeof state.inserted[0].state_nonce, "string");
  assertEquals(state.initiated[0].workspaceId, "workspace-1");
  assertEquals(state.initiated[0].authConfigId, "auth-config-1");
  const callback = new URL(String(state.initiated[0].callbackUrl));
  assertEquals(callback.origin + callback.pathname, state.deps.callbackUrl);
  assertEquals(typeof callback.searchParams.get("state"), "string");
  assertEquals(result.connection_id, "connection-1");
  assertEquals(result.redirect_url, "https://provider.invalid/connect");
  assertEquals(result.expires_at, new Date(1_600_000).toISOString());
});

Deno.test("initiate marks a provider failure without exposing its body", async () => {
  const state = dependencies({
    composio: {
      async initiateConnection() {
        throw new ComposioError("composio_unavailable", 503);
      },
      async getConnectedAccount() {
        throw new Error("unused");
      },
      async listConnectedAccounts() {
        return [];
      },
      async deleteConnectedAccount() {},
      async listTools() {
        return [];
      },
      async executeTool() {
        throw new Error("unused");
      },
    },
  });
  const error = await assertRejects(
    () =>
      initiateConnection(state.deps, {
        userId: "user-1",
        workspaceId: "workspace-1",
        connectorType: "slack",
      }),
    ConnectError,
    "connector_unavailable",
  );
  assertEquals(error.status, 503);
  assertEquals(state.updated[0], {
    id: "connection-1",
    values: {
      status: "failed",
      failure_code: "composio_unavailable",
      state_nonce: null,
    },
  });
  assertEquals(state.calls[0].status, "failed");
});
