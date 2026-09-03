import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { COMPOSIO_CALLBACK_ACCOUNT_PARAM } from "../_shared/composioClient.ts";
import { signConnectState } from "../_shared/composioState.ts";
import { composioCallbackResponse } from "./callback.ts";
import type {
  ComposioConnectDependencies,
  PendingConnection,
} from "./dependencies.ts";

const pending: PendingConnection = {
  id: "connection-1",
  workspaceId: "workspace-1",
  connectorType: "slack",
  toolkit: "slack",
  authConfigId: "auth-config-1",
  stateNonce: "nonce-1",
  status: "initiated",
};

async function setup(overrides: Partial<ComposioConnectDependencies> = {}) {
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  const calls: Array<Record<string, unknown>> = [];
  const listToolsCalls: unknown[][] = [];
  const deps: ComposioConnectDependencies = {
    composio: {
      async initiateConnection() {
        throw new Error("unused");
      },
      async getConnectedAccount() {
        return {
          id: "ca-1",
          status: "ACTIVE",
          userId: "workspace-1",
          authConfigId: "auth-config-1",
          toolkit: "slack",
          createdAt: "now",
          metadata: { id: "external-1", name: "Workspace" },
        };
      },
      async listConnectedAccounts() {
        return [];
      },
      async deleteConnectedAccount() {},
      async listTools(...args) {
        listToolsCalls.push(args);
        return [{
          slug: "SLACK_SEARCH_MESSAGES",
          description: "Search",
          inputParameters: {},
          version: "latest",
        }];
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
    newId: () => "unused",
    authConfigFor: () => "auth-config-1",
    isWorkspaceMember: async () => true,
    insertConnection: async () => {},
    updateConnection: async (id, values) => updates.push({ id, values }),
    loadPendingConnection: async () => pending,
    loadConnectionForUser: async () => null,
    revokeRpc: async () => {},
    recordCall: async (meta, outcome) => calls.push({ ...meta, ...outcome }),
    ...overrides,
  };
  const token = await signConnectState({
    connectionId: pending.id,
    workspaceId: pending.workspaceId,
    nonce: pending.stateNonce,
    exp: 2_000,
  }, deps.stateSecret);
  const url = new URL(deps.callbackUrl);
  url.searchParams.set("state", token);
  url.searchParams.set(COMPOSIO_CALLBACK_ACCOUNT_PARAM, "ca-1");
  return { deps, url, updates, calls, listToolsCalls };
}

function redirectResult(response: Response): URL {
  assertEquals(response.status, 302);
  return new URL(response.headers.get("location")!);
}

Deno.test("callback refuses malformed or expired state", async () => {
  const state = await setup();
  state.url.searchParams.set("state", "invalid");
  assertEquals(
    redirectResult(await composioCallbackResponse(state.deps, state.url))
      .searchParams.get("result"),
    "invalid_state",
  );

  const expired = await signConnectState({
    connectionId: pending.id,
    workspaceId: pending.workspaceId,
    nonce: pending.stateNonce,
    exp: 999,
  }, state.deps.stateSecret);
  state.url.searchParams.set("state", expired);
  assertEquals(
    redirectResult(await composioCallbackResponse(state.deps, state.url))
      .searchParams.get("result"),
    "invalid_state",
  );
});

Deno.test("callback rejects replay and a missing account parameter", async () => {
  const replay = await setup({
    loadPendingConnection: async () => ({ ...pending, stateNonce: null, status: "active" }),
  });
  assertEquals(
    redirectResult(await composioCallbackResponse(replay.deps, replay.url))
      .searchParams.get("result"),
    "invalid_state",
  );
  assertEquals(replay.calls[0].errorCode, "invalid_state");

  const missing = await setup();
  missing.url.searchParams.delete(COMPOSIO_CALLBACK_ACCOUNT_PARAM);
  assertEquals(
    redirectResult(await composioCallbackResponse(missing.deps, missing.url))
      .searchParams.get("result"),
    "connection_not_found",
  );
});

Deno.test("callback rejects inactive, wrong auth config, and cross-tenant accounts", async () => {
  for (
    const [account, expected] of [
      [{
        status: "INACTIVE",
        userId: "workspace-1",
        authConfigId: "auth-config-1",
      }, "connection_not_found"],
      [
        { status: "ACTIVE", userId: "workspace-1", authConfigId: "wrong" },
        "connection_not_found",
      ],
      [{
        status: "ACTIVE",
        userId: "workspace-2",
        authConfigId: "auth-config-1",
      }, "tenancy_mismatch"],
    ] as const
  ) {
    const state = await setup({
      composio: {
        async initiateConnection() {
          throw new Error("unused");
        },
        async getConnectedAccount() {
          return {
            id: "ca-1",
            toolkit: "slack",
            createdAt: "now",
            metadata: {},
            ...account,
          } as never;
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
    assertEquals(
      redirectResult(await composioCallbackResponse(state.deps, state.url))
        .searchParams.get("result"),
      expected,
    );
    assertEquals(state.updates.at(-1)?.values.status, "failed");
    assertEquals(state.calls.at(-1)?.errorCode, expected);
  }
});

Deno.test("callback activates the connection and caches only registry schemas", async () => {
  const state = await setup();
  const response = await composioCallbackResponse(state.deps, state.url);
  const location = redirectResult(response);
  assertEquals(location.searchParams.get("tab"), "integrations");
  assertEquals(location.searchParams.get("connection"), pending.id);
  assertEquals(location.searchParams.get("result"), "ok");
  assertEquals(state.listToolsCalls[0], ["slack", [
    "SLACK_SEARCH_MESSAGES",
    "SLACK_LIST_CONVERSATIONS",
    "SLACK_SEND_MESSAGE",
  ], "latest"]);
  assertEquals(state.updates.at(-1)?.values.status, "active");
  assertEquals(
    state.updates.at(-1)?.values.composio_connected_account_id,
    "ca-1",
  );
  assertEquals(state.updates.at(-1)?.values.state_nonce, null);
});
