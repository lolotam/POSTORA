import type { ComposioToolSchema } from "./composioClient.ts";

export interface ActiveConnection {
  id: string;
  workspaceId: string;
  connectorType: string;
  toolkit: string;
  composioConnectedAccountId: string;
  toolSchemaCache: ComposioToolSchema[] | null;
}

export type ConnectionLookup =
  | { ok: true; connection: ActiveConnection }
  | {
    ok: false;
    code:
      | "connection_inactive"
      | "tenancy_mismatch"
      | "connection_not_found";
  };

interface ConnectionRow {
  id: string;
  workspace_id: string;
  connector_type: string;
  toolkit: string;
  composio_connected_account_id: string | null;
  tool_schema_cache: unknown;
  status: string;
}

function throwReadError(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new Error("connection_read_failed");
}

export async function loadActiveConnection(
  client: any,
  connectionId: string,
  workspaceId: string,
): Promise<ConnectionLookup> {
  const scoped = await client
    .from("connector_connections")
    .select(
      "id,workspace_id,connector_type,toolkit,composio_connected_account_id,tool_schema_cache,status",
    )
    .eq("id", connectionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (scoped.error) throwReadError(scoped.error);
  if (!scoped.data) {
    const unscoped = await client
      .from("connector_connections")
      .select("id")
      .eq("id", connectionId)
      .maybeSingle();
    if (unscoped.error) throwReadError(unscoped.error);
    return unscoped.data
      ? { ok: false, code: "tenancy_mismatch" }
      : { ok: false, code: "connection_not_found" };
  }

  const row = scoped.data as ConnectionRow;
  if (row.status !== "active" || !row.composio_connected_account_id) {
    return { ok: false, code: "connection_inactive" };
  }

  return {
    ok: true,
    connection: {
      id: row.id,
      workspaceId: row.workspace_id,
      connectorType: row.connector_type,
      toolkit: row.toolkit,
      composioConnectedAccountId: row.composio_connected_account_id,
      toolSchemaCache: Array.isArray(row.tool_schema_cache)
        ? row.tool_schema_cache as ComposioToolSchema[]
        : null,
    },
  };
}
