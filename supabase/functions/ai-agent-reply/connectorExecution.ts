import { shouldUseAdapter } from "../_shared/connectorRegistry.ts";
import {
  executeCustomTool,
  type CustomTool,
  type ToolContext,
  type ToolResult,
} from "./tools.ts";

// The adapter gives its vendor 10s. At five tool iterations, a 6s reply-side
// deadline caps adapter waiting at 30s of the 60s worker lifetime, leaving the
// other half for model calls and final logging. It wraps the full internal call,
// so the reply and vendor deadlines are not additive.
const ADAPTER_CALL_TIMEOUT_MS = 6_000;
// 8000 characters (~2000 tokens). 2000 was tuned for one-product answers and
// silently cut a whole-catalog result mid-JSON: the Supabase adapter returns
// per-cell-trimmed rows at up to ~290 characters each, so a 25-row table needs the
// larger allowance, and a truncated table is answered by the model FILLING THE
// GAPS from stale indexed knowledge -- confidently, and wrong (2026-09-01).
// The prompt already runs 4-13k tokens; this is a bounded, deliberate spend.
const ADAPTER_OUTPUT_LIMIT = 8000;

interface AdapterCallDependencies {
  fetch?: typeof fetch;
  getEnv?: (name: string) => string | undefined;
  timeoutMs?: number;
}

interface RoutedCustomToolDependencies {
  executeAdapter?: typeof executeAdapterTool;
  executeLegacy?: typeof executeCustomTool;
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

function redactKnownSecrets(text: string, secrets: Array<string | null>): string {
  return secrets
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((safe, secret) => safe.replaceAll(secret, "[REDACTED]"), text);
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
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

  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.timeoutMs ?? ADAPTER_CALL_TIMEOUT_MS,
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

export async function executeRoutedCustomTool(
  context: ToolContext,
  tool: CustomTool,
  args: Record<string, unknown>,
  dependencies: RoutedCustomToolDependencies = {},
): Promise<ToolResult> {
  if (shouldUseAdapter(tool)) {
    return await (dependencies.executeAdapter ?? executeAdapterTool)(context, tool, args);
  }
  return await (dependencies.executeLegacy ?? executeCustomTool)(context, tool, args);
}
