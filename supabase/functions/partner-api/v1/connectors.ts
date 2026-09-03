// The /v1 connectors surface (spec §8.2):
//
//   GET  /v1/connectors                        list_connectors     (connectors:read,   class A)
//   POST /v1/connectors/{type}/connect-link    create_connect_link (connectors:manage, class C, Idempotency-Key)
//
// WHAT A KEY CAN SEE, AND WHY IT IS THE AGENT'S OWN ANSWER
// -------------------------------------------------------
// The listing is not a query over `ai_agent_tools`. It is
// `resolveToolsForAccount` — the SAME resolver `ai-agent-reply` runs to decide
// what a conversation may call — evaluated once per bound account and unioned
// by tool id. That is deliberate: if the partner door had its own idea of
// "visible", a tool could be listed here and refused by `POST /v1/tools/execute`
// (or worse, the reverse), and the two answers would drift a rule at a time.
// One resolver, two callers.
//
// `includeAdminOnly` is false, always. An admin-only connector is one a
// verified admin reaches inside a conversation; a partner key is not a person
// and can never be that admin.
//
// USAGE COUNTS ARE READ DIRECTLY, NOT THROUGH workspace_connector_usage
// ---------------------------------------------------------------------
// That RPC's gate is `auth.uid()`, which is NULL under the service role the
// partner door runs as — it would return nothing, every time, and look exactly
// like a workspace that has never made a call. So the ledger is read directly
// and aggregated here, scoped by `workspace_id` and the tool ids this key can
// already see. The partner door is service-role and structurally scoped, as
// every /v1 read is (binding.ts, "tenancy is proven twice").
//
// WHAT NEVER LEAVES THIS MODULE
// -----------------------------
// `composio_connected_account_id`, `composio_auth_config_id`, and any
// connection id — spec §11. The connection is rendered as its STATE and its
// human label only; a partner that needs to act on it uses the connect-link
// route, which mints its own id.

import {
  ComposioInitiateError,
  composioInitiateDependencies,
  initiateComposioConnection,
} from "../../_shared/composioInitiate.ts";
import {
  CONNECTOR_TYPES,
  connectorDefinition,
  isComposioType,
} from "../../_shared/connectorRegistry.ts";
import { recordConnectorCall } from "../../_shared/connectorTelemetry.ts";
import {
  claimIdempotency,
  completeIdempotency,
  hashRequest,
} from "../../_shared/partnerApiIdempotency.ts";
import {
  resolveToolsForAccount,
  type ResolvableTool,
  type ToolAccountLink,
} from "../../_shared/toolResolution.ts";
import { boundAccountIds } from "./binding.ts";
import { v1ErrorResponse } from "./errors.ts";
import { v1Collection, v1JsonResponse } from "./respond.ts";
import type { V1AuthedContext } from "./authenticated.ts";

/** The reporting window, in days. Fixed rather than a query parameter: the
 *  ledger's own retention is 90 days, and a partner that could ask for an
 *  arbitrary window could ask for one this route cannot answer. */
export const USAGE_WINDOW_DAYS = 30;

/**
 * The most ledger rows one listing aggregates.
 *
 * A class-A read must stay bounded (D7), and an unbounded `SELECT` over a busy
 * workspace's 30-day ledger is not. The cap is applied to the MOST RECENT rows,
 * so a workspace past it reports its latest activity rather than an arbitrary
 * slice — and the contract says so, in `docs/api/openapi.yaml`, rather than
 * presenting a truncated count as a complete one.
 */
export const USAGE_ROW_CAP = 10_000;

/** The columns `resolveToolsForAccount` needs, exactly as `ai-agent-reply`
 *  selects them. `settings` holds no secret (credentials live in Vault); it is
 *  read for `allow_writes`, which POST /v1/tools/execute gates on. */
export const TOOL_COLUMNS =
  "id, user_id, name, description, url, admin_only, scope, social_account_id, " +
  "connector_type, settings, auth_strategy, connection_id";

/** A tool row with the owning login, which `ResolvableTool` does not carry and
 *  both the per-account filter here and the adapter call in tools.ts need. */
export interface OwnedTool extends ResolvableTool {
  user_id: string;
}

interface ConnectionSummary {
  status: string;
  external_account_label: string | null;
}

interface UsageSummary {
  calls: number;
  failures: number;
  p50_latency_ms: number | null;
  last_used_at: string | null;
}

interface LedgerRow {
  tool_id: string | null;
  status: string;
  latency_ms: number | null;
  created_at: string;
}

/** The registry's category for a type, or null for a row whose type predates
 *  the registry. Non-throwing on purpose: an unknown type is a listing with
 *  one null field, not a 500 for the whole page. */
function categoryOf(connectorType: string): string | null {
  return (CONNECTOR_TYPES as readonly string[]).includes(connectorType)
    ? connectorDefinition(connectorType).category
    : null;
}

/**
 * `percentile_cont(0.5)`, the same definition `workspace_connector_usage` uses
 * in SQL, so the number a partner reads and the number the Hub shows for the
 * same window are the same number rather than two plausible ones.
 */
export function medianLatency(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = 0.5 * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const interpolated = lower === upper
    ? sorted[lower]!
    : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
  return Math.round(interpolated);
}

/** One summary per tool id, over the rows the caller already scoped. */
export function summarizeUsage(rows: LedgerRow[]): Map<string, UsageSummary> {
  const latencies = new Map<string, number[]>();
  const summaries = new Map<string, UsageSummary>();
  for (const row of rows) {
    if (!row.tool_id) continue;
    const summary = summaries.get(row.tool_id) ??
      { calls: 0, failures: 0, p50_latency_ms: null, last_used_at: null };
    summary.calls += 1;
    // `refused` is not a failure of the connector — it is Postora declining to
    // make the call. Counting it as one would make a correctly-configured
    // workspace look broken.
    if (row.status === "failed" || row.status === "timeout") summary.failures += 1;
    if (summary.last_used_at === null || row.created_at > summary.last_used_at) {
      summary.last_used_at = row.created_at;
    }
    summaries.set(row.tool_id, summary);
    if (typeof row.latency_ms === "number") {
      const bucket = latencies.get(row.tool_id) ?? [];
      bucket.push(row.latency_ms);
      latencies.set(row.tool_id, bucket);
    }
  }
  for (const [toolId, summary] of summaries) {
    summary.p50_latency_ms = medianLatency(latencies.get(toolId) ?? []);
  }
  return summaries;
}

const EMPTY_USAGE: UsageSummary = {
  calls: 0,
  failures: 0,
  p50_latency_ms: null,
  last_used_at: null,
};

// ---------------------------------------------------------------------------
// GET /v1/connectors
// ---------------------------------------------------------------------------

export async function listConnectors(
  _req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;
  // An unbound key reads nothing — the fail-closed direction binding.ts
  // establishes, restated here because "no accounts" is also the cheapest exit.
  if (bound.ids.length === 0) return v1Collection([], null, requestId);

  // The OWNERS of the bound accounts. `ai_agent_tools` is keyed by user, not by
  // workspace, so the tool query has to be scoped by the owning login; the
  // workspace predicate here is what proves those logins are this key's.
  const { data: accountRows, error: accountsError } = await admin
    .from("social_accounts")
    .select("id, user_id")
    .in("id", bound.ids)
    .eq("workspace_id", record.workspaceId);
  if (accountsError) {
    console.error(`[partner-api] connector account fetch failed (request ${requestId}):`, accountsError);
    return v1ErrorResponse("internal_error", requestId);
  }
  const accounts = (accountRows ?? []) as { id: string; user_id: string }[];
  if (accounts.length === 0) return v1Collection([], null, requestId);
  const owners = [...new Set(accounts.map((a) => a.user_id))];

  const { data: toolRows, error: toolsError } = await admin
    .from("ai_agent_tools")
    .select(TOOL_COLUMNS)
    .in("user_id", owners)
    .eq("is_enabled", true);
  if (toolsError) {
    console.error(`[partner-api] connector tool fetch failed (request ${requestId}):`, toolsError);
    return v1ErrorResponse("internal_error", requestId);
  }
  const tools = (toolRows ?? []) as OwnedTool[];

  const { data: linkRows, error: linksError } = await admin
    .from("ai_agent_tool_accounts")
    .select("tool_id, social_account_id")
    .in("user_id", owners)
    .in("social_account_id", accounts.map((a) => a.id));
  if (linksError) {
    // Not degradable, unlike the reply path: a listing that silently omitted
    // every explicitly shared connector would read as "you have none", and the
    // partner would build against a shorter list than they actually have.
    console.error(`[partner-api] connector link fetch failed (request ${requestId}):`, linksError);
    return v1ErrorResponse("internal_error", requestId);
  }
  const links = (linkRows ?? []) as ToolAccountLink[];

  // The resolver, once per account, unioned by tool id. Two accounts sharing
  // one all_accounts tool therefore produce one entry.
  const visible = new Map<string, ResolvableTool>();
  for (const account of accounts) {
    // Only the OWNER's tools are candidates for that owner's account. The
    // `.in("user_id", owners)` above already keeps other tenants out; this is
    // the second predicate that keeps two owners inside ONE workspace from
    // resolving each other's connectors.
    const resolution = resolveToolsForAccount(
      tools.filter((tool) => tool.user_id === account.user_id),
      links.filter((link) => link.social_account_id === account.id),
      account.id,
      { includeAdminOnly: false },
    );
    for (const tool of resolution.tools) {
      if (!visible.has(tool.id)) visible.set(tool.id, tool);
    }
  }
  const listed = [...visible.values()].sort((a, b) =>
    a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name)
  );
  if (listed.length === 0) return v1Collection([], null, requestId);

  // Connection state, scoped by workspace for the reason at the top of
  // binding.ts. Only the two partner-safe columns are selected — a `select("*")`
  // here is how a Composio id reaches a partner.
  const connectionIds = [
    ...new Set(listed.map((tool) => tool.connection_id).filter((id): id is string => !!id)),
  ];
  const connections = new Map<string, ConnectionSummary>();
  if (connectionIds.length > 0) {
    const { data: connectionRows, error: connectionsError } = await admin
      .from("connector_connections")
      .select("id, status, external_account_label")
      .in("id", connectionIds)
      .eq("workspace_id", record.workspaceId);
    if (connectionsError) {
      console.error(`[partner-api] connection fetch failed (request ${requestId}):`, connectionsError);
      return v1ErrorResponse("internal_error", requestId);
    }
    for (const row of (connectionRows ?? []) as Record<string, unknown>[]) {
      connections.set(String(row.id), {
        status: String(row.status),
        external_account_label: (row.external_account_label as string | null) ?? null,
      });
    }
  }

  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: ledgerRows, error: ledgerError } = await admin
    .from("connector_call_logs")
    .select("tool_id, status, latency_ms, created_at")
    .eq("workspace_id", record.workspaceId)
    .in("tool_id", listed.map((tool) => tool.id))
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(USAGE_ROW_CAP);
  if (ledgerError) {
    console.error(`[partner-api] connector usage fetch failed (request ${requestId}):`, ledgerError);
    return v1ErrorResponse("internal_error", requestId);
  }
  const usage = summarizeUsage((ledgerRows ?? []) as LedgerRow[]);

  const data = listed.map((tool) => ({
    tool_id: tool.id,
    name: tool.name,
    connector_type: tool.connector_type,
    auth_strategy: tool.auth_strategy ?? "manual_credentials",
    category: categoryOf(tool.connector_type),
    scope: tool.scope,
    social_account_id: tool.social_account_id ?? null,
    connection: tool.connection_id ? connections.get(tool.connection_id) ?? null : null,
    usage_30d: usage.get(tool.id) ?? EMPTY_USAGE,
  }));

  // No cursor: the page is the key's own bound tool set, which BOUND_ACCOUNT_FILTER_MAX
  // already bounds. `next_cursor` is still emitted, and null, so a partner's
  // paging loop terminates the same way it does on every other listing.
  return v1Collection(data, null, requestId);
}

// ---------------------------------------------------------------------------
// POST /v1/connectors/{type}/connect-link
// ---------------------------------------------------------------------------

/** The `{type}` segment arrives URL-encoded and unvalidated. */
function decodeConnectorType(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return /^[a-z0-9_]{1,64}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export async function createConnectLink(
  req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) return v1ErrorResponse("missing_idempotency_key", requestId);

  // Refused BEFORE the claim: a request that can never succeed must not consume
  // the partner's key for five minutes, and a malformed type is exactly that.
  const connectorType = decodeConnectorType(params.type ?? "");
  if (connectorType === null || !isComposioType(connectorType)) {
    return v1ErrorResponse("connector_type_not_connectable", requestId);
  }

  const body = await req.json().catch(() => null);
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "A JSON object body is required",
    });
  }
  const payload = (body ?? {}) as Record<string, unknown>;

  // `social_account_id` is optional and does not change what is minted — the
  // connection is workspace-scoped (spec D2). It is still VERIFIED rather than
  // ignored: silently accepting an id outside the key's binding would teach a
  // prober that the id is harmless, and answering 404 teaches nothing.
  let socialAccountId: string | null = null;
  if (payload.social_account_id !== undefined && payload.social_account_id !== null) {
    if (typeof payload.social_account_id !== "string") {
      return v1ErrorResponse("resource_not_found", requestId);
    }
    socialAccountId = payload.social_account_id;
    const { data: bindingRows, error: bindingError } = await admin
      .from("partner_api_key_accounts")
      .select("social_account_id")
      .eq("key_id", record.id)
      .eq("workspace_id", record.workspaceId)
      .eq("social_account_id", socialAccountId);
    if (bindingError) {
      console.error(`[partner-api] connect-link binding lookup failed (request ${requestId}):`, bindingError);
      return v1ErrorResponse("internal_error", requestId);
    }
    if ((bindingRows ?? []).length === 0) {
      return v1ErrorResponse("resource_not_found", requestId);
    }
  }

  const claim = await claimIdempotency(
    admin,
    record.id,
    idempotencyKey,
    await hashRequest({
      action: "create_connect_link",
      connector_type: connectorType,
      social_account_id: socialAccountId,
    }),
  );
  if (claim.outcome === "conflict") return v1ErrorResponse("idempotency_conflict", requestId);
  if (claim.outcome === "in_progress") return v1ErrorResponse("idempotency_in_progress", requestId);
  if (claim.outcome === "indeterminate") {
    return v1ErrorResponse("idempotency_indeterminate", requestId);
  }
  if (claim.outcome === "replay") {
    const replayed = v1JsonResponse(claim.body, requestId, claim.httpStatus);
    replayed.headers.set("Idempotency-Replayed", "true");
    return replayed;
  }

  // Attribution: the human who created the key, so a connection minted through
  // the API is traceable to a person the way one minted in the app is. Read
  // here rather than carried on PartnerKeyRecord — the authentication record is
  // the smallest thing every route needs, and this is one route's need.
  const { data: keyRow, error: keyError } = await admin
    .from("partner_api_keys")
    .select("created_by")
    .eq("id", record.id)
    .eq("workspace_id", record.workspaceId)
    .maybeSingle();
  if (keyError) {
    // Said, not swallowed: a failed read would otherwise write initiated_by
    // null and look exactly like a key with no creator.
    console.error(`[partner-api] connect-link key lookup failed (request ${requestId}):`, keyError);
    return v1ErrorResponse("internal_error", requestId);
  }

  try {
    const link = await initiateComposioConnection(
      composioInitiateDependencies(admin),
      {
        // Spec D2: server-side, from the authenticated key. Never a body field.
        workspaceId: record.workspaceId,
        connectorType,
        initiatedBy: (keyRow?.created_by as string | undefined) ?? null,
      },
      { source: "partner", partnerKeyId: record.id, requestId },
    );

    // The success half of the ledger. The shared initiate writes refusals and
    // failures (both doors need those); only the partner door is required by
    // §8.2 to record the success, so it is recorded where that requirement is.
    await recordConnectorCall(admin, {
      workspaceId: record.workspaceId,
      connectionId: link.connection_id,
      partnerKeyId: record.id,
      connectorType,
      authStrategy: "composio_oauth",
      actionName: "connect_link",
      source: "partner",
      requestId,
    }, { status: "success" });

    await completeIdempotency(admin, record.id, idempotencyKey, claim.attemptToken, 201, link);
    return v1JsonResponse(link, requestId, 201);
  } catch (error) {
    if (error instanceof ComposioInitiateError) {
      // Deliberately NOT settled. Every code reachable here is retryable, and a
      // settled claim would replay the failure forever — a partner that fixed
      // the underlying problem would keep reading the old 503. The claim's
      // lease expires instead, and the same key works again afterwards; a
      // partner needing a link sooner uses a new key. The connection row, if
      // one was created, is already `failed` with its nonce cleared, so nothing
      // half-created stays completable.
      // The type was already proven connectable before the claim, so the only
      // code that reaches here is connector_unavailable.
      return v1ErrorResponse("connector_unavailable", requestId);
    }
    throw error;
  }
}
