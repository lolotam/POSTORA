import { shouldUseAdapter } from "../_shared/connectorRegistry.ts";
import {
  ADAPTER_CALL_TIMEOUT_MS,
  SUPABASE_CALL_TIMEOUT_MS,
} from "../_shared/connectorBudgets.ts";
import {
  recordConnectorCall,
  resolveWorkspaceForCall,
} from "../_shared/connectorTelemetry.ts";
import {
  executeCustomTool,
  type CustomTool,
  type ToolContext,
  type ToolResult,
} from "./tools.ts";
import {
  executeComposioTool,
  type ComposioExecutionDependencies,
} from "./composioExecution.ts";
import type { ComposioReadyTool } from "./composioTools.ts";

// The adapter gives its vendor 10s. At five tool iterations, a 6s reply-side
// deadline caps adapter waiting at 30s of the 60s worker lifetime, leaving the
// other half for model calls and final logging. It wraps the full internal call,
// so the reply and vendor deadlines are not additive.
// C8: these stay in _shared so the separately deployed adapters function can
// read the same numbers without importing this module's graph.
export {
  ADAPTER_CALL_TIMEOUT_MS,
  SUPABASE_CALL_TIMEOUT_MS,
} from "../_shared/connectorBudgets.ts";
// 8000 characters (~2000 tokens). 2000 was tuned for one-product answers and
// silently cut a whole-catalog result mid-JSON: the Supabase adapter returns
// per-cell-trimmed rows at up to ~290 characters each, so a 25-row table needs the
// larger allowance, and a truncated table is answered by the model FILLING THE
// GAPS from stale indexed knowledge -- confidently, and wrong (2026-09-01).
// The prompt already runs 4-13k tokens; this is a bounded, deliberate spend.
// C8: unchanged for every vendor; the Supabase-specific cap is separate.
export const ADAPTER_OUTPUT_LIMIT = 8000;
// The Supabase adapter enforces its own 60k character budget on a row boundary
// and reports `truncated_by`, so this backstop only needs to sit above it.
export const SUPABASE_ADAPTER_OUTPUT_LIMIT = 80_000;

/**
 * C8: vendor-aware. The ceiling a tool call may spend on its adapter, clamped
 * to the request's REMAINING model budget. The agent's model budget is elapsed
 * time (logic.ts subtracts now - startedAt), not a fresh allowance per call, so
 * a tool call late in a conversation must shrink rather than assume the full
 * ceiling, or it overruns the worker and the customer gets nothing.
 */
export function adapterCallBudget(connectorType: string, remainingMs: number): number {
  const ceiling = connectorType === "supabase" ? SUPABASE_CALL_TIMEOUT_MS : ADAPTER_CALL_TIMEOUT_MS;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.min(ceiling, Math.trunc(remainingMs));
}

/** The snake_case row _shared/connectorTelemetry.ts inserts; asserted in tests. */
export interface ConnectorCallRow {
  workspace_id: string;
  tool_id: string | null;
  connection_id: string | null;
  social_account_id: string | null;
  partner_key_id: string | null;
  connector_type: string;
  auth_strategy: string;
  action_name: string;
  source: string;
  status: string;
  error_code: string | null;
  request_id: string | null;
  latency_ms: number | null;
}

interface AdapterCallDependencies {
  fetch?: typeof fetch;
  getEnv?: (name: string) => string | undefined;
  timeoutMs?: number;
  /** Milliseconds the request still has left; shrinks the call's deadline. */
  remainingBudgetMs?: number;
}

interface RoutedCustomToolDependencies {
  executeAdapter?: typeof executeAdapterTool;
  executeLegacy?: typeof executeCustomTool;
  executeComposio?: typeof executeComposioTool;
  /** Forwarded to the default executeComposioTool (client/admin injection). */
  composio?: ComposioExecutionDependencies;
}

interface AdapterCallConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

interface AdapterRequestInput {
  context: ToolContext;
  tool: CustomTool;
  args: Record<string, unknown>;
  config: AdapterCallConfig;
  signal: AbortSignal;
}

function adapterFailure(toolName: string, detail: string): ToolResult {
  return { output: `Connector "${toolName}" failed via connector adapter: ${detail}` };
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

export function redactKnownSecrets(text: string, secrets: Array<string | null>): string {
  return secrets
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((safe, secret) => safe.replaceAll(secret, "[REDACTED]"), text);
}

function adapterCallConfig(
  getEnv: (name: string) => string | undefined,
): AdapterCallConfig | null {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return supabaseUrl && serviceRoleKey ? { supabaseUrl, serviceRoleKey } : null;
}

function adapterRequest(input: AdapterRequestInput): Request | null {
  const { context, tool, args, config, signal } = input;
  if (typeof args.capability !== "string") return null;
  const parameters = isRecord(args.parameters) ? args.parameters : {};
  return new Request(
    `${config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/ai-agent-adapters`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
      },
      body: JSON.stringify({
        tool_id: tool.id,
        user_id: context.userId,
        action: "execute",
        capability: args.capability,
        parameters,
      }),
      signal,
    },
  );
}

function structuredAdapterResult(
  tool: CustomTool,
  payload: Record<string, unknown>,
  serviceRoleKey: string,
): ToolResult {
  if (payload.ok === false) {
    const connectorError = isRecord(payload.error) ? payload.error : {};
    const vendor = typeof payload.vendor === "string" ? payload.vendor : "connector";
    const code = typeof connectorError.code === "string" ? connectorError.code : "connector_failure";
    const message = typeof connectorError.message === "string"
      ? connectorError.message
      : "The connector request failed.";
    const status = typeof connectorError.vendor_status === "number"
      ? ` (HTTP ${connectorError.vendor_status})`
      : "";
    return {
      output: redactKnownSecrets(
        `Connector "${tool.name}" failed via ${vendor} adapter [${code}]${status}: ${message}`,
        [serviceRoleKey, tool.secret],
      ),
    };
  }

  const connectorPayload = Object.prototype.hasOwnProperty.call(payload, "data")
    ? payload.data
    : payload;
  const serializedPayload = JSON.stringify(connectorPayload);
  if (serializedPayload === undefined) {
    return adapterFailure(tool.name, "adapter returned an invalid response.");
  }
  return {
    output: redactKnownSecrets(
      `Connector "${tool.name}" returned: ${serializedPayload.slice(0, ADAPTER_OUTPUT_LIMIT)}`,
      [serviceRoleKey, tool.secret],
    ),
  };
}

async function readAdapterResult(
  tool: CustomTool,
  response: Response,
  serviceRoleKey: string,
): Promise<ToolResult> {
  if (!response.ok) {
    return adapterFailure(tool.name, `internal request returned HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return adapterFailure(tool.name, "adapter returned an invalid response.");
  }
  return isRecord(payload) && typeof payload.ok === "boolean"
    ? structuredAdapterResult(tool, payload, serviceRoleKey)
    : adapterFailure(tool.name, "adapter returned an invalid response.");
}

export async function executeAdapterTool(
  context: ToolContext,
  tool: CustomTool,
  args: Record<string, unknown>,
  dependencies: AdapterCallDependencies = {},
): Promise<ToolResult> {
  // This precedes env access and request construction because the sandbox must
  // never touch a real connector or Vault-backed execution path.
  if (context.dryRun) {
    return { output: `(test mode — connector adapter not called) Would call "${tool.name}".` };
  }

  const getEnv = dependencies.getEnv ?? ((name: string) => Deno.env.get(name));
  const config = adapterCallConfig(getEnv);
  if (!config) return adapterFailure(tool.name, "connector service is unavailable.");

  const controller = new AbortController();
  const request = adapterRequest({ context, tool, args, config, signal: controller.signal });
  if (!request) return adapterFailure(tool.name, "the requested capability is missing.");

  // MAX_SAFE_INTEGER means "caller did not say", so the vendor's own ceiling
  // applies and existing call sites keep today's behaviour. adapterCallBudget
  // itself maps non-finite input to 0, so the default is resolved here.
  const remainingBudgetMs = dependencies.remainingBudgetMs ?? Number.MAX_SAFE_INTEGER;
  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.timeoutMs ??
      adapterCallBudget(tool.connector_type ?? "custom_rest", remainingBudgetMs),
  );
  try {
    // SUPABASE_URL is the in-cluster gateway; using the public hostname here
    // would add Cloudflare and can replace useful origin failures.
    const response = await (dependencies.fetch ?? fetch)(request);
    return await readAdapterResult(tool, response, config.serviceRoleKey);
  } catch (error) {
    const detail = error instanceof DOMException && error.name === "AbortError"
      ? "request timed out."
      : "internal request failed safely.";
    return adapterFailure(tool.name, detail);
  } finally {
    clearTimeout(timeout);
  }
}

// The adapter and legacy executors report failure in the model-visible output
// rather than by throwing (a thrown error would end the reply), so the ledger
// status is read back from that text. The two prefixes are the ones
// adapterFailure/structuredAdapterResult and executeCustomTool produce.
function outcomeFromOutput(output: string): { status: "success" | "failed" | "timeout"; errorCode: string | null } {
  if (!/^Connector ".*" failed/.test(output)) return { status: "success", errorCode: null };
  if (/timed out/.test(output)) return { status: "timeout", errorCode: "connector_timeout" };
  const bracketed = output.match(/\[([a-z0-9_]+)\]/);
  return { status: "failed", errorCode: bracketed?.[1] ?? "connector_failure" };
}

/**
 * Spec §7.2: native agent executions are metered HERE, where the conversation's
 * account is known, never inside ai-agent-adapters (which meters only the
 * test_connection probe). A workspace that cannot be resolved is said and the
 * call still answers, unmetered — a customer reply must never fail over a
 * ledger row.
 */
async function meterNativeExecution(
  context: ToolContext,
  tool: CustomTool,
  actionName: string,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const startedAt = performance.now();
  const result = await run();
  let workspaceId: string;
  try {
    workspaceId = await resolveWorkspaceForCall(context.admin, {
      socialAccountId: context.socialAccountId,
      userId: context.userId,
    });
  } catch (error) {
    console.error(
      `[ai-agent-reply] connector call unmetered: tool=${tool.id} reason=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return result;
  }
  const outcome = outcomeFromOutput(result.output);
  await recordConnectorCall(context.admin, {
    workspaceId,
    toolId: tool.id,
    connectionId: null,
    socialAccountId: context.socialAccountId,
    partnerKeyId: null,
    connectorType: tool.connector_type ?? "custom_rest",
    authStrategy: "manual_credentials",
    actionName,
    source: "agent",
    requestId: context.requestId,
  }, { ...outcome, latencyMs: performance.now() - startedAt });
  return result;
}

export async function executeRoutedCustomTool(
  context: ToolContext,
  tool: CustomTool,
  args: Record<string, unknown>,
  dependencies: RoutedCustomToolDependencies = {},
  /** The request's remaining model budget, threaded into the adapter call. */
  remainingBudgetMs?: number,
): Promise<ToolResult> {
  // Composio first: executeComposioTool meters itself (refusals included), so
  // wrapping it here would write every call twice.
  if (tool.auth_strategy === "composio_oauth") {
    return await (dependencies.executeComposio ?? executeComposioTool)(
      context,
      tool as ComposioReadyTool,
      args,
      dependencies.composio,
    );
  }
  const run = shouldUseAdapter(tool)
    ? () => (dependencies.executeAdapter
      ? dependencies.executeAdapter(context, tool, args)
      : executeAdapterTool(context, tool, args, { remainingBudgetMs }))
    : () => (dependencies.executeLegacy ?? executeCustomTool)(context, tool, args);
  // The sandbox never touches the ledger, exactly as it never touches a vendor.
  if (context.dryRun) return await run();
  const actionName = typeof args.capability === "string" ? args.capability : "input";
  return await meterNativeExecution(context, tool, actionName, run);
}
