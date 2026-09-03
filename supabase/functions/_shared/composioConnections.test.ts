import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { loadActiveConnection } from "./composioConnections.ts";

interface Row {
  id: string;
  workspace_id: string;
  connector_type: string;
  toolkit: string;
  composio_connected_account_id: string | null;
  tool_schema_cache: unknown;
  status: string;
}

function fakeClient(rows: Row[], error?: Error) {
  return {
    from(table: string) {
      assertEquals(table, "connector_connections");
      const filters: Record<string, unknown> = {};
      const builder = {
        select(_columns: string) {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        async maybeSingle() {
          if (error) return { data: null, error };
          const data =
            rows.find((row) =>
              Object.entries(filters).every(([key, value]) =>
                row[key as keyof Row] === value
              )
            ) ?? null;
          return { data, error: null };
        },
      };
      return builder;
    },
  };
}

const active: Row = {
  id: "connection-1",
  workspace_id: "workspace-1",
  connector_type: "slack",
  toolkit: "slack",
  composio_connected_account_id: "composio-1",
  tool_schema_cache: [{ slug: "SLACK_SEARCH_MESSAGES" }],
  status: "active",
};

Deno.test("loadActiveConnection returns the mapped active connection", async () => {
  assertEquals(
    await loadActiveConnection(
      fakeClient([active]),
      active.id,
      active.workspace_id,
    ),
    {
      ok: true,
      connection: {
        id: "connection-1",
        workspaceId: "workspace-1",
        connectorType: "slack",
        toolkit: "slack",
        composioConnectedAccountId: "composio-1",
        toolSchemaCache: [{ slug: "SLACK_SEARCH_MESSAGES" }],
      },
    },
  );
});

Deno.test("loadActiveConnection distinguishes inactive, cross-workspace, and missing", async () => {
  assertEquals(
    await loadActiveConnection(
      fakeClient([{ ...active, status: "revoked" }]),
      active.id,
      active.workspace_id,
    ),
    { ok: false, code: "connection_inactive" },
  );
  assertEquals(
    await loadActiveConnection(fakeClient([active]), active.id, "workspace-2"),
    { ok: false, code: "tenancy_mismatch" },
  );
  assertEquals(
    await loadActiveConnection(fakeClient([]), active.id, active.workspace_id),
    { ok: false, code: "connection_not_found" },
  );
});

Deno.test("loadActiveConnection never treats a failed read as an empty result", async () => {
  await assertRejects(
    () =>
      loadActiveConnection(
        fakeClient([], new Error("statement timeout")),
        active.id,
        active.workspace_id,
      ),
    Error,
    "statement timeout",
  );
});
