// "audience" is the Audience Hub's Sheets sync: neither the agent, a partner key, a
// connection test, nor a publish. Widened alongside connector_call_logs' CHECK.
export type ConnectorCallSource = "agent" | "partner" | "test" | "publish" | "audience";
export type ConnectorCallStatus = "success" | "failed" | "refused" | "timeout";

export interface ConnectorCallMeta {
  workspaceId: string;
  toolId?: string | null;
  connectionId?: string | null;
  socialAccountId?: string | null;
  partnerKeyId?: string | null;
  connectorType: string;
  /**
   * How the tool authenticates. `"unknown"` is not a third strategy — it is
   * the honest value for a refusal that happens BEFORE any tool is resolved
   * (spec §11's "partner key not bound to the account" row): the column is NOT
   * NULL, the tool is deliberately not looked up, and inventing
   * `manual_credentials` there would put a fact in the ledger that nobody
   * established.
   */
  authStrategy: "manual_credentials" | "composio_oauth" | "unknown";
  actionName: string;
  source: ConnectorCallSource;
  requestId?: string | null;
}

export interface ConnectorCallOutcome {
  status: ConnectorCallStatus;
  errorCode?: string | null;
  latencyMs?: number | null;
}

export class ConnectorRefusal extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "ConnectorRefusal";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `tool_id` is a uuid FK to ai_agent_tools, and it is the one meta field whose
 * plausible wrong value is a human-readable Composio slug -- callers think of
 * tools by slug, and the YouTube comment poll duly passed one, losing every
 * insert to `invalid input syntax for type uuid` from the day it shipped.
 * Dropping that single field and naming it keeps the rest of the row, which is
 * the part an operator actually reads.
 *
 * Only this field is laundered. The other id columns are always copied from a
 * row's own primary key, so a non-uuid there means a test fixture, not a live
 * caller, and silently nulling it would hide a genuinely different bug.
 * `workspaceId` is NOT NULL besides: there is nothing to fall back to, and a
 * bad one must fail loudly rather than invent a workspace the call never
 * happened in.
 */
function toolIdOrNull(meta: ConnectorCallMeta): string | null {
  const value = meta.toolId;
  if (value == null) return null;
  if (UUID_PATTERN.test(value)) return value;
  console.warn(
    `[connector-telemetry] dropped non-uuid tool_id connector=${meta.connectorType} action=${meta.actionName} value=${value}`,
  );
  return null;
}

function ledgerRow(meta: ConnectorCallMeta, outcome: ConnectorCallOutcome) {
  return {
    workspace_id: meta.workspaceId,
    tool_id: toolIdOrNull(meta),
    connection_id: meta.connectionId ?? null,
    social_account_id: meta.socialAccountId ?? null,
    partner_key_id: meta.partnerKeyId ?? null,
    connector_type: meta.connectorType,
    auth_strategy: meta.authStrategy,
    action_name: meta.actionName,
    source: meta.source,
    status: outcome.status,
    error_code: outcome.errorCode ?? null,
    request_id: meta.requestId ?? null,
    latency_ms: outcome.latencyMs == null
      ? null
      : Math.max(0, Math.floor(outcome.latencyMs)),
  };
}

function reasonText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(reason ?? "unknown error");
}

/**
 * Telemetry must never break the call it records, so a failed insert is logged,
 * not thrown. The reason is a database-driver message (never user content,
 * tokens or credentials) and the action and connector come from the meta, so
 * the next failure names itself instead of firing a bare "insert failed" that
 * took a day to notice on 2026-09-03.
 */
function logLedgerFailure(meta: ConnectorCallMeta, reason: unknown): void {
  console.error(
    `[connector-telemetry] ledger insert failed: connector=${meta.connectorType} action=${meta.actionName} reason=${reasonText(reason)}`,
  );
}

export async function recordConnectorCall(
  client: any,
  meta: ConnectorCallMeta,
  outcome: ConnectorCallOutcome,
): Promise<void> {
  try {
    const { error } = await client.from("connector_call_logs").insert(
      ledgerRow(meta, outcome),
    );
    if (error) logLedgerFailure(meta, error);
  } catch (error) {
    logLedgerFailure(meta, error);
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "connector_failure";
}

/**
 * What counts as an abort, decided once for every door. `AbortController`
 * aborts throw AbortError; `AbortSignal.timeout` throws TimeoutError.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError");
}

function failureOutcome(
  error: unknown,
  latencyMs: number,
): ConnectorCallOutcome {
  if (error instanceof ConnectorRefusal) {
    return { status: "refused", errorCode: error.code, latencyMs };
  }
  if (isAbortError(error)) {
    return { status: "timeout", errorCode: "connector_timeout", latencyMs };
  }
  return { status: "failed", errorCode: errorCode(error), latencyMs };
}

export async function withConnectorCall<T>(
  client: any,
  meta: ConnectorCallMeta,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { timeoutMs: number; now?: () => number },
): Promise<T> {
  const now = opts.now ?? performance.now.bind(performance);
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const value = await fn(controller.signal);
    await recordConnectorCall(client, meta, {
      status: "success",
      latencyMs: now() - startedAt,
    });
    return value;
  } catch (error) {
    await recordConnectorCall(
      client,
      meta,
      failureOutcome(error, now() - startedAt),
    );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function accountWorkspace(
  client: any,
  socialAccountId: string,
  userId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("social_accounts")
    .select("workspace_id")
    .eq("id", socialAccountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("workspace_lookup_failed");
  return data?.workspace_id ?? null;
}

async function personalWorkspace(
  client: any,
  userId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("workspaces")
    .select("id")
    .eq("owner_id", userId)
    .eq("is_personal", true)
    .maybeSingle();
  if (error) throw new Error("workspace_lookup_failed");
  return data?.id ?? null;
}

/** Spec §4.3 workspace rule: the account's workspace when known, else the owner's personal workspace. Never null: throws only if the owner has no personal workspace, which the 2026-07-26 backfill guarantees exists. */
export async function resolveWorkspaceForCall(
  client: any,
  input: { socialAccountId?: string | null; userId: string },
): Promise<string> {
  const workspaceId = input.socialAccountId
    ? await accountWorkspace(client, input.socialAccountId, input.userId)
    : null;
  if (workspaceId) return workspaceId;

  const fallbackId = await personalWorkspace(client, input.userId);
  if (fallbackId) return fallbackId;
  throw new Error("workspace_unresolved");
}
