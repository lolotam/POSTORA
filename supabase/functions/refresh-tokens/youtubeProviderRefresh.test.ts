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
