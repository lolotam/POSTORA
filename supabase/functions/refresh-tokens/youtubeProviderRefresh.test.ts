import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { probeYouTubeProvider } from "./youtubeProviderRefresh.ts";

function adminFor(status: string) {
  const ledger: Record<string, unknown>[] = [];
  return {
    ledger,
    admin: {
      from(table: string) {
        if (table === "connector_call_logs") {
          return {
            insert: async (row: Record<string, unknown>) => {
              ledger.push(row);
              return { error: null };
            },
          };
        }
        if (table === "workspaces") {
          // resolveWorkspaceForCall's personal-workspace fallback.
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            async maybeSingle() {
              return { data: { id: "personal-workspace-1" }, error: null };
            },
          };
        }
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          async maybeSingle() {
            return {
              data: {
                id: "connection-1",
                workspace_id: "workspace-1",
                composio_connected_account_id: "ca-1",
                status,
              },
              error: null,
            };
          },
        };
      },
    },
  };
}

Deno.test("native YouTube remains on the native refresh path", async () => {
  let nativeCalls = 0;
  const state = adminFor("active");
  const result = await probeYouTubeProvider({
    id: "account-1",
    user_id: "owner-1",
    auth_provider: "native",
  }, {
    admin: state.admin,
    client: null,
    refreshNative: async () => {
      nativeCalls++;
      return "native-result";
    },
    markInactive: async () => {},
  });
  assertEquals(result, { provider: "native", result: "native-result" });
  assertEquals(nativeCalls, 1);
});

Deno.test("Composio YouTube never refreshes Google and marks non-ACTIVE accounts", async () => {
  let nativeCalls = 0;
  let inactiveCalls = 0;
  const state = adminFor("active");
  const result = await probeYouTubeProvider({
    id: "account-1",
    user_id: "owner-1",
    auth_provider: "composio",
    connection_id: "connection-1",
    workspace_id: "workspace-1",
  }, {
    admin: state.admin,
    client: {
      getConnectedAccount: async () => ({ status: "INACTIVE" }),
    } as never,
    refreshNative: async () => {
      nativeCalls++;
      return null;
    },
    markInactive: async () => {
      inactiveCalls++;
    },
  });
  assertEquals(result, { provider: "composio", active: false });
  assertEquals(nativeCalls, 0);
  assertEquals(inactiveCalls, 1);
  assertEquals(state.ledger.at(-1)?.source, "test");
});

// connector_call_logs.workspace_id is a NOT NULL uuid: a null account workspace
// must resolve to the owner's personal workspace, never the empty string that
// made every probe's ledger insert throw.
Deno.test("a null account workspace is ledgered against the owner's personal workspace", async () => {
  const state = adminFor("active");
  const result = await probeYouTubeProvider({
    id: "account-1",
    user_id: "owner-1",
    auth_provider: "composio",
    connection_id: "connection-1",
    workspace_id: null,
  }, {
    admin: state.admin,
    client: {
      getConnectedAccount: async () => ({ status: "ACTIVE" }),
    } as never,
    refreshNative: async () => null,
    markInactive: async () => {},
  });
  assertEquals(result, { provider: "composio", active: true });
  assertEquals(state.ledger.length, 1);
  assertEquals(state.ledger[0].workspace_id, "personal-workspace-1");
});
