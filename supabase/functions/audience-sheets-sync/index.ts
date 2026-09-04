/* eslint-disable @typescript-eslint/no-explicit-any */
// Appends selected social_contacts rows to a Google Sheet through the Composio
// connector layer. The caller's identity comes from their JWT; the workspace is
// derived from the connection row, never from the request body, and the caller
// must be a member of that workspace before any tool executes.
//
// App failures answer 200 `{ ok: false, error }` rather than 5xx because the
// edge's CDN masks origin 5xx into opaque errors the UI cannot render.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";

import { authenticateCaller } from "../_shared/auth-helper.ts";
import { composioClientFromEnv } from "../_shared/composioClient.ts";
import { loadActiveConnection } from "../_shared/composioConnections.ts";
import { composioBinding } from "../_shared/connectorRegistry.ts";
import { handleRestrictedCorsOptions, restrictedJsonResponse } from "../_shared/cors.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import {
  type ConnectorCallMeta,
  ConnectorRefusal,
  recordConnectorCall,
  resolveWorkspaceForCall,
  withConnectorCall,
} from "../_shared/connectorTelemetry.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  connection_id: z.string().trim().regex(UUID_PATTERN),
  spreadsheet_id: z.string().trim().min(1),
  sheet_name: z.string().trim().min(1),
  contact_ids: z.array(z.string().trim().regex(UUID_PATTERN)).min(1).max(200),
});

// The append tool verified against Composio's live googlesheets toolkit listing
// at version 20260902_00 (the version pinned on the registry's google_sheets
// entry). Required arguments: spreadsheetId, range (A1), valueInputOption and
// values (a 2D array where each inner array is one ROW).
const SHEETS_APPEND_SLUG = "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND";
const TOOL_TIMEOUT_MS = 20_000;

/** The subset of ComposioClient this function needs; injected so tests can
 * substitute a recorder without env vars or network. */
export interface ComposioExecutor {
  executeTool(input: {
    slug: string;
    version: string;
    workspaceId: string;
    connectedAccountId: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<{ successful: boolean; data: unknown; error?: string }>;
}

export interface SyncDependencies {
  // deno-lint-ignore no-explicit-any
  admin: any;
  composio: ComposioExecutor | null;
  authenticate: (req: Request) => Promise<{ userId: string }>;
}

export function createDependencies(): SyncDependencies {
  return {
    admin: createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    ),
    composio: composioClientFromEnv(),
    authenticate: (req) => authenticateCaller(req),
  };
}

interface ContactRow {
  id: string;
  platform: string;
  platform_user_id: string;
  display_name: string;
  username: string | null;
  phone_number: string | null;
  email: string | null;
  source: string;
  last_comment_text: string | null;
}

// Mirrors the label rule of src/features/audience/domain/socialContact.ts.
// Edge functions cannot import frontend files (ARCHITECTURE.md §13), so the
// three-step fallback is restated here.
function contactLabel(row: ContactRow): string {
  return row.display_name || row.username || row.platform_user_id;
}

export type SyncResult =
  | { ok: true; appended: number }
  | { ok: false; error: string };

export async function syncContactsToSheet(
  deps: SyncDependencies,
  input: {
    userId: string;
    connectionId: string;
    spreadsheetId: string;
    sheetName: string;
    contactIds: string[];
  },
): Promise<SyncResult> {
  // AGENTS.md rule 4: an early return that refuses work writes a ledger row, or an
  // operator debugging "the sync does nothing" has nothing to read.
  const refuseWith = async (
    meta: ConnectorCallMeta,
    error: string,
  ): Promise<SyncResult> => {
    await recordConnectorCall(deps.admin, meta, { status: "refused", errorCode: error });
    console.error(`[audience-sheets-sync] refused for user ${input.userId}: ${error}`);
    return { ok: false, error };
  };

  // Workspace is derived from the connection row. The caller never supplies it,
  // so a guessed connection id from another workspace fails the membership
  // check below rather than leaking which workspaces exist.
  const { data: connectionRow, error: connectionError } = await deps.admin
    .from("connector_connections")
    .select("workspace_id")
    .eq("id", input.connectionId)
    .maybeSingle();
  if (connectionError) throw connectionError;

  // An unknown connection id is still a connector attempt worth a ledger row, and
  // workspace_id is NOT NULL, so it is attributed to the caller's own workspace
  // rather than to a workspace this request never proved anything about.
  const workspaceId: string = connectionRow?.workspace_id ??
    await resolveWorkspaceForCall(deps.admin, { userId: input.userId });

  const meta: ConnectorCallMeta = {
    workspaceId,
    connectionId: input.connectionId,
    connectorType: "google_sheets",
    authStrategy: "composio_oauth",
    actionName: SHEETS_APPEND_SLUG,
    source: "audience",
  };

  if (!connectionRow?.workspace_id) return await refuseWith(meta, "connection_not_found");

  const { data: isMember, error: memberError } = await deps.admin.rpc(
    "is_workspace_member",
    { p_user_id: input.userId, p_workspace_id: workspaceId },
  );
  if (memberError) throw memberError;
  if (isMember !== true) return await refuseWith(meta, "forbidden");

  const binding = composioBinding("google_sheets");
  if (!binding || !binding.mutating.includes(SHEETS_APPEND_SLUG)) {
    return await refuseWith(meta, "connector_tool_not_allowed");
  }

  const lookup = await loadActiveConnection(deps.admin, input.connectionId, workspaceId);
  if (!lookup.ok) return await refuseWith(meta, lookup.code);
  const connection = lookup.connection;

  // An active Slack or Calendar connection in the caller's own workspace would
  // otherwise pass every check above and have its connected-account id handed to
  // the Sheets append tool, sending contact data at the wrong provider entirely.
  if (connection.connectorType !== "google_sheets") {
    return await refuseWith(meta, "connector_type_mismatch");
  }

  if (!deps.composio) return await refuseWith(meta, "composio_unconfigured");

  // Ownership is enforced in the query, not in the caller: the service role
  // bypasses RLS, so `.eq("user_id", userId)` is the tenancy check.
  const { data: contactRows, error: contactsError } = await deps.admin
    .from("social_contacts")
    .select(
      "id,platform,platform_user_id,display_name,username,phone_number,email,source,last_comment_text",
    )
    .in("id", input.contactIds)
    .eq("user_id", input.userId);
  if (contactsError) throw contactsError;

  const byId = new Map<string, ContactRow>(
    ((contactRows ?? []) as ContactRow[]).map((row) => [row.id, row]),
  );
  const syncedAt = new Date().toISOString();
  // Caller's id order preserved, so the sheet matches the rows the user saw.
  const values = input.contactIds
    .map((id) => byId.get(id))
    .filter((row): row is ContactRow => Boolean(row))
    .map((row) => [
      syncedAt,
      contactLabel(row),
      row.platform,
      row.username ?? "",
      row.phone_number ?? "",
      row.email ?? "",
      row.source,
      row.last_comment_text ?? "",
    ]);

  // Every requested id belonged to someone else, so there is nothing to append.
  // Calling the tool with an empty values array would still spend a Composio
  // execution and could clear nothing at best.
  // Nothing to append is not an error -- every requested id simply belonged to
  // someone else -- but it still ends the request early, so it leaves a row.
  if (values.length === 0) {
    await recordConnectorCall(deps.admin, meta, { status: "refused", errorCode: "no_owned_contacts" });
    return { ok: true, appended: 0 };
  }

  // Through the shared wrapper so success, failure and timeout each land in
  // connector_call_logs alongside every other connector call. Composio answers a
  // refused tool with successful:false rather than by rejecting, so that has to be
  // turned into a throw here or the wrapper would file a failure as a success --
  // the same 200-carrying-an-error shape that has bitten this codebase before.
  try {
    await withConnectorCall(deps.admin, meta, async (signal) => {
      const executed = await deps.composio!.executeTool({
        slug: SHEETS_APPEND_SLUG,
        version: binding.toolkitVersion,
        workspaceId,
        connectedAccountId: connection.composioConnectedAccountId,
        arguments: {
      spreadsheetId: input.spreadsheetId,
      // A1 notation needs the title quoted whenever it holds a space, punctuation
      // or a leading digit, and quoting is always legal -- 'Sheet1'!A:H parses the
      // same as Sheet1!A:H. Without this, a tab named "Contacts 2026" comes back
      // as an unparseable range, which the user only ever sees as composio_failed.
      // A literal apostrophe in a title is escaped by doubling it.
      range: `'${input.sheetName.replace(/'/g, "''")}'!A:H`,
      // RAW, never USER_ENTERED: a display name or comment is whatever a stranger
      // typed, and USER_ENTERED makes Sheets evaluate a leading = + - or @ as a
      // formula in the owner's spreadsheet.
      valueInputOption: "RAW",
      majorDimension: "ROWS",
      values,
    },
        signal,
      });
      if (!executed.successful) {
        throw new ConnectorRefusal("composio_failed", executed.error ?? "composio_failed");
      }
      return executed;
    }, { timeoutMs: TOOL_TIMEOUT_MS });
  } catch (error) {
    // Sanitized operational event per ARCHITECTURE.md §17: user and code, never
    // contact data or Composio credentials. The ledger row is already written.
    console.error(
      `[audience-sheets-sync] append failed for user ${input.userId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, error: "composio_failed" };
  }

  return { ok: true, appended: values.length };
}

export async function handleRequest(
  req: Request,
  createDeps: () => SyncDependencies = createDependencies,
): Promise<Response> {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  if (req.method !== "POST") {
    return restrictedJsonResponse(req, { error: "method_not_allowed" }, 405);
  }

  const deps = createDeps();
  if (!req.headers.get("Authorization")) {
    return restrictedJsonResponse(req, { error: "unauthorized" }, 401);
  }

  let userId: string;
  try {
    ({ userId } = await deps.authenticate(req));
  } catch (error) {
    console.error(
      `[audience-sheets-sync] authentication failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return restrictedJsonResponse(req, { error: "unauthorized" }, 401);
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    const result = BodySchema.safeParse(await req.json());
    if (!result.success) {
      return restrictedJsonResponse(req, { ok: false, error: "invalid_request" }, 400);
    }
    parsed = result.data;
  } catch {
    return restrictedJsonResponse(req, { ok: false, error: "invalid_request" }, 400);
  }

  try {
    const result = await syncContactsToSheet(deps, {
      userId,
      connectionId: parsed.connection_id,
      spreadsheetId: parsed.spreadsheet_id,
      sheetName: parsed.sheet_name,
      contactIds: parsed.contact_ids,
    });
    return restrictedJsonResponse(req, result);
  } catch (error) {
    // App errors answer 200 so the browser sees the sanitized reason instead of
    // a CDN-masked 5xx (spec §5.2).
    console.error(
      `[audience-sheets-sync] request failed for user ${userId}: ${
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }`,
    );
    return restrictedJsonResponse(req, {
      ok: false,
      error: sanitizeErrorMessage(error),
    });
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
