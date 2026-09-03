export type ConnectorCallSource = "agent" | "partner" | "test" | "publish";
export type ConnectorCallStatus = "success" | "failed" | "refused" | "timeout";

export interface ConnectorCallMeta {
  workspaceId: string;
  toolId?: string | null;
  connectionId?: string | null;
  socialAccountId?: string | null;
  partnerKeyId?: string | null;
  connectorType: string;
  authStrategy: "manual_credentials" | "composio_oauth";
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

function ledgerRow(meta: ConnectorCallMeta, outcome: ConnectorCallOutcome) {
  return {
    workspace_id: meta.workspaceId,
    tool_id: meta.toolId ?? null,
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

export async function recordConnectorCall(
  client: any,
  meta: ConnectorCallMeta,
  outcome: ConnectorCallOutcome,
): Promise<void> {
  try {
    const { error } = await client.from("connector_call_logs").insert(
      ledgerRow(meta, outcome),
    );
    if (error) console.error("[connector-telemetry] ledger insert failed");
  } catch {
    console.error("[connector-telemetry] ledger insert failed");
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "connector_failure";
}

function failureOutcome(
  error: unknown,
  latencyMs: number,
): ConnectorCallOutcome {
  if (error instanceof ConnectorRefusal) {
    return { status: "refused", errorCode: error.code, latencyMs };
  }
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.message === "AbortError")
  ) {
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
