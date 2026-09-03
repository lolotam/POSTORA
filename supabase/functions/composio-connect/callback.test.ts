import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  COMPOSIO_CALLBACK_ACCOUNT_PARAM,
  type ComposioClient,
  type ComposioConnectedAccount,
} from "../_shared/composioClient.ts";
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
  authConfigId: "auth-config-1",
  stateNonce: "nonce-1",
  status: "initiated",
  initiatedBy: "user-1",
  createdAt: "2026-09-03T10:00:00.000Z",
};

const activeAccount: ComposioConnectedAccount = {
  id: "ca-1",
  status: "ACTIVE",
  userId: "workspace-1",
  authConfigId: "auth-config-1",
  toolkit: "slack",
  createdAt: "2026-09-03T10:01:00.000Z",
  alias: null,
  wordId: "slack_talose-acyl",
  metadata: { id: "external-1", name: "Workspace" },
};

/** A client whose every method is unreachable until a test overrides it. */
function composioClient(overrides: Partial<ComposioClient>): ComposioClient {
  return {
    async initiateConnection() {
      throw new Error("unused");
    },
    async getConnectedAccount() {
      return activeAccount;
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
    async requestFileUpload() {
      throw new Error("unused");
    },
    ...overrides,
  } as ComposioClient;
}

const twoChannels = {
  successful: true,
  data: {
    items: [
      {
        id: "channel-1",
        snippet: {
          title: "One",
          thumbnails: { default: { url: "https://img.invalid/1" } },
        },
      },
      { id: "channel-2", snippet: { title: "Two" } },
    ],
  },
};

async function setup(
  overrides: Partial<ComposioConnectDependencies> = {},
  stateExtras: { socialProfileId?: string } = {},
) {
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  const calls: Array<Record<string, unknown>> = [];
  const listToolsCalls: unknown[][] = [];
  const socialAccountUpserts: Array<Record<string, unknown>> = [];
  const deps: ComposioConnectDependencies = {
    composio: composioClient({
      async listTools(...args) {
        listToolsCalls.push(args);
        return [{
          slug: "SLACK_SEARCH_MESSAGES",
          description: "Search",
          inputParameters: {},
          version: "20260826_00",
        }];
      },
    }),
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
    activateConnection: async (id, _nonce, values) => {
      updates.push({ id, values });
      return true;
    },
    loadPendingConnection: async () => pending,
    claimedConnectedAccountIds: async () => new Set<string>(),
    supersedeInitiatedConnections: async () => {},
    loadConnectionForUser: async () => null,
    revokeRpc: async () => {},
    loadSocialAccountProvider: async () => null,
    upsertSocialAccount: async (row) => {
      socialAccountUpserts.push(row);
    },
    recordCall: async (meta, outcome) => calls.push({ ...meta, ...outcome }),
    ...overrides,
  };
  const token = await signConnectState({
    connectionId: pending.id,
    workspaceId: pending.workspaceId,
    nonce: pending.stateNonce!,
    exp: 2_000,
    ...stateExtras,
  }, deps.stateSecret);
  const url = new URL(deps.callbackUrl);
  url.searchParams.set("state", token);
  url.searchParams.set(COMPOSIO_CALLBACK_ACCOUNT_PARAM, "ca-1");
  return { deps, url, updates, calls, listToolsCalls, socialAccountUpserts };
}

function redirectResult(response: Response): URL {
  assertEquals(response.status, 302);
  return new URL(response.headers.get("location")!);
}

async function resultOf(state: { deps: ComposioConnectDependencies; url: URL }) {
  return redirectResult(await composioCallbackResponse(state.deps, state.url))
    .searchParams.get("result");
}

const youtubeOverrides = (
  client: Partial<ComposioClient>,
): Partial<ComposioConnectDependencies> => ({
  loadPendingConnection: async () => ({ ...pending, connectorType: "youtube" }),
  composio: composioClient({
    async getConnectedAccount() {
      return { ...activeAccount, toolkit: "youtube", metadata: {} };
    },
    ...client,
  }),
});

Deno.test("callback refuses malformed or expired state", async () => {
  const state = await setup();
  state.url.searchParams.set("state", "invalid");
  assertEquals(await resultOf(state), "invalid_state");

  const expired = await signConnectState({
    connectionId: pending.id,
    workspaceId: pending.workspaceId,
    nonce: pending.stateNonce!,
    exp: 999,
  }, state.deps.stateSecret);
  state.url.searchParams.set("state", expired);
  assertEquals(await resultOf(state), "invalid_state");
});

Deno.test("callback rejects a replayed state", async () => {
  const replay = await setup({
    loadPendingConnection: async () => ({
      ...pending,
      stateNonce: null,
      status: "active",
    }),
  });
  assertEquals(await resultOf(replay), "invalid_state");
  assertEquals(replay.calls[0].errorCode, "invalid_state");
});

Deno.test("callback reads the account id from either documented spelling", async () => {
  for (const name of ["connectedAccountId", "connected_account_id"]) {
    const fetched: string[] = [];
    const state = await setup({
      composio: composioClient({
        async getConnectedAccount(id) {
          fetched.push(id);
          return activeAccount;
        },
      }),
    });
    state.url.searchParams.delete(COMPOSIO_CALLBACK_ACCOUNT_PARAM);
    state.url.searchParams.set(name, "ca-1");
    assertEquals(await resultOf(state), "ok");
    assertEquals(fetched, ["ca-1"]);
  }
});

Deno.test("callback refuses status=failed before touching Composio", async () => {
  let providerCalls = 0;
  const state = await setup({
    composio: composioClient({
      async getConnectedAccount() {
        providerCalls++;
        return activeAccount;
      },
      async listConnectedAccounts() {
        providerCalls++;
        return [];
      },
    }),
  });
  state.url.searchParams.set("status", "failed");
  assertEquals(await resultOf(state), "connection_not_found");
  assertEquals(providerCalls, 0);
  assertEquals(state.updates.at(-1)?.values.failure_code, "connection_not_found");
});

Deno.test("callback without an id falls back to the newest ACTIVE account under this auth config created since the row", async () => {
  const listed: string[] = [];
  const older = { ...activeAccount, id: "ca-old", createdAt: "2026-09-03T09:00:00.000Z" };
  const otherConfig = { ...activeAccount, id: "ca-other", authConfigId: "auth-config-2" };
  const initiated = { ...activeAccount, id: "ca-pending", status: "INITIATED" as const };
  const newest = { ...activeAccount, id: "ca-new", createdAt: "2026-09-03T10:02:00.000Z" };
  const state = await setup({
    composio: composioClient({
      async getConnectedAccount() {
        throw new Error("must not be called without an id");
      },
      async listConnectedAccounts(workspaceId) {
        listed.push(workspaceId);
        return [older, otherConfig, initiated, activeAccount, newest];
      },
    }),
  });
  state.url.searchParams.delete(COMPOSIO_CALLBACK_ACCOUNT_PARAM);
  assertEquals(await resultOf(state), "ok");
  assertEquals(listed, ["workspace-1"]);
  assertEquals(state.updates.at(-1)?.values.composio_connected_account_id, "ca-new");

  const none = await setup({
    composio: composioClient({
      async listConnectedAccounts() {
        return [older, otherConfig, initiated];
      },
    }),
  });
  none.url.searchParams.delete(COMPOSIO_CALLBACK_ACCOUNT_PARAM);
  assertEquals(await resultOf(none), "connection_not_found");
});

Deno.test("callback rejects inactive, wrong auth config, and cross-tenant accounts", async () => {
  for (
    const [account, expected] of [
      [{ status: "INACTIVE" }, "connection_not_found"],
      [{ authConfigId: "wrong" }, "connection_not_found"],
      [{ userId: "workspace-2" }, "tenancy_mismatch"],
    ] as const
  ) {
    const state = await setup({
      composio: composioClient({
        async getConnectedAccount() {
          return { ...activeAccount, metadata: {}, ...account };
        },
      }),
    });
    assertEquals(await resultOf(state), expected);
    assertEquals(state.updates.at(-1)?.values.status, "failed");
    assertEquals(state.calls.at(-1)?.errorCode, expected);
  }
});

Deno.test("callback activates the connection and caches only registry schemas at the pinned version", async () => {
  const state = await setup();
  const location = redirectResult(await composioCallbackResponse(state.deps, state.url));
  assertEquals(location.pathname, "/settings");
  assertEquals(location.searchParams.get("tab"), "integrations");
  assertEquals(location.searchParams.get("connection"), pending.id);
  assertEquals(location.searchParams.get("result"), "ok");
  assertEquals(state.listToolsCalls[0], ["slack", [
    "SLACK_SEARCH_MESSAGES",
    "SLACK_LIST_CONVERSATIONS",
    "SLACK_SEND_MESSAGE",
  ], "20260826_00"]);
  const activated = state.updates.at(-1)?.values;
  assertEquals(activated?.status, "active");
  assertEquals(activated?.composio_connected_account_id, "ca-1");
  assertEquals(activated?.external_account_label, "Workspace");
  assertEquals(activated?.state_nonce, null);
});

Deno.test("an account with no provider metadata is labelled by its alias, then its word id", async () => {
  for (
    const [account, label] of [
      [{ metadata: {}, alias: "Marketing" }, "Marketing"],
      [{ metadata: {}, alias: null }, "slack_talose-acyl"],
    ] as const
  ) {
    const state = await setup({
      composio: composioClient({
        async getConnectedAccount() {
          return { ...activeAccount, ...account };
        },
      }),
    });
    assertEquals(await resultOf(state), "ok");
    assertEquals(state.updates.at(-1)?.values.external_account_label, label);
  }
});

Deno.test("a callback that loses the activation race is a replay, not a second activation", async () => {
  // The read passed (status initiated, nonce matches) but the compare-and-swap
  // found the nonce already consumed by a concurrent callback.
  const state = await setup({ activateConnection: async () => false });
  assertEquals(await resultOf(state), "invalid_state");
  assertEquals(state.calls.at(-1)?.status, "refused");
  assertEquals(state.calls.at(-1)?.errorCode, "invalid_state");
});

Deno.test("YouTube callback upserts every channel on the chosen profile and returns to /profiles", async () => {
  const state = await setup(
    youtubeOverrides({
      async executeTool(input) {
        assertEquals(input.slug, "YOUTUBE_LIST_CHANNELS");
        assertEquals(input.arguments, { mine: true });
        return twoChannels;
      },
    }),
    { socialProfileId: "profile-1" },
  );

  const location = redirectResult(await composioCallbackResponse(state.deps, state.url));
  assertEquals(location.pathname, "/profiles");
  assertEquals(location.searchParams.get("tab"), null);
  assertEquals(location.searchParams.get("connection"), pending.id);
  assertEquals(location.searchParams.get("result"), "ok");
  assertEquals(state.socialAccountUpserts.length, 2);
  assertEquals(state.socialAccountUpserts[0], {
    user_id: "user-1",
    workspace_id: "workspace-1",
    platform: "youtube",
    platform_user_id: "channel-1",
    platform_username: "One",
    avatar_url: "https://img.invalid/1",
    access_token: null,
    refresh_token: null,
    token_expires_at: null,
    auth_provider: "composio",
    connection_id: "connection-1",
    is_active: true,
    needs_reauth: false,
    social_profile_id: "profile-1",
  });
});

Deno.test("YouTube callback without a profile in the state leaves the channel's tab untouched", async () => {
  const state = await setup(youtubeOverrides({
    async executeTool() {
      return twoChannels;
    },
  }));
  assertEquals(await resultOf(state), "ok");
  assertEquals("social_profile_id" in state.socialAccountUpserts[0], false);
});

Deno.test("YouTube callback fails a connection with no channels", async () => {
  const state = await setup(youtubeOverrides({
    async executeTool() {
      return { successful: true, data: { items: [] } };
    },
  }));
  assertEquals(await resultOf(state), "no_channel");
  assertEquals(state.updates.at(-1)?.values.failure_code, "no_channel");
});

Deno.test("YouTube callback stays active when the channel listing hiccups", async () => {
  const state = await setup(youtubeOverrides({
    async executeTool() {
      return { successful: false, data: null };
    },
  }));
  assertEquals(await resultOf(state), "ok");
  assertEquals(state.updates.at(-1)?.values.status, "active");
  assertEquals(state.updates.every((update) => update.values.status !== "failed"), true);
  assertEquals(state.calls.find((call) => call.actionName === "YOUTUBE_LIST_CHANNELS")?.status, "failed");
});

Deno.test("YouTube callback stays active when channel provisioning fails", async () => {
  const state = await setup({
    ...youtubeOverrides({
      async executeTool() {
        return twoChannels;
      },
    }),
    upsertSocialAccount: async () => {
      throw new Error("database unavailable");
    },
  });
  assertEquals(await resultOf(state), "ok");
  assertEquals(state.updates.at(-1)?.values.status, "active");
  assertEquals(state.updates.every((update) => update.values.status !== "failed"), true);
});

Deno.test("YouTube callback never replaces a native channel", async () => {
  const state = await setup({
    ...youtubeOverrides({
      async executeTool() {
        return twoChannels;
      },
    }),
    loadSocialAccountProvider: async () => "native",
  });
  assertEquals(await resultOf(state), "channel_already_native");
  assertEquals(state.socialAccountUpserts, []);
});
