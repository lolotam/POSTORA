// Spec §7.2 — executing a Composio tool from the agent door.
//
// Every refusal (slug outside the registry allow-list, a mutating slug without
// admin or allow_writes, no configured client) is thrown as a ConnectorRefusal
// INSIDE withConnectorCall, so the ledger row says refused with the stable
// error code from spec §11. A dry run short-circuits before any network call
// and before any ledger write. Vendor bodies never reach the model beyond a
// 300-character sanitized prefix, and the Composio API key is redacted from
// everything the model or a log may see.
import { ComposioError, composioClientFromEnv, type ComposioClient } from "../_shared/composioClient.ts";
import { composioBinding } from "../_shared/connectorRegistry.ts";
import {
  ConnectorRefusal,
  withConnectorCall,
} from "../_shared/connectorTelemetry.ts";
import type { ToolContext, ToolResult } from "./tools.ts";
import type { ComposioReadyTool } from "./composioTools.ts";
import { ADAPTER_OUTPUT_LIMIT, redactKnownSecrets } from "./connectorExecution.ts";

/** Same budget as the adapter path, for the same 60s-worker arithmetic. */
export const COMPOSIO_EXECUTE_TIMEOUT_MS = 6_000;

/** Vendor error text is capped hard: spec §11 forbids passing bodies through. */
const COMPOSIO_ERROR_BODY_LIMIT = 300;

export interface ComposioExecutionDependencies {
  /** null expresses "no client configured" in tests; production omits it. */
  client?: ComposioClient | null;
  admin?: any;
  timeoutMs?: number;
  getEnv?: (name: string) => string | undefined;
}

/** A vendor-reported failure, already sanitized and bounded. */
class ComposioToolFailure extends Error {
  readonly code = "tool_execution_failed";
  constructor(public readonly sanitizedDetail: string) {
    super("tool_execution_failed");
    this.name = "ComposioToolFailure";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "AbortError" || error.message === "AbortError");
}

/**
 * Model-visible refusal text. Names the reason, never the connection id or
 * any Composio identifier (spec §11).
 */
function refusalOutput(toolName: string, slug: string, code: string): string {
  if (code === "connector_write_not_allowed") {
    return `Connector "${toolName}" is not allowed to run "${slug}" because it changes data in the connected account and writes are not enabled for this connector.`;
  }
  if (code === "connector_tool_not_allowed") {
    return `Connector "${toolName}" is not allowed to run "${slug}". Choose one of the capabilities offered in the tool's description.`;
  }
  return `Connector "${toolName}" is not available right now. Tell the customer you could not reach the system.`;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

export async function executeComposioTool(
  context: ToolContext,
  tool: ComposioReadyTool,
  args: Record<string, unknown>,
  deps: ComposioExecutionDependencies = {},
): Promise<ToolResult> {
  const slug = typeof args.capability === "string" ? args.capability : "";
  // Before env access, client construction, and the ledger wrapper: the
  // sandbox must never touch a real connector or write telemetry.
  if (context.dryRun) {
    return {
      output: `(test mode — connector not called) Would call "${tool.name}"${
        slug ? ` with capability "${slug}"` : ""
      }.`,
    };
  }

  const admin = deps.admin ?? context.admin;
  const getEnv = deps.getEnv ?? ((name: string) => Deno.env.get(name));
  const apiKey = getEnv("COMPOSIO_API_KEY") ?? null;
  const secrets = [apiKey, tool.secret];

  try {
    const data = await withConnectorCall(
      admin,
      {
        // The connection was loaded scoped to this workspace at prompt
        // assembly — that scoping IS the workspace resolution here.
        workspaceId: tool.connection.workspaceId,
        toolId: tool.id,
        connectionId: tool.connection.id,
        socialAccountId: context.socialAccountId,
        partnerKeyId: null,
        connectorType: tool.connector_type ?? "custom_rest",
        authStrategy: "composio_oauth",
        actionName: slug,
        source: "agent",
        requestId: context.requestId,
      },
      async (signal) => {
        // Fail closed: the allow-list is the registry binding, verbatim.
        const binding = composioBinding(tool.connector_type);
        if (!binding || !binding.tools.includes(slug)) {
          throw new ConnectorRefusal("connector_tool_not_allowed");
        }
        const writesAllowed = context.isAdmin || tool.settings?.allow_writes === true;
        if (binding.mutating.includes(slug) && !writesAllowed) {
          throw new ConnectorRefusal("connector_write_not_allowed");
        }
        const client = deps.client !== undefined ? deps.client : composioClientFromEnv(getEnv);
        if (!client) {
          // Spec D11: a missing COMPOSIO_API_KEY disables every Composio path.
          throw new ConnectorRefusal("connector_unavailable");
        }
        let result: { successful: boolean; data: unknown; error?: string };
        try {
          result = await client.executeTool({
            slug,
            version: binding.toolkitVersion,
            workspaceId: tool.connection.workspaceId,
            connectedAccountId: tool.connection.composioConnectedAccountId,
            arguments: isRecord(args.parameters) ? args.parameters : {},
            signal,
          });
        } catch (error) {
          // The REST client maps an aborted fetch to
          // ComposioError("composio_timeout"); re-surfacing it as an abort
          // keeps the ledger row's status honest (timeout, not failed).
          if (error instanceof ComposioError && error.code === "composio_timeout") {
            throw new DOMException("Aborted", "AbortError");
          }
          throw error;
        }
        if (!result.successful) {
          throw new ComposioToolFailure(
            redactKnownSecrets(
              (result.error ?? "The connector request failed.").slice(
                0,
                COMPOSIO_ERROR_BODY_LIMIT,
              ),
              secrets,
            ),
          );
        }
        return result.data;
      },
      { timeoutMs: deps.timeoutMs ?? COMPOSIO_EXECUTE_TIMEOUT_MS },
    );

    const serialized = JSON.stringify(data) ?? "null";
    return {
      output: redactKnownSecrets(
        `Connector "${tool.name}" returned: ${serialized.slice(0, ADAPTER_OUTPUT_LIMIT)}`,
        secrets,
      ),
    };
  } catch (error) {
    if (error instanceof ConnectorRefusal) {
      return { output: refusalOutput(tool.name, slug, error.code) };
    }
    if (isAbortError(error)) {
      return {
        output: `Connector "${tool.name}" timed out. Tell the customer you could not reach the system and answer from what you already know.`,
      };
    }
    if (error instanceof ComposioToolFailure) {
      return { output: `Connector "${tool.name}" failed: ${error.sanitizedDetail}` };
    }
    if (error instanceof ComposioError) {
      return {
        output: `Connector "${tool.name}" failed (${error.code}). Tell the customer you could not reach the system.`,
      };
    }
    return { output: `Connector "${tool.name}" failed safely.` };
  }
}
