// POST /v1/tools/execute — headless tool execution (spec §8.2, action
// `execute_tool`, scope `tools:execute`, limiter class C, Idempotency-Key).
//
// AUTHORISATION IS THE AGENT'S OWN, NOT A SECOND OPINION
// -----------------------------------------------------
// A tool is executable through this route iff `resolveToolsForAccount` — the
// resolver `ai-agent-reply` runs — resolves it for the named account, AND the
// key is bound to that account. Nothing else grants access. The alternative,
// a bespoke "may this key run this tool" rule, would be a second answer to a
// question that already has one, and the two would drift: a connector the
// agent stopped offering would keep answering here.
//
// Every refusal answers `tool_not_found` where the fact would otherwise be
// enumerable — an unbound account, an unknown tool id and a tool that exists
// but does not resolve are one response, so a probe learns nothing about which
// of the three it hit (D11).
//
// WHY THIS DOES NOT CALL ai-agent-reply's EXECUTORS
// ------------------------------------------------
// `executeComposioTool`/`executeRoutedCustomTool` are shaped for a language
// model: they return prose, and they hardcode `source: 'agent'` with a null
// `partner_key_id` in the ledger row. This door owes its caller a TYPED
// envelope and owes the ledger `source='partner'` with the key id (D5), so it
// performs the same gates and the same calls itself. The gates are the ones
// spec §7.2 fixes and `ai-agent-reply/composioExecution.ts` implements for the
// agent door — registry allow-list, then `allow_writes` for a mutating slug —
// and the two are meant to be read side by side. `isAdmin` has no partner
// analogue: a key is not a person, so only the tool owner's `allow_writes`
// can open a write.
//
// THE BUDGET
// ----------
// 20 s (spec §8.2), against the agent door's 6 s. A partner is waiting on an
// HTTP response with its own client timeout, not composing a reply inside a
// 60 s worker with four more model calls to make.

import {
  ComposioError,
  composioClientFromEnv,
  type ComposioClient,
} from "../../_shared/composioClient.ts";
import { loadActiveConnection } from "../../_shared/composioConnections.ts";
import {
  composioBinding,
  type ComposioBinding,
  connectorCapabilities,
  shouldUseAdapter,
} from "../../_shared/connectorRegistry.ts";
import {
  recordConnectorCall,
  withConnectorCall,
  type ConnectorCallMeta,
} from "../../_shared/connectorTelemetry.ts";
import {
  claimIdempotency,
  completeIdempotency,
  hashRequest,
  markIndeterminate,
} from "../../_shared/partnerApiIdempotency.ts";
import {
  resolveToolsForAccount,
  type ToolAccountLink,
} from "../../_shared/toolResolution.ts";
import { TOOL_COLUMNS, type OwnedTool } from "./connectors.ts";
import { v1ErrorBody, v1ErrorResponse, type V1ErrorCode } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";
import type { V1AuthedContext } from "./authenticated.ts";

/** Spec §8.2. Deliberately larger than the agent door's 6 s and smaller than
 *  the publish door's 50 s; see the header. */
export const PARTNER_TOOL_TIMEOUT_MS = 20_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The refusal codes this route can raise, all of which are also /v1 codes. */
type RefusalCode = Extract<
  V1ErrorCode,
  | "connection_inactive"
  | "connector_tool_not_allowed"
  | "connector_unavailable"
  | "connector_write_not_allowed"
  | "tool_not_found"
>;

interface ExecuteInput {
  toolId: string;
  socialAccountId: string;
  capability: string;
  parameters: Record<string, unknown>;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

/** The failure of a call that actually ran. Carries no vendor text: spec §11
 *  forbids a provider body reaching a partner, and the ledger's `error_code`
 *  is what an operator reads instead. */
class ToolExecutionFailure extends Error {
  readonly code = "tool_execution_failed";
  constructor() {
    super("tool_execution_failed");
    this.name = "ToolExecutionFailure";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "AbortError" || error.message === "AbortError");
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

type Resolution =
  | { ok: true; tool: OwnedTool; ownerId: string }
  | { ok: false; internal: true }
  | { ok: false; internal: false };

/**
 * The tool this key may run for this account, or nothing.
 *
 * Three predicates, in the order that keeps each one cheap: the key's binding
 * to the account, the account's membership of the key's workspace ("tenancy is
 * proven twice", binding.ts), and then the resolver.
 */
async function resolveExecutableTool(
  authed: V1AuthedContext,
  input: ExecuteInput,
): Promise<Resolution> {
  const { admin, record, requestId } = authed;

  const { data: bindingRows, error: bindingError } = await admin
    .from("partner_api_key_accounts")
    .select("social_account_id")
    .eq("key_id", record.id)
    .eq("workspace_id", record.workspaceId)
    .eq("social_account_id", input.socialAccountId);
  if (bindingError) {
    console.error(`[partner-api] tool binding lookup failed (request ${requestId}):`, bindingError);
    return { ok: false, internal: true };
  }
  if ((bindingRows ?? []).length === 0) return { ok: false, internal: false };

  const { data: accountRow, error: accountError } = await admin
    .from("social_accounts")
    .select("id, user_id")
    .eq("id", input.socialAccountId)
    .eq("workspace_id", record.workspaceId)
    .maybeSingle();
  if (accountError) {
    console.error(`[partner-api] tool account lookup failed (request ${requestId}):`, accountError);
    return { ok: false, internal: true };
  }
  if (!accountRow) return { ok: false, internal: false };
  const ownerId = accountRow.user_id as string;

  const { data: toolRows, error: toolsError } = await admin
    .from("ai_agent_tools")
    .select(TOOL_COLUMNS)
    .eq("user_id", ownerId)
    .eq("is_enabled", true);
  if (toolsError) {
    console.error(`[partner-api] tool fetch failed (request ${requestId}):`, toolsError);
    return { ok: false, internal: true };
  }

  const { data: linkRows, error: linksError } = await admin
    .from("ai_agent_tool_accounts")
    .select("tool_id, social_account_id")
    .eq("user_id", ownerId)
    .eq("social_account_id", input.socialAccountId);
  if (linksError) {
    console.error(`[partner-api] tool link fetch failed (request ${requestId}):`, linksError);
    return { ok: false, internal: true };
  }

  const resolution = resolveToolsForAccount(
    (toolRows ?? []) as OwnedTool[],
    (linkRows ?? []) as ToolAccountLink[],
    input.socialAccountId,
    // A partner key is not a verified admin and can never be one.
    { includeAdminOnly: false },
  );
  const tool = resolution.tools.find((candidate) => candidate.id === input.toolId);
  return tool
    ? { ok: true, tool: tool as OwnedTool, ownerId }
    : { ok: false, internal: false };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecutionDeps {
  fetch: typeof fetch;
  getEnv: (name: string) => string | undefined;
}

/** Where the adapter lives, resolved once BEFORE the idempotency claim so an
 *  unconfigured deployment refuses without consuming the partner's key. */
interface AdapterTarget {
  supabaseUrl: string;
  serviceRoleKey: string;
}

/** The one place the adapter's internal contract is spelled for this door. It
 *  is the shape `ai-agent-reply/connectorExecution.ts` sends, because the
 *  adapter has exactly one contract and two callers. */
async function runAdapterTool(
  target: AdapterTarget,
  tool: OwnedTool,
  ownerId: string,
  input: ExecuteInput,
  signal: AbortSignal,
  deps: ExecutionDeps,
): Promise<unknown> {
  // SUPABASE_URL is the in-cluster gateway; the public hostname would add
  // Cloudflare in front of an internal call and mask origin failures.
  const serviceRoleKey = target.serviceRoleKey;
  const response = await deps.fetch(
    `${target.supabaseUrl.replace(/\/+$/, "")}/functions/v1/ai-agent-adapters`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      body: JSON.stringify({
        tool_id: tool.id,
        // The TOOL's owner, never the partner: the adapter resolves the tool's
        // Vault credentials by (tool_id, user_id), and a key has no user.
        user_id: ownerId,
        action: "execute",
        capability: input.capability,
        parameters: input.parameters,
      }),
      signal,
    },
  );
  if (!response.ok) throw new ToolExecutionFailure();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ToolExecutionFailure();
  }
  if (!isRecord(payload) || typeof payload.ok !== "boolean" || payload.ok === false) {
    // A 200 carrying `{ok:false}` is a failure; treating `response.ok` as the
    // verdict is how a failed call gets reported as a delivered one.
    throw new ToolExecutionFailure();
  }
  return Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
}

/** The Composio call itself. Its gates are evaluated by the route, before the
 *  idempotency claim — see the refusal block there. */
async function runComposioTool(
  client: ComposioClient,
  binding: ComposioBinding,
  workspaceId: string,
  connectedAccountId: string,
  input: ExecuteInput,
  signal: AbortSignal,
): Promise<unknown> {
  let result: { successful: boolean; data: unknown; error?: string };
  try {
    result = await client.executeTool({
      slug: input.capability,
      version: binding.toolkitVersion,
      workspaceId,
      connectedAccountId,
      arguments: input.parameters,
      signal,
    });
  } catch (error) {
    // The REST client turns an aborted fetch into ComposioError("composio_timeout");
    // re-surfacing it as an abort keeps the ledger row's status honest
    // (`timeout`, not `failed`) and the response a 504 rather than a 502.
    if (error instanceof ComposioError && error.code === "composio_timeout") {
      throw new DOMException("Aborted", "AbortError");
    }
    throw error;
  }
  if (!result.successful) throw new ToolExecutionFailure();
  return result.data;
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

export async function executeTool(
  req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const runtime: ExecutionDeps = {
    fetch: (input, init) => fetch(input, init),
    getEnv: (name) => Deno.env.get(name),
  };

  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) return v1ErrorResponse("missing_idempotency_key", requestId);

  const body = await req.json().catch(() => null);
  if (!isRecord(body)) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "A JSON body is required",
    });
  }
  // A malformed id answers as an unknown one — the same rule ids.ts states for
  // prefixed ids, applied to the raw UUIDs this route takes.
  const toolId = typeof body.tool_id === "string" && UUID_PATTERN.test(body.tool_id)
    ? body.tool_id
    : null;
  const socialAccountId =
    typeof body.social_account_id === "string" && UUID_PATTERN.test(body.social_account_id)
      ? body.social_account_id
      : null;
  if (toolId === null || socialAccountId === null) {
    return v1ErrorResponse("tool_not_found", requestId);
  }
  if (typeof body.capability !== "string" || body.capability.length === 0) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "`capability` must be a non-empty string",
    });
  }
  if (body.parameters !== undefined && !isRecord(body.parameters)) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "`parameters` must be an object",
    });
  }
  const input: ExecuteInput = {
    toolId,
    socialAccountId,
    capability: body.capability,
    parameters: isRecord(body.parameters) ? body.parameters : {},
  };

  /** Spec §11: every refusal leaves a row. */
  const refuse = async (
    code: RefusalCode,
    meta: Pick<ConnectorCallMeta, "toolId" | "connectionId" | "connectorType" | "authStrategy">,
  ): Promise<Response> => {
    await recordConnectorCall(admin, {
      workspaceId: record.workspaceId,
      socialAccountId: input.socialAccountId,
      partnerKeyId: record.id,
      actionName: input.capability,
      source: "partner",
      requestId,
      ...meta,
    }, { status: "refused", errorCode: code });
    return v1ErrorResponse(code, requestId);
  };

  const resolved = await resolveExecutableTool(authed, input);
  if (!resolved.ok) {
    if (resolved.internal) return v1ErrorResponse("internal_error", requestId);
    // Nothing about the tool is known here, and nothing is looked up to find
    // out — see the `"unknown"` note on ConnectorCallMeta.authStrategy.
    return await refuse("tool_not_found", {
      toolId: null,
      connectionId: null,
      connectorType: "unknown",
      authStrategy: "unknown",
    });
  }
  const { tool, ownerId } = resolved;
  const isComposio = tool.auth_strategy === "composio_oauth";
  const ledgerBase = {
    toolId: tool.id,
    connectorType: tool.connector_type,
    authStrategy: isComposio ? "composio_oauth" as const : "manual_credentials" as const,
  };

  // EVERY GATE RUNS BEFORE THE IDEMPOTENCY CLAIM.
  //
  // Each refusal below is deterministic — the same request will meet it again
  // — so none of them may consume the caller's Idempotency-Key. A claim taken
  // and then abandoned holds the key `processing` for its whole lease, and the
  // partner's next attempt with the SAME key (the correct thing to do) answers
  // `idempotency_in_progress` for five minutes instead of the real reason.
  //
  // The Composio gates are the ones spec §7.2 fixes, in its order: the registry
  // allow-list, then `allow_writes` for a mutating slug, then the connection.
  let execute: (signal: AbortSignal) => Promise<unknown>;
  let ledgerConnectionId: string | null = null;
  if (isComposio) {
    const binding = composioBinding(tool.connector_type);
    if (!binding || !binding.tools.includes(input.capability)) {
      return await refuse("connector_tool_not_allowed", { ...ledgerBase, connectionId: null });
    }
    if (binding.mutating.includes(input.capability) && tool.settings?.allow_writes !== true) {
      return await refuse("connector_write_not_allowed", { ...ledgerBase, connectionId: null });
    }
    if (!tool.connection_id) {
      return await refuse("connection_inactive", { ...ledgerBase, connectionId: null });
    }
    const lookup = await loadActiveConnection(admin, tool.connection_id, record.workspaceId);
    if (!lookup.ok) {
      // A connection in ANOTHER workspace is 404, not 409: 409 would confirm
      // the id exists somewhere (spec §11). Its id stays out of the ledger row
      // too — this workspace's ledger must not carry another's connection.
      const code: RefusalCode = lookup.code === "connection_inactive"
        ? "connection_inactive"
        : "tool_not_found";
      return await refuse(code, { ...ledgerBase, connectionId: null });
    }
    const client = composioClientFromEnv(runtime.getEnv);
    if (!client) {
      return await refuse("connector_unavailable", {
        ...ledgerBase,
        connectionId: lookup.connection.id,
      });
    }
    ledgerConnectionId = lookup.connection.id;
    const connectedAccountId = lookup.connection.composioConnectedAccountId;
    execute = (signal) =>
      runComposioTool(client, binding, record.workspaceId, connectedAccountId, input, signal);
  } else {
    if (!shouldUseAdapter(tool)) {
      // A tool with no adapter is an arbitrary partner-configured webhook. The
      // agent door calls those with a model in the loop; a headless key must
      // not, so this route serves only connectors with a typed capability
      // contract.
      return await refuse("connector_tool_not_allowed", { ...ledgerBase, connectionId: null });
    }
    if (
      !(connectorCapabilities(tool.connector_type) ?? []).some(
        (capability) => capability.name === input.capability,
      )
    ) {
      return await refuse("connector_tool_not_allowed", { ...ledgerBase, connectionId: null });
    }
    const supabaseUrl = runtime.getEnv("SUPABASE_URL");
    const serviceRoleKey = runtime.getEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return await refuse("connector_unavailable", { ...ledgerBase, connectionId: null });
    }
    execute = (signal) =>
      runAdapterTool({ supabaseUrl, serviceRoleKey }, tool, ownerId, input, signal, runtime);
  }

  const claim = await claimIdempotency(
    admin,
    record.id,
    idempotencyKey,
    await hashRequest({
      action: "execute_tool",
      tool_id: input.toolId,
      social_account_id: input.socialAccountId,
      capability: input.capability,
      parameters: input.parameters,
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

  const startedAt = performance.now();
  try {
    const data = await withConnectorCall(
      admin,
      {
        workspaceId: record.workspaceId,
        ...ledgerBase,
        connectionId: ledgerConnectionId,
        socialAccountId: input.socialAccountId,
        partnerKeyId: record.id,
        actionName: input.capability,
        source: "partner",
        requestId,
      },
      execute,
      { timeoutMs: PARTNER_TOOL_TIMEOUT_MS },
    );
    const responseBody = {
      ok: true,
      data,
      request_id: requestId,
      latency_ms: Math.round(performance.now() - startedAt),
    };
    await completeIdempotency(admin, record.id, idempotencyKey, claim.attemptToken, 200, responseBody);
    return v1JsonResponse(responseBody, requestId);
  } catch (error) {
    if (isAbortError(error)) {
      // The side effect may or may not have happened. `indeterminate` is the
      // one state no retry re-executes from, which is the right answer for a
      // call that might already have changed a customer's CRM.
      await markIndeterminate(admin, record.id, idempotencyKey, claim.attemptToken)
        .catch((markError) =>
          console.error(`[partner-api] indeterminate mark failed (request ${requestId}):`, markError)
        );
      return v1ErrorResponse("tool_execution_timeout", requestId);
    }
    // Everything else is a definite failure of a call that ran: settle it, so a
    // retry with the same key replays the 502 rather than executing again.
    if (!(error instanceof ToolExecutionFailure) && !(error instanceof ComposioError)) {
      console.error(`[partner-api] tool execution error (request ${requestId}):`, error);
    }
    // The stored body is the envelope this attempt returned, replayed verbatim
    // like every other stored outcome — so it carries the request id of the
    // attempt that actually ran, which is the one an operator needs to look up.
    const failureBody = v1ErrorBody("tool_execution_failed", requestId);
    await completeIdempotency(
      admin,
      record.id,
      idempotencyKey,
      claim.attemptToken,
      502,
      failureBody,
    ).catch((settleError) =>
      console.error(`[partner-api] settle after failure failed (request ${requestId}):`, settleError)
    );
    return v1ErrorResponse("tool_execution_failed", requestId);
  }
}
