// Spec §7.1 — the Composio half of the agent's tool list.
//
// After resolveToolsForAccount (unchanged), each tool with
// auth_strategy='composio_oauth' has its connection loaded by connection_id
// AND workspace_id — the second predicate is the structural tenancy check
// under the service role. A connection that is missing, inactive, in another
// workspace, or without a cached schema omits the tool from the prompt with a
// sanitized console.warn and NEVER a connector_call_logs row: an omission at
// prompt assembly is not an execution attempt, and one row per reply per dead
// connection would swamp refused_30d. The ledger is written only when
// something tries to execute (composioExecution.ts).
import type { ActiveConnection, ConnectionLookup } from "../_shared/composioConnections.ts";
import { loadActiveConnection } from "../_shared/composioConnections.ts";
import { composioBinding, type ComposioBinding } from "../_shared/connectorRegistry.ts";
import type { CustomTool } from "./tools.ts";

export interface ComposioReadyTool extends CustomTool {
  auth_strategy: "composio_oauth";
  connection: ActiveConnection;
}

// A cached ComposioToolSchema's inputParameters is an opaque JSON-schema
// fragment. It is usually { properties: {...}, required: [...] }, but this
// code only reads keys, so a flat {name: schema} map is accepted too and the
// meta keys of either shape are skipped.
const INPUT_META_KEYS = new Set([
  "type",
  "required",
  "$schema",
  "$id",
  "title",
  "description",
  "additionalProperties",
]);

function inputProperties(
  inputParameters: Record<string, unknown> | null | undefined,
): { properties: Record<string, unknown>; required: Set<string> } {
  if (!inputParameters || typeof inputParameters !== "object") {
    return { properties: {}, required: new Set() };
  }
  const nested = inputParameters.properties;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const required = Array.isArray(inputParameters.required)
      ? new Set(
        inputParameters.required.filter((name): name is string => typeof name === "string"),
      )
      : new Set<string>();
    return { properties: nested as Record<string, unknown>, required };
  }
  return {
    properties: Object.fromEntries(
      Object.entries(inputParameters).filter(([key]) => !INPUT_META_KEYS.has(key)),
    ),
    required: new Set<string>(),
  };
}

/** "spreadsheet_id (required), range" — the flat schema's only argument hint. */
function describeInputKeys(
  inputParameters: Record<string, unknown> | null | undefined,
): string {
  const { properties, required } = inputProperties(inputParameters);
  const keys = Object.keys(properties);
  if (keys.length === 0) return "no arguments";
  return keys.map((key) => required.has(key) ? `${key} (required)` : key).join(", ");
}

/**
 * Every cached capability's arguments in one object — the same merge the
 * adapter path performs for native capabilities. A key shared by two slugs
 * keeps the first definition; per-slug precision lives in the capability
 * enum's description and is enforced at execution by Composio itself.
 */
function mergedInputProperties(
  schemas: NonNullable<ActiveConnection["toolSchemaCache"]>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const schema of schemas) {
    for (const [key, value] of Object.entries(inputProperties(schema.inputParameters).properties)) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

// Vendor descriptions are unbounded; the enum description is resent on every
// turn of every conversation, so each slug line is capped the way the tool
// description is capped by TOOL_DESCRIPTION_BUDGET.
const SLUG_DESCRIPTION_LIMIT = 160;

/**
 * The flat {capability enum + parameters} contract the adapter path already
 * uses — deliberately no oneOf, for the provider-compatibility reasons
 * documented on the adapter branch in tools.ts. `capability.enum` is the
 * registry allow-list verbatim: execution refuses any other slug
 * (connector_tool_not_allowed), so the prompt and the gate cannot drift.
 */
export function composioToolParameters(
  tool: ComposioReadyTool,
  binding: ComposioBinding,
): {
  type: "object";
  properties: {
    capability: { type: "string"; enum: string[]; description: string };
    parameters: { type: "object"; description: string; properties: Record<string, unknown> };
  };
  required: ["capability"];
} {
  const schemas = tool.connection?.toolSchemaCache ?? [];
  const bySlug = new Map(schemas.map((schema) => [schema.slug, schema]));
  return {
    type: "object",
    properties: {
      capability: {
        type: "string",
        enum: [...binding.tools],
        description: binding.tools
          .map((slug) => {
            const schema = bySlug.get(slug);
            if (!schema) return `${slug}: no cached schema for this slug.`;
            return `${slug}: ${
              schema.description.slice(0, SLUG_DESCRIPTION_LIMIT)
            } Takes ${describeInputKeys(schema.inputParameters)}.`;
          })
          .join(" "),
      },
      parameters: {
        type: "object",
        description: "Arguments for the chosen capability.",
        properties: mergedInputProperties(schemas),
      },
    },
    required: ["capability"],
  };
}

/**
 * Loads the connection behind each Composio tool and returns the tools that
 * are actually offerable: Composio tools become ComposioReadyTool with their
 * ActiveConnection attached (one load per connection per reply), everything
 * else is returned untouched. Every omission is a sanitized console.warn
 * naming the tool id and a stable reason code — never a ledger row.
 */
export async function attachComposioTools(
  admin: any,
  tools: CustomTool[],
  account: { workspaceId: string | null; id: string | null },
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<CustomTool[]> {
  if (!tools.some((tool) => tool.auth_strategy === "composio_oauth")) return tools;

  const omit = (tool: CustomTool, code: string) =>
    warn(
      `[ai-agent-reply] composio tool omitted: tool=${tool.id} account=${account.id ?? "none"} reason=${code}`,
    );

  // Spec §7.1: no workspace means no Composio tool can be tenancy-checked, so
  // every one of them is omitted. The connection id and Composio ids never
  // appear in the message.
  if (!account.workspaceId) {
    for (const tool of tools) {
      if (tool.auth_strategy === "composio_oauth") omit(tool, "connection_not_found");
    }
    return tools.filter((tool) => tool.auth_strategy !== "composio_oauth");
  }

  // Connections resolve once per reply: two tools sharing a connection share
  // one lookup and one lookup failure.
  const workspaceId = account.workspaceId;
  const lookups = new Map<string, ConnectionLookup>();
  const lookup = async (connectionId: string): Promise<ConnectionLookup> => {
    const cached = lookups.get(connectionId);
    if (cached) return cached;
    const result = await loadActiveConnection(admin, connectionId, workspaceId);
    lookups.set(connectionId, result);
    return result;
  };

  const ready: CustomTool[] = [];
  for (const tool of tools) {
    if (tool.auth_strategy !== "composio_oauth") {
      ready.push(tool);
      continue;
    }
    if (!tool.connection_id) {
      omit(tool, "connection_not_found");
      continue;
    }
    try {
      const lookupResult = await lookup(tool.connection_id);
      if (!lookupResult.ok) {
        omit(tool, lookupResult.code);
        continue;
      }
      if (!lookupResult.connection.toolSchemaCache?.length) {
        // A reply never calls Composio for schemas: the cache is filled by the
        // callback and refresh-schema, and an empty cache is an omission.
        omit(tool, "schema_missing");
        continue;
      }
      const readyTool: ComposioReadyTool = {
        ...tool,
        auth_strategy: "composio_oauth",
        connection: lookupResult.connection,
      };
      ready.push(readyTool);
    } catch (error) {
      // The read failed — that is a different fact from "no connection", and
      // swallowing it would look exactly like an empty result (ARCHITECTURE
      // §17: say it, sanitized; the reply itself proceeds).
      console.error(
        `[ai-agent-reply] composio connection read failed: tool=${tool.id} reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      omit(tool, "connection_read_failed");
    }
  }
  return ready;
}

/** The binding behind a Composio tool, when its type is one. */
export function toolComposioBinding(tool: CustomTool): ComposioBinding | undefined {
  return tool.auth_strategy === "composio_oauth"
    ? composioBinding(tool.connector_type)
    : undefined;
}
