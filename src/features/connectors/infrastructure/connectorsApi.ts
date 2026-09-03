import { supabase } from "@/integrations/supabase/client";
import type { Database, Tables } from "@/integrations/supabase/types";
import type { ConnectorType } from "@/lib/connectorRegistry";

/**
 * Supabase adapters for the connectors feature. Reads go through RLS (the
 * connection rows) or a member-gated SECURITY DEFINER RPC (usage); every
 * Composio side effect goes through the `composio-connect` edge function
 * under the caller's own JWT — the browser never talks to Composio.
 *
 * A failed read raises. It must never look like "no connections" or "no
 * usage": the two are indistinguishable on screen and only one is safe.
 */

type Fns = Database["public"]["Functions"];

/** The browser-safe subset of a connection row. Composio ids, the state nonce
 *  and the cached schemas stay on the server (spec §11); RLS is row-level and
 *  would hand all of them to any workspace member on a `select("*")`. */
export type ConnectorConnectionRow = Pick<
  Tables<"connector_connections">,
  "id" | "workspace_id" | "connector_type" | "status" | "external_account_label" | "failure_code" | "connected_at" | "created_at"
>;
export type WorkspaceUsageRow = Fns["workspace_connector_usage"]["Returns"][number];

export const CONNECTION_COLUMNS =
  "id, workspace_id, connector_type, status, external_account_label, failure_code, connected_at, created_at";

export async function fetchConnections(workspaceId: string): Promise<ConnectorConnectionRow[]> {
  const { data, error } = await supabase
    .from("connector_connections")
    .select(CONNECTION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ConnectorConnectionRow[];
}

export async function fetchWorkspaceUsage(workspaceId: string, days = 30): Promise<WorkspaceUsageRow[]> {
  const { data, error } = await supabase.rpc("workspace_connector_usage", {
    p_workspace_id: workspaceId,
    p_days: days,
  });
  if (error) throw error;
  return (data ?? []) as WorkspaceUsageRow[];
}

/**
 * The workspace a connector surface belongs to when an account is selected.
 * Null is a real answer, not a failure: 13 of 116 production accounts have no
 * workspace, and the picker has to say so instead of borrowing another one.
 */
export async function fetchAccountWorkspaceId(socialAccountId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("social_accounts")
    .select("workspace_id")
    .eq("id", socialAccountId)
    .maybeSingle();
  if (error) throw error;
  return data?.workspace_id ?? null;
}

/** The signed-in user's personal workspace — the surface's workspace when no
 *  account is selected (Settings → Integrations). */
export async function fetchPersonalWorkspaceId(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("id")
    .eq("owner_id", userId)
    .eq("is_personal", true)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

export interface InitiateConnectionInput {
  connector_type: ConnectorType;
  workspace_id: string;
  /** YouTube only: the profile tab the connected channel should appear on. */
  social_profile_id?: string;
}

export interface InitiatedConnection {
  connection_id: string;
  redirect_url: string;
  expires_at: string;
}

/** Calls one `composio-connect` route with the caller's session JWT, the same
 *  shape ConversationDetail uses for messaging-api. */
async function callComposioConnect<T>(route: string, body: Record<string, unknown>): Promise<T> {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    session = refreshed.session;
    if (!session?.access_token) throw new Error("Not authenticated");
  }
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const response = await fetch(`${supabaseUrl}/functions/v1/composio-connect/${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The function answers a stable error code; surfacing it beats "500".
    throw new Error(
      typeof payload?.error === "string" ? payload.error : `composio-connect ${response.status}`,
    );
  }
  return payload as T;
}

export function initiateConnection(input: InitiateConnectionInput): Promise<InitiatedConnection> {
  return callComposioConnect<InitiatedConnection>("initiate", {
    connector_type: input.connector_type,
    workspace_id: input.workspace_id,
    ...(input.social_profile_id ? { social_profile_id: input.social_profile_id } : {}),
  });
}

export async function revokeConnection(connectionId: string): Promise<void> {
  await callComposioConnect<{ ok: true }>("revoke", { connection_id: connectionId });
}

export async function refreshConnectionSchema(connectionId: string): Promise<void> {
  await callComposioConnect<{ ok: true }>("refresh-schema", { connection_id: connectionId });
}
