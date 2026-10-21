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
// A refusal is only ever recorded for an AUTHENTICATED owner. The MCP edge
// resolves the caller to a profile before any tool runs (see ./keyOwner.ts)
// and refuses an unauthenticated request with 401 before a server is even
// built, so there is no unauthenticated caller that can reach this gate and
// no row is ever written without an owner. The owner is therefore passed in
// as an id, and the gate resolves nothing itself.
//
// The database client is injected so the gate owns no client of its own and
// can be exercised without a database or a network.
//
// The same file holds the SCOPE gate: a tool the caller's grant does not
// cover is refused before it runs, and that refusal is recorded like every
// other one. The scopes themselves live in ./toolScopes.ts.
//
// Refusal rows are throttled. An authenticated client can repeat an invalid
// call forever, and every refusal used to insert a row, so the log grew with
// the client's patience. At most one row per (owner, tool, code) per minute
// is written now. The first refusal of each kind is always recorded: the
// throttle bounds the growth of the log, it never hides the first refusal.

import { z } from "npm:zod@4.1.12";
import { missingScope, type ScopeGrant } from "./toolScopes.ts";

export const confirmField = z.unknown().optional().describe(
  "Must be the boolean true to run. Confirms you intend this irreversible action.",
);

export interface ConfirmGateDeps {
  admin: any;
  // The clock, injected so the refusal throttle can be exercised without
  // waiting for a real minute to pass. Defaults to Date.now.
  now?: () => number;
}

export interface ConfirmRefusal {
  code: "CONFIRMATION_REQUIRED";
  message: string;
}

export interface ScopeRefusal {
  code: "SCOPE_NOT_GRANTED";
  message: string;
}

const REFUSAL_MESSAGE = "Set confirm: true to run this action.";

function refusal(): ConfirmRefusal {
  return { code: "CONFIRMATION_REQUIRED", message: REFUSAL_MESSAGE };
}

// The throttle on refusal rows. A client that repeats a refused call would
// otherwise insert one row per call, for as long as it keeps calling.
const REFUSAL_THROTTLE_WINDOW_MS = 60_000;
const REFUSAL_THROTTLE_MAX_ENTRIES = 10_000;

// The last write time per (owner, tool, code). It lives in the isolate, so
// the bound is per isolate: two isolates write their own rows.
const refusalThrottle = new Map<string, number>();

/**
 * Forget every throttled refusal.
 *
 * The throttle is module state, so a test that counts rows has to start from
 * a clean slate. Production code never calls this.
 */
export function resetRefusalThrottleForTests(): void {
  refusalThrottle.clear();
}

/**
 * Record a refusal in system_logs.
 *
 * Every refusal has to leave a durable trace (AGENTS.md rule 4), and the row
 * is written under the authenticated owner the edge resolved for the
 * request. There is no ownerless row: an unauthenticated request never
 * reaches this gate.
 *
 * The row names the tool and the code only. The arguments, the API key and
 * its hash stay out of it.
 *
 * A failed insert or a thrown error is reported on the edge and then
 * swallowed: the recorder never throws, and it never lets a broken log turn
 * into a broken answer.
 *
 * The row is throttled per owner, tool and code: a client that repeats the
 * same refused call gets one row per minute, not one row per call. The
 * skipped row is reported on the edge in one line, without the arguments.
 */
export async function recordMcpRefusal(
  deps: ConfirmGateDeps,
  request: { userId: string; tool: string; code: string },
): Promise<void> {
  const nowMs = (deps.now ?? Date.now)();
  const throttleKey = `${request.userId}:${request.tool}:${request.code}`;

  const lastWrite = refusalThrottle.get(throttleKey);
  if (lastWrite !== undefined && nowMs - lastWrite < REFUSAL_THROTTLE_WINDOW_MS) {
    console.warn(
      `[mcp] ${request.tool} refused: ${request.code} (repeat within 60s, not logged again)`,
    );
    return;
  }

  // The map holds one entry per refused (owner, tool, code). It is pruned
  // when it grows past the limit, so a client that refuses with a different
  // tool or code every time cannot make it grow without bound either.
  if (refusalThrottle.size > REFUSAL_THROTTLE_MAX_ENTRIES) {
    for (const [key, writtenAt] of refusalThrottle) {
      if (nowMs - writtenAt >= REFUSAL_THROTTLE_WINDOW_MS) {
        refusalThrottle.delete(key);
      }
    }
  }
  refusalThrottle.set(throttleKey, nowMs);

  try {
    const { error: insertError } = await deps.admin.from("system_logs").insert({
      source: "mcp",
      category: "edge",
      level: "warn",
      message: `${request.tool} refused: ${request.code}`,
      user_id: request.userId,
      metadata: { tool: request.tool, code: request.code },
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
  request: { userId: string; error: unknown; rpcRequest: unknown },
): Promise<void> {
  try {
    if (!isInvalidParams(request.error)) return;
    const tool = rejectedToolName(request.rpcRequest);
    if (tool === null) return;

    await recordMcpRefusal(deps, {
      userId: request.userId,
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
 * A failed insert or a thrown error is reported on the edge and then
 * answered with the same refusal: the gate never throws, and it never lets
 * a broken log turn into a broken answer.
 */
export async function refuseUnconfirmed(
  deps: ConfirmGateDeps,
  request: { userId: string; tool: string; confirm: unknown },
): Promise<ConfirmRefusal | null> {
  if (request.confirm === true) return null;

  await recordMcpRefusal(deps, {
    userId: request.userId,
    tool: request.tool,
    code: "CONFIRMATION_REQUIRED",
  });

  return refusal();
}

/**
 * Refuse a call the caller's grant does not cover.
 *
 * - the grant covers the tool -> null: the call may run, and nothing is read
 *   or written. A call that may run must not pay for a log lookup.
 * - the grant does not cover it -> the refusal, after a best-effort durable
 *   log, naming the scope that is missing.
 *
 * The grant is decided by the caller: an API-key caller holds every scope,
 * an OAuth token holds only the scopes it was granted (see ./toolScopes.ts).
 *
 * The log names the tool and the code only. The arguments, the API key, the
 * token and its scopes stay out of it.
 *
 * The gate never throws: a broken log must not turn a refused call into a
 * broken answer.
 */
export async function refuseUngranted(
  deps: ConfirmGateDeps,
  request: { userId: string; tool: string; grant: ScopeGrant },
): Promise<ScopeRefusal | null> {
  const scope = missingScope(request.grant, request.tool);
  if (scope === null) return null;

  await recordMcpRefusal(deps, {
    userId: request.userId,
    tool: request.tool,
    code: "SCOPE_NOT_GRANTED",
  });

  return {
    code: "SCOPE_NOT_GRANTED",
    message:
      `This connection was not granted the ${scope} scope. ` +
      `Reconnect with that scope, or use a Postora API key.`,
  };
}
