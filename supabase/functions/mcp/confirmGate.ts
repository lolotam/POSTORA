// Confirmation gate for the destructive MCP tools.
//
// The refusal is made HERE, in the handler, and not by the input schema: a
// schema that rejects anything but `true` refuses the call before it is ever
// handled, so the refusal leaves no trace. Every refusal has to write a log
// row (AGENTS.md rule 4), which means the decision has to happen in code we
// own and can record.
//
// The schema therefore accepts any value and the handler decides:
// `confirm: true` runs the tool, anything else is refused and recorded.
//
// The database client and the hashing function are injected so the gate owns
// no client of its own and can be exercised without a database or a network.

import { z } from "npm:zod@4.1.12";

export const confirmField = z.unknown().optional().describe(
  "Must be the boolean true to run. Confirms you intend this irreversible action.",
);

export interface ConfirmGateDeps {
  admin: any;
  sha256Hex: (text: string) => Promise<string>;
}

export interface ConfirmRefusal {
  code: "CONFIRMATION_REQUIRED";
  message: string;
}

const REFUSAL_MESSAGE = "Set confirm: true to run this action.";

function refusal(): ConfirmRefusal {
  return { code: "CONFIRMATION_REQUIRED", message: REFUSAL_MESSAGE };
}

/**
 * Record a refusal in system_logs.
 *
 * Every refusal has to leave a durable trace (AGENTS.md rule 4), so the owner
 * is resolved from the caller's key and the refusal is written under it.
 *
 * The row is written either way. A failed lookup, a missing owner or a thrown
 * error only means the owner could not be resolved: the refusal is then
 * recorded with `user_id: null` and `metadata.owner_resolved: false`, so the
 * refusal still leaves a trace instead of vanishing with the lookup.
 *
 * The row names the tool and the code only. The arguments, the API key and
 * its hash stay out of it.
 *
 * A failed lookup, a missing owner, a failed insert or a thrown error are
 * all reported on the edge and then swallowed: the recorder never throws,
 * and it never lets a broken log turn into a broken answer.
 */
export async function recordMcpRefusal(
  deps: ConfirmGateDeps,
  request: { apiKey: string; tool: string; code: string },
): Promise<void> {
  // The owner, when it can be resolved. The row is written either way, so a
  // failure here costs the row its owner, not the row itself.
  let userId: string | null = null;
  let ownerResolved = false;

  try {
    const apiKeyHash = await deps.sha256Hex(request.apiKey);
    const { data: profile, error } = await deps.admin
      .from("profiles")
      .select("id")
      .eq("api_key_hash", apiKeyHash)
      .maybeSingle();

    if (error) {
      console.error(`[mcp] ${request.tool} refused: owner lookup failed`);
    } else if (!profile) {
      console.error(`[mcp] ${request.tool} refused: owner not found`);
    } else {
      userId = profile.id;
      ownerResolved = true;
    }
  } catch {
    console.error(`[mcp] ${request.tool} refused: owner lookup failed`);
  }

  try {
    const { error: insertError } = await deps.admin.from("system_logs").insert({
      source: "mcp",
      category: "edge",
      level: "warn",
      message: `${request.tool} refused: ${request.code}`,
      user_id: userId,
      metadata: { tool: request.tool, code: request.code, owner_resolved: ownerResolved },
    });
    if (insertError) {
      console.error(`[mcp] ${request.tool} refused: log insert failed`);
    }
  } catch {
    console.error(`[mcp] ${request.tool} refused: log insert failed`);
  }
}

// The JSON-RPC error code the framework answers a schema rejection with. The
// arguments are validated against the tool's input schema before the handler
// runs, so a call that does not fit the schema never reaches the handler and
// never reaches the confirmation gate either: it leaves no trace at all.
const INVALID_PARAMS_CODE = -32602;

// The name of the tool a rejected call was for, when the request names one.
// A name that is not a tool name is not written down as if it were one: the
// row would name a tool that does not exist. The name is bounded as well, so
// a long string in the request cannot become a long string in the log.
const TOOL_NAME_RE = /^[a-z_]+$/;
const TOOL_NAME_MAX_LENGTH = 64;
const UNKNOWN_TOOL = "unknown";

function isInvalidParams(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" && code === INVALID_PARAMS_CODE;
}

// The tool a rejected call was for, or null when the request was not a tool
// call at all. The arguments are never read: only the name of the tool is
// taken out of the request, and only when it is a tool name.
function rejectedToolName(rpcRequest: unknown): string | null {
  if (typeof rpcRequest !== "object" || rpcRequest === null) return null;
  const request = rpcRequest as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call") return null;

  if (typeof request.params !== "object" || request.params === null) {
    return UNKNOWN_TOOL;
  }
  const name = (request.params as { name?: unknown }).name;
  if (typeof name !== "string") return UNKNOWN_TOOL;
  if (name.length === 0 || name.length > TOOL_NAME_MAX_LENGTH) return UNKNOWN_TOOL;
  if (!TOOL_NAME_RE.test(name)) return UNKNOWN_TOOL;
  return name;
}

/**
 * Record a call the framework refused before the handler ran.
 *
 * The input schema is validated before the handler is called, so a call whose
 * arguments do not fit the schema (a reply_to_message without a message, for
 * one) never reaches the handler and never reaches the confirmation gate
 * either: it leaves no trace at all. The framework answers it with an
 * INVALID_PARAMS error, and this is where that error still becomes a durable
 * row.
 *
 * Only that one case is recorded. Every other error is the framework's
 * business, and a row for it would be noise.
 *
 * The row names the tool and the code only. The arguments, the API key and
 * its hash stay out of it, and the arguments are never logged either.
 *
 * The auditor never throws: a broken log must not turn a schema rejection
 * into a broken answer.
 */
export async function auditSchemaRejection(
  deps: ConfirmGateDeps,
  request: { apiKey: string; error: unknown; rpcRequest: unknown },
): Promise<void> {
  try {
    if (!isInvalidParams(request.error)) return;
    const tool = rejectedToolName(request.rpcRequest);
    if (tool === null) return;

    await recordMcpRefusal(deps, {
      apiKey: request.apiKey,
      tool,
      code: "INVALID_PARAMS",
    });
  } catch {
    // The recorder does not throw, but nothing here may escape either: the
    // auditor answers no one, so a fault in it can only cost the row.
  }
}

/**
 * Refuse a destructive call that did not carry `confirm: true`.
 *
 * - `confirm === true` -> null: the call may run, and nothing is read or
 *   written. A confirmed call must not pay for a log lookup.
 * - anything else -> the refusal, after a best-effort durable log.
 *
 * The log names the tool and the code only. The arguments, the API key and
 * its hash stay out of it.
 *
 * A failed lookup, a missing owner, a failed insert or a thrown error are
 * all reported on the edge and then answered with the same refusal: the gate
 * never throws, and it never lets a broken log turn into a broken answer.
 */
export async function refuseUnconfirmed(
  deps: ConfirmGateDeps,
  request: { apiKey: string; tool: string; confirm: unknown },
): Promise<ConfirmRefusal | null> {
  if (request.confirm === true) return null;

  await recordMcpRefusal(deps, {
    apiKey: request.apiKey,
    tool: request.tool,
    code: "CONFIRMATION_REQUIRED",
  });

  return refusal();
}
