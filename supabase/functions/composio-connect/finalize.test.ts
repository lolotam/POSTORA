import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  type ComposioClient,
  type ComposioConnectedAccount,
  ComposioError,
} from "../_shared/composioClient.ts";
import type {
  ComposioConnectDependencies,
  PendingConnection,
  UserConnection,
} from "./dependencies.ts";
import { finalizeConnection } from "./finalize.ts";
import { ConnectError } from "./handler.ts";

const ROW_CREATED_MS = Date.parse("2026-09-03T15:21:20.000Z");

const pending: PendingConnection = {
  id: "connection-1",
  workspaceId: "workspace-1",
  connectorType: "google_sheets",
  authConfigId: "auth-config-1",
  stateNonce: "nonce-1",
  status: "initiated",
  initiatedBy: "user-1",
  createdAt: "2026-09-03T15:21:20.000Z",
};

const owned: UserConnection = {
  id: "connection-1",
  workspaceId: "workspace-1",
  connectorType: "google_sheets",
  composioConnectedAccountId: null,
  status: "initiated",
  failureCode: null,
};

/** The account Composio activated 26 s after the row, as on 2026-09-03. */
const fresh: ComposioConnectedAccount = {
  id: "ca-fresh",
  status: "ACTIVE",
  userId: "workspace-1",
  authConfigId: "auth-config-1",
  toolkit: "googlesheets",
  createdAt: "2026-09-03T15:21:46.000Z",
  alias: null,
  wordId: "googlesheets_souse-fuci",
  metadata: {},
};

function composioClient(overrides: Partial<ComposioClient>): ComposioClient {
  return {
    async initiateConnection() {
      throw new Error("unused");
    },
    async getConnectedAccount() {
      throw new Error("finalize never has an id to look up");
    },
    async listConnectedAccounts() {
      return [];
    },
    async deleteConnectedAccount() {},
    async listTools() {
      return [{ slug: "GOOGLESHEETS_BATCH_GET", description: "", inputParameters: {}, version: "20260902_00" }];
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

function setup(overrides: Partial<ComposioConnectDependencies> = {}, nowMs = ROW_CREATED_MS + 30_000) {
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  const calls: Array<Record<string, unknown>> = [];
  const upserts: Array<Record<string, unknown>> = [];
  const deps: ComposioConnectDependencies = {
    composio: composioClient({}),
    stateSecret: "state-secret",
    callbackUrl: "https://api.postora.cloud/functions/v1/composio-connect/callback",
    appReturnUrl: "https://postora.cloud/settings?tab=integrations",
    now: () => nowMs,
    newId: () => "unused",
    authConfigFor: () => "auth-config-1",
    isWorkspaceMember: async () => true,
    insertConnection: async () => {},
    updateConnection: async (id, values) => {
      updates.push({ id, values });
    },
    activateConnection: async (id, _nonce, values) => {
      updates.push({ id, values });
      return true;
    },
    loadPendingConnection: async () => pending,
    loadConnectionForUser: async () => owned,
    revokeRpc: async () => {},
    loadSocialAccountProvider: async () => null,
    upsertSocialAccount: async (row) => {
      upserts.push(row);
    },
    recordCall: async (meta, outcome) => calls.push({ ...meta, ...outcome }),
    ...overrides,
  };
  return { deps, updates, calls, upserts };
}

const input = { userId: "user-1", connectionId: "connection-1", socialProfileId: null };

Deno.test("finalize refuses a caller who is not a member of the row's workspace", async () => {
  const state = setup({ loadConnectionForUser: async () => null });
  const error = await assertRejects(() => finalizeConnection(state.deps, input), ConnectError, "forbidden");
  assertEquals(error.status, 403);
});

Deno.test("finalize answers an already-active row without asking Composio", async () => {
  let listed = 0;
  const state = setup({
    loadConnectionForUser: async () => ({ ...owned, status: "active" }),
    composio: composioClient({
      async listConnectedAccounts() {
        listed++;
        return [];
      },
    }),
  });
  assertEquals(await finalizeConnection(state.deps, input), { status: "active" });
  assertEquals(listed, 0);
});

Deno.test("finalize reports a failed or revoked row with its code", async () => {
  for (
    const [row, code] of [
      [{ ...owned, status: "failed", failureCode: "no_channel" }, "no_channel"],
      [{ ...owned, status: "revoked", failureCode: null }, "revoked"],
    ] as const
  ) {
    const state = setup({ loadConnectionForUser: async () => row });
    assertEquals(await finalizeConnection(state.deps, input), { status: "failed", failure_code: code });
  }
});

Deno.test("finalize stays pending while Composio has no active account for the row yet", async () => {
  const older = { ...fresh, id: "ca-old", createdAt: "2026-09-03T15:00:00.000Z" };
  const initiated = { ...fresh, id: "ca-init", status: "INITIATED" as const };
  const state = setup({
    composio: composioClient({
      async listConnectedAccounts() {
        return [older, initiated];
      },
    }),
  });
  assertEquals(await finalizeConnection(state.deps, input), { status: "pending" });
  assertEquals(state.updates, []);
});

Deno.test("finalize treats a Composio outage mid-poll as pending, not as a verdict", async () => {
  const state = setup({
    composio: composioClient({
      async listConnectedAccounts() {
        throw new ComposioError("composio_unavailable", 503);
      },
    }),
  });
  assertEquals(await finalizeConnection(state.deps, input), { status: "pending" });
  assertEquals(state.updates, []);
});

Deno.test("finalize activates the row from the account Composio created after it and caches the schemas", async () => {
  const state = setup({
    composio: composioClient({
      async listConnectedAccounts(workspaceId) {
        assertEquals(workspaceId, "workspace-1");
        return [fresh];
      },
    }),
  });
  assertEquals(await finalizeConnection(state.deps, input), { status: "active" });
  const activated = state.updates.at(-1)?.values;
  assertEquals(activated?.status, "active");
  assertEquals(activated?.composio_connected_account_id, "ca-fresh");
  assertEquals(activated?.external_account_label, "googlesheets_souse-fuci");
  assertEquals((activated?.tool_schema_cache as unknown[]).length, 1);
});

Deno.test("finalize expires a row older than the state TTL instead of adopting a later account", async () => {
  const state = setup({
    composio: composioClient({
      async listConnectedAccounts() {
        return [fresh];
      },
    }),
  }, ROW_CREATED_MS + 11 * 60_000);
  assertEquals(await finalizeConnection(state.deps, input), { status: "failed", failure_code: "expired" });
  assertEquals(state.updates.at(-1)?.values, { status: "failed", failure_code: "expired", state_nonce: null });
  assertEquals(state.calls.at(-1)?.errorCode, "expired");
});

Deno.test("finalize homes a YouTube channel on the profile the poll names", async () => {
  const state = setup({
    loadConnectionForUser: async () => ({ ...owned, connectorType: "youtube" }),
    loadPendingConnection: async () => ({ ...pending, connectorType: "youtube" }),
    composio: composioClient({
      async listConnectedAccounts() {
        return [{ ...fresh, toolkit: "youtube" }];
      },
      async executeTool() {
        return { successful: true, data: { items: [{ id: "channel-1", snippet: { title: "One" } }] } };
      },
    }),
  });
  assertEquals(
    await finalizeConnection(state.deps, { ...input, socialProfileId: "profile-1" }),
    { status: "active" },
  );
  assertEquals(state.upserts.length, 1);
  assertEquals(state.upserts[0].platform_user_id, "channel-1");
  assertEquals(state.upserts[0].social_profile_id, "profile-1");
  assertEquals(state.upserts[0].auth_provider, "composio");
});

Deno.test("finalize reports the refusal when activation fails after the account was found", async () => {
  const state = setup({
    loadConnectionForUser: async () => ({ ...owned, connectorType: "youtube" }),
    loadPendingConnection: async () => ({ ...pending, connectorType: "youtube" }),
    composio: composioClient({
      async listConnectedAccounts() {
        return [{ ...fresh, toolkit: "youtube" }];
      },
      async executeTool() {
        return { successful: true, data: { items: [] } };
      },
    }),
  });
  assertEquals(await finalizeConnection(state.deps, input), { status: "failed", failure_code: "no_channel" });
  assertEquals(state.updates.at(-1)?.values.failure_code, "no_channel");
});
