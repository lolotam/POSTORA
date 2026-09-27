// Input validation and write orchestration for the ai_agent_tools actions of
// messaging-api. Kept out of index.ts so the refusal table and the row
// decisions are testable without an Edge Runtime, in the register of
// ai-knowledge-ingest/sourceVisibility.ts and aiConfigScope.ts: everything
// that decides BEFORE or AROUND the database is touched lives here.
//
// The scope/account/platform rules are spec §4.1; the credential split,
// vault-first ordering, decrypt-merge-re-encrypt and the plaintext `secret`
// dual-write are spec §4.3; the read-then-update-or-insert row decision is
// spec §4.2, which refuses ON CONFLICT inference over a nullable column
// outright.

import {
  connectorDefinition,
  isComposioType,
  type ConnectorType,
  SERVER_CONNECTOR_TYPES,
} from "../_shared/connectorRegistry.ts";
import { loadActiveConnection } from "../_shared/composioConnections.ts";
import { assertToolSharesBound, type WorkspaceToolScope } from "./toolSharing.ts";

// Carries the HTTP status the Edge Function should answer with. Expected
// business refusals must not surface as opaque 500s.
export class ToolWriteError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ToolWriteError";
    this.status = status;
  }
}

// Reserved names are the builtin tools the AI agent already exposes; a
// connector shadowing one would silently replace a builtin in the dispatch
// Map keyed by name.
const RESERVED_TOOL_NAMES = [
  "search_knowledge", "escalate_to_human", "notify_admin",
  "list_connected_accounts", "search_posts", "get_posting_summary", "create_scheduled_post",
];

export interface ParsedUpsertToolInput {
  name: string;
  description: string;
  /** null for a Composio-backed tool: it executes against Composio through the
   *  connection, so there is no customer endpoint to record (spec §4.2). */
  url: string | null;
  socialAccountId: string;
  connectorType: ConnectorType;
  authStrategy: "manual_credentials" | "composio_oauth";
  connectionId?: string;
  permissions: {
    search_products: boolean;
    check_stock: boolean;
    lookup_orders: boolean;
  };
  isEnabled: boolean;
  adminOnly: boolean;
  readOnlyMode: boolean;
  enableCache: boolean;
  // The legacy webhook-secret column path, unchanged from the previous
  // writer: a non-empty string replaces, clear_secret removes, omission
  // keeps the stored value.
  legacySecret: string | null;
  clearLegacySecret: boolean;
  // Registry-partitioned credential payload: non-secret fields head for the
  // `settings` JSONB column, secret fields for the Vault blob. Only
  // non-empty string values survive parsing.
  settingsPatch: Record<string, string>;
  secretPatch: Record<string, string>;
}

/**
 * The https + public-host rule every native connector URL must pass at save
 * time. SSRF defense in depth: ai-agent-reply re-validates (with DNS
 * resolution) on every call.
 */
function validatePublicToolUrl(toolUrl: string): string {
  if (!/^https:\/\//.test(toolUrl)) {
    throw new ToolWriteError("Tool URL must start with https://");
  }
  try {
    const parsedUrl = new URL(toolUrl);
    const host = parsedUrl.hostname.toLowerCase();
    const privateIpLiteral = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
    if (
      host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
      !host.includes(".") || privateIpLiteral.test(host) || host.includes(":")
    ) {
      throw new ToolWriteError("Tool URL must point to a public host");
    }
  } catch (error) {
    if (error instanceof ToolWriteError) throw error;
    throw new ToolWriteError("Tool URL is not a valid URL");
  }
  return toolUrl;
}

export function parseUpsertToolInput(
  body: Record<string, unknown> | null | undefined,
): ParsedUpsertToolInput {
  const tool = body?.tool;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    throw new ToolWriteError("tool must be an object");
  }
  const record = tool as Record<string, unknown>;

  const name = String(record.name || "").trim();
  const description = String(record.description || "").trim();

  if (!/^[a-z][a-z0-9_]{2,40}$/.test(name)) {
    throw new ToolWriteError("Tool name must be snake_case (3-41 chars, letters/digits/underscores)");
  }
  if (RESERVED_TOOL_NAMES.includes(name)) {
    throw new ToolWriteError(`"${name}" is a reserved builtin tool name`);
  }
  if (!description) throw new ToolWriteError("Tool description is required");

  // An unrecognised connector_type is refused BY NAME, never substituted.
  // The previous writer answered 200 with a custom_rest row, so a user who
  // picked Stripe saw a success toast over a connector they did not choose
  // (spec §1.6) -- the worst of both outcomes.
  const connectorType = record.connector_type;
  if (
    typeof connectorType !== "string" ||
    !(SERVER_CONNECTOR_TYPES as readonly string[]).includes(connectorType)
  ) {
    throw new ToolWriteError(
      `Unknown connector type: ${String(connectorType)}`,
    );
  }
  // Narrowed by the allow-list check above; the cast is earned, not assumed.
  const typedConnectorType = connectorType as ConnectorType;
  const authStrategy = isComposioType(typedConnectorType) ? "composio_oauth" : "manual_credentials";
  // A Composio tool has no endpoint of its own — the connection is the target
  // — so it records null rather than a decoy URL the runtime would never call.
  const toolUrl = authStrategy === "composio_oauth"
    ? null
    : validatePublicToolUrl(String(record.url || "").trim());
  const rawConnectionId = record.connection_id;
  const connectionId = typeof rawConnectionId === "string" && rawConnectionId.trim()
    ? rawConnectionId.trim()
    : undefined;
  if (authStrategy === "composio_oauth" && !connectionId) {
    throw new ToolWriteError("connection_required");
  }

  // A save with no owning account is refused, never written unscoped: an
  // account-less row against an account-scoped table is the defect this
  // whole plan exists to fix (spec §4.1). "" / 0 / false are caller bugs,
  // not consent -- same rule parseNamedAccountId enforces for configs.
  const socialAccountId = record.social_account_id;
  if (typeof socialAccountId !== "string" || !socialAccountId.trim()) {
    throw new ToolWriteError("social_account_id is required");
  }

  const rawPermissions =
    record.permissions && typeof record.permissions === "object" && !Array.isArray(record.permissions)
      ? record.permissions as Record<string, unknown>
      : {};

  const credentials = record.credentials;
  const parsedCredentials: Record<string, string> = {};
  if (credentials !== undefined && credentials !== null) {
    if (typeof credentials !== "object" || Array.isArray(credentials)) {
      throw new ToolWriteError("credentials must be an object of field name to value");
    }
    for (const [key, value] of Object.entries(credentials as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      if (typeof value !== "string") {
        throw new ToolWriteError(`credential field "${key}" must be a string`);
      }
      // An empty string is "nothing submitted", not "store the empty string"
      // -- configured_secret_fields must only ever name fields with values.
      if (value.trim() === "") continue;
      parsedCredentials[key] = value;
    }
  }

  // Partition by the registry's field kind, which is the single definition
  // of every type's fields (spec §5.1). A key the registry does not declare
  // is a drifted client or a probe; both are told which key was refused.
  const definition = connectorDefinition(typedConnectorType);
  const knownKeys = new Set(definition.credentials.map((field) => field.key));
  const unknownKeys = Object.keys(parsedCredentials).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new ToolWriteError(
      `Unknown credential field${unknownKeys.length > 1 ? "s" : ""} for connector type ${connectorType}: ${unknownKeys.join(", ")}`,
    );
  }
  const settingsPatch: Record<string, string> = {};
  const secretPatch: Record<string, string> = {};
  for (const field of definition.credentials) {
    if (!(field.key in parsedCredentials)) continue;
    if (field.kind === "secret") secretPatch[field.key] = parsedCredentials[field.key];
    else settingsPatch[field.key] = parsedCredentials[field.key];
  }

  return {
    name,
    description,
    url: toolUrl,
    socialAccountId: socialAccountId.trim(),
    connectorType: typedConnectorType,
    authStrategy,
    connectionId: authStrategy === "composio_oauth" ? connectionId : undefined,
    permissions: {
      search_products: rawPermissions.search_products === true,
      check_stock: rawPermissions.check_stock === true,
      lookup_orders: rawPermissions.lookup_orders === true,
    },
    isEnabled: record.is_enabled !== false,
    adminOnly: record.admin_only === true,
    readOnlyMode: record.read_only_mode !== false,
    enableCache: record.enable_cache !== false,
    legacySecret: typeof record.secret === "string" && record.secret.trim() !== ""
      ? record.secret.trim()
      : null,
    clearLegacySecret: record.clear_secret === true,
    settingsPatch,
    secretPatch,
  };
}

// The seam the Supabase client actually crosses here. Hand-written in the
// register of sourceVisibility.ts: exactly the surface the tool actions use,
// no more, no `any`.
export interface ToolQuery extends PromiseLike<{ data: Array<Record<string, unknown>> | null; error: unknown }> {
  select(columns?: string): ToolQuery;
  eq(column: string, value: unknown): ToolQuery;
  in(column: string, values: unknown[]): ToolQuery;
  order(column: string, options?: { ascending?: boolean }): ToolQuery;
  insert(values: Record<string, unknown>): ToolQuery;
  update(values: Record<string, unknown>): ToolQuery;
  delete(): ToolQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
  single(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
}

export type ToolAdminClient = {
  from(table: string): ToolQuery;
};

// The Vault seam. The implementation crosses into
// upsert_connector_credential_secret / delete_connector_credential_secret
// (public, service-role-only wrappers this PR's migration adds, because
// PostgREST exposes only public/storage/graphql_public and the vault schema
// is unreachable from supabase-js). The merge of a partial credential update
// happens INSIDE that SQL: decrypt-merge-re-encrypt keyed on the existing
// secret id, so a decrypted credential never enters this function's process
// and the silent-drop bug of §4.3 cannot be expressed here.
export interface CredentialVault {
  upsertCredentials(
    secretId: string | null,
    blob: Record<string, string>,
  ): Promise<{ secretId: string; configuredFields: string[] }>;
  deleteCredentials(secretId: string): Promise<void>;
}

interface AccountRow {
  id: string;
  user_id: string;
  platform: string;
  workspace_id: string | null;
}

export async function resolveToolAccount(
  admin: ToolAdminClient,
  scope: { userId: string } | WorkspaceToolScope,
  socialAccountId: string,
): Promise<AccountRow> {
  if ("workspaceId" in scope && !scope.accountIds.includes(socialAccountId)) {
    throw new ToolWriteError("Account not found", 404);
  }
  let query = admin
    .from("social_accounts")
    .select("id, user_id, platform, workspace_id")
    .eq("id", socialAccountId);
  if ("workspaceId" in scope) query = query.eq("workspace_id", scope.workspaceId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  const account = data as AccountRow | null;
  if (!account) throw new ToolWriteError("Account not found", 404);
  if ("userId" in scope && account.user_id !== scope.userId) {
    throw new ToolWriteError("Account does not belong to the caller", 403);
  }
  return account;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

// The fields of a stored row the orchestration needs to decide the write.
interface ExistingToolRow {
  id: string;
  settings: Record<string, unknown> | null;
  credentials_secret_id: string | null;
}

/**
 * Writes one account-scoped connector (spec §4.1/§4.2/§4.3):
 *
 * 1. resolve the owning account, deriving `platform` from it -- never from
 *    the client, which could otherwise file a connector under a platform its
 *    account does not sit on (the composite FK would catch it, but a clean
 *    400/403/404 beats a constraint violation string);
 * 2. read the account's tools as a LIST and find the row by name --
 *    maybeSingle() breaks the moment an account has two connectors, and
 *    ON CONFLICT inference over the nullable social_account_id column is
 *    refused outright (§4.2);
 * 3. vault FIRST, row SECOND (§4.3): the two writes are not one transaction,
 *    so a failure between them must leave an orphan secret -- wasteful,
 *    sweepable -- never a row pointing at a secret that no longer matches;
 * 4. update the matching row by id, or insert.
 *
 * Returns the saved row with `secret` and `credentials_secret_id` stripped
 * and `has_secret` added; settings and configured_secret_fields are
 * non-secret facts the UI reads back.
 */
export async function upsertAccountScopedTool(
  admin: ToolAdminClient,
  vault: CredentialVault,
  args: ({ userId: string } | (WorkspaceToolScope & { toolId: string })) & { input: ParsedUpsertToolInput },
): Promise<Record<string, unknown>> {
  const { input } = args;
  const account = await resolveToolAccount(admin, args, input.socialAccountId);

  if (input.authStrategy === "composio_oauth") {
    if (!account.workspace_id || !input.connectionId) {
      throw new ToolWriteError("connection_forbidden", 403);
    }
    if ("userId" in args) {
      const { data: membership, error: membershipError } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", account.workspace_id)
      .eq("user_id", args.userId)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership) throw new ToolWriteError("connection_forbidden", 403);
    }

    const lookup = await loadActiveConnection(admin, input.connectionId, account.workspace_id);
    if (!lookup.ok) {
      if (lookup.code === "connection_inactive") {
        throw new ToolWriteError("connection_inactive", 409);
      }
      throw new ToolWriteError("connection_forbidden", 403);
    }
    if (lookup.connection.connectorType !== input.connectorType) {
      throw new ToolWriteError("connection_forbidden", 403);
    }
  }

  let toolQuery = admin
    .from("ai_agent_tools")
    .select("id, name, settings, credentials_secret_id")
    .eq("social_account_id", account.id);
  toolQuery = "userId" in args
    ? toolQuery.eq("user_id", args.userId).eq("name", input.name)
    : toolQuery.eq("id", args.toolId).eq("scope", "account");
  const { data: toolRows, error: readError } = await toolQuery;
  if (readError) throw readError;
  const existing = ((toolRows ?? []).find((row) => "userId" in args ? row.name === input.name : row.id === args.toolId) ?? null) as ExistingToolRow | null;
  if (existing && "workspaceId" in args) await assertToolSharesBound(admin, existing.id, args);

  // Vault first. configured_secret_fields is derived from the blob on every
  // write (the SQL returns the merged key list) -- never accepted from the
  // client and never set independently (§4.3).
  const credentials = input.authStrategy === "manual_credentials" && Object.keys(input.secretPatch).length > 0
    ? await vault.upsertCredentials(existing?.credentials_secret_id ?? null, input.secretPatch)
    : null;

  const values: Record<string, unknown> = {
    user_id: account.user_id,
    name: input.name,
    description: input.description.slice(0, 500),
    tool_type: "n8n_webhook",
    url: input.url,
    is_enabled: input.isEnabled,
    admin_only: input.adminOnly,
    connector_type: input.connectorType,
    auth_strategy: input.authStrategy,
    connection_id: input.connectionId ?? null,
    permissions: input.permissions,
    read_only_mode: input.readOnlyMode,
    enable_cache: input.enableCache,
    social_account_id: account.id,
    platform: account.platform,
    scope: "account",
  };

  // Settings merge, mirroring the secret merge: a partial save must not wipe
  // the store_url it did not submit.
  if (Object.keys(input.settingsPatch).length > 0) {
    values.settings = { ...(existing?.settings ?? {}), ...input.settingsPatch };
  } else if (!existing) {
    values.settings = {};
  }

  if (credentials) {
    values.credentials_secret_id = credentials.secretId;
    values.configured_secret_fields = credentials.configuredFields;
  }

  // The plaintext `secret` column stays live: its reader is executeCustomTool
  // (ai-agent-reply/tools.ts:409), which sets X-Webhook-Secret. Moving the
  // value before a deployed reader dual-reads stops that header being sent --
  // a silent auth failure on every n8n webhook call (§4.3). PR-6 migrates it.
  if (input.legacySecret !== null) {
    values.secret = input.legacySecret;
  } else if (input.clearLegacySecret) {
    values.secret = null;
  }
  if (input.connectorType === "custom_rest" && typeof input.secretPatch.secret === "string") {
    values.secret = input.secretPatch.secret;
  }

  let data: Record<string, unknown> | null;
  let error: unknown;
  if (existing) {
    let updateQuery = admin
      .from("ai_agent_tools")
      .update(values)
      .eq("id", existing.id);
    if ("workspaceId" in args) updateQuery = updateQuery.eq("social_account_id", account.id).eq("scope", "account");
    ({ data, error } = await updateQuery.select().single());
  } else {
    if ("workspaceId" in args) values.id = args.toolId;
    ({ data, error } = await admin
      .from("ai_agent_tools")
      .insert(values)
      .select()
      .single());
  }
  if (error) {
    // The legacy UNIQUE (user_id, name) still stands until PR-7 drops it, so
    // a name another account (or a pre-migration row) already holds trips
    // 23505 here. Translate it into what is actually true rather than a raw
    // constraint string.
    if (isUniqueViolation(error)) {
      throw new ToolWriteError(
        `A connector named "${input.name}" already exists. Names must stay unique across all your accounts until the legacy uniqueness constraint is dropped.`,
        409,
      );
    }
    throw error;
  }

  const { secret: savedSecret, credentials_secret_id: _secretId, ...safeTool } = data ?? {};
  return { ...safeTool, has_secret: !!savedSecret };
}

/**
 * Lists the caller's connectors with no secret material and no vault ids.
 * Never touches Vault: `configured_secret_fields` exists precisely so the
 * UI can render "Consumer secret: set" without decrypting anything (§4.3).
 */
export async function listToolsForUser(
  admin: ToolAdminClient,
  userId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await admin
    .from("ai_agent_tools")
    .select("*")
    .eq("user_id", userId)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(({ secret, credentials_secret_id: _credentialsSecretId, ...tool }) => ({
    ...tool,
    has_secret: !!secret,
  }));
}

/**
 * Deletes one connector, reclaiming its Vault secret BEFORE the row is gone:
 * once the row is deleted the secret id is unrecoverable and the secret is
 * orphaned forever (§4.3 -- vault has no delete function of its own). The
 * AFTER DELETE trigger this PR's migration adds covers the cascade paths
 * that never pass through application code; this explicit path gives the
 * app a clean failure that leaves row and secret both intact.
 */
export async function deleteAccountScopedTool(
  admin: ToolAdminClient,
  vault: CredentialVault,
  args: ({ userId: string } | WorkspaceToolScope) & { toolId: string },
): Promise<void> {
  const { toolId } = args;
  let ids: string[] = [];
  if ("workspaceId" in args) {
    const { data, error } = await admin.from("social_accounts").select("id")
      .eq("workspace_id", args.workspaceId).in("id", args.accountIds);
    if (error) throw error;
    ids = (data ?? []).map((row) => String(row.id));
  }
  let query = admin
    .from("ai_agent_tools")
    .select("id, credentials_secret_id")
    .eq("id", toolId);
  query = "userId" in args ? query.eq("user_id", args.userId)
    : query.in("social_account_id", ids).eq("scope", "account");
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  const row = data as { credentials_secret_id?: string | null } | null;
  if (!row) throw new ToolWriteError("Tool not found", 404);
  if ("workspaceId" in args) await assertToolSharesBound(admin, toolId, args);

  if (row.credentials_secret_id) {
    await vault.deleteCredentials(row.credentials_secret_id);
  }

  let deletion = admin
    .from("ai_agent_tools")
    .delete()
    .eq("id", toolId);
  deletion = "userId" in args ? deletion.eq("user_id", args.userId)
    : deletion.in("social_account_id", ids).eq("scope", "account");
  const { error: deleteError } = await deletion;
  if (deleteError) throw deleteError;
}
