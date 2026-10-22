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
// It holds the FORWARDED gate too. Some API routes answer a refused call
// with a 4xx and a body and write no row of their own, so the tool that
// forwarded the answer records it here. A refusal that happened behind the
// API then leaves the same trace a refusal made here would have left.
// A 429 is not one of them: the API's central rate limiter records every
// 429 itself, before the route runs, so it is not recorded a second time
// here.
//
// Refusal rows are throttled. An authenticated client can repeat an invalid
// call forever, and every refusal used to insert a row, so the log grew with
// the client's patience. At most one row per (owner, tool, code) per minute
// is written now. The first refusal of each kind is recorded, unless the
// throttle is saturated: the throttle bounds the growth of the log, and a
// saturated throttle hides the first refusal of a new kind as well.
// A row that failed to be written is not throttled either: the throttle
// remembers what was logged, so a row that never landed is tried again.
//
// The map that holds the throttle is bounded as well. When it is full of
// entries whose window is still running, a NEW kind of refusal is not
// written down at all: the log is saturated, and losing that row is better
// than evicting a live entry, which would let the same refusal write a
// second row inside the minute. Saturation is 10,000 distinct
// (owner, tool, code) keys inside one minute, and the refusal is then
// reported on the edge only. The throttle lives in the isolate, so one that
// outlives it would have to live in the database, and that needs a
// migration: it is out of scope here.

import { z } from "npm:zod@4.1.12";
import {
  missingScope,
  NOT_YET_GRANTABLE_SCOPES,
  UNCLASSIFIED_TOOL,
  type ScopeGrant,
} from "./toolScopes.ts";

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

// The hard bound on the throttle map. It is exported so a test can fill the
// map past the bound and see that it stays bounded.
export const REFUSAL_THROTTLE_MAX_ENTRIES = 10_000;

// One throttle entry: when the row was written, and the promise of that
// write.
//
// The promise resolves true when the row landed and false when the insert
// errored or threw. It never rejects.
//
// It is what a refusal that finds a live entry waits for. A refusal must
// not skip a row that was never written, so the waiter needs to know
// whether the write it is throttled by landed before it can decide.
//
// The entry is also the claim on the key: the refusal that installs it owns
// the write, and every other refusal of that kind waits for it instead of
// writing a row of its own.
//
// `settled` says whether that write is over: it is false while the insert
// is still in flight, and true once the promise has resolved, either way.
// The window alone does not say that the row exists. A database that
// stalls for longer than the window leaves a write that is still running,
// and replacing that entry then would let the same refusal write a second
// row.
interface RefusalThrottleEntry {
  at: number;
  landed: Promise<boolean>;
  settled: boolean;
}

// The throttle state per (owner, tool, code). It lives in the isolate, so
// the bound is per isolate: two isolates write their own rows.
//
// The map keeps insertion order, and a write moves its key to the end, so
// the map is ordered by write time and the oldest entry is the first one
// the map hands out.
//
// An entry whose window has passed may be evicted to make room for a new
// key. An entry whose window is still running may not: evicting it would
// let the same refusal write a second row inside the minute, which is
// exactly what the throttle is there to prevent.
const refusalThrottle = new Map<string, RefusalThrottleEntry>();

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
 * The number of entries the throttle map holds.
 *
 * It is exported so a test can see that the map stays inside its bound.
 * Production code never calls this.
 */
export function refusalThrottleSizeForTests(): number {
  return refusalThrottle.size;
}

/**
 * Write the row of a refusal.
 *
 * The promise it returns resolves true when the row landed and false when
 * the insert errored or threw. It never rejects: a broken log must not
 * turn a refused call into a broken answer.
 */
async function writeRefusalRow(
  deps: ConfirmGateDeps,
  request: { userId: string; tool: string; code: string },
): Promise<boolean> {
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
      return false;
    }
    return true;
  } catch {
    console.error(`[mcp] ${request.tool} refused: log insert failed`);
    return false;
  }
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
 * into a broken answer. A row that did not land is not throttled: the
 * throttle is dropped for that refusal, so the next identical one tries the
 * durable write again.
 *
 * The row is throttled per owner, tool and code: a client that repeats the
 * same refused call gets one row per minute, not one row per call. The
 * skipped row is reported on the edge in one line, without the arguments.
 * The first refusal of each kind is recorded, unless the throttle of this
 * isolate is saturated: 10,000 distinct (owner, tool, code) keys inside one
 * minute, and the refusal is then reported on the edge only.
 *
 * A refusal that arrives while the row of its kind is still being written
 * waits for that write. If the row landed, the refusal is skipped, and if
 * it did not, ONE of the waiters writes the row and the others wait for
 * that write: the waiters re-read the map after every await, so the first
 * one to get there claims the key and the rest do not write a second row
 * inside the minute.
 *
 * A write that is still in flight is waited for even when the window of
 * its entry has passed: the window says when a row MAY be written, not
 * that one has been, and a database that stalls for longer than the
 * window would otherwise let the same refusal write a second row.
 *
 * The throttle map is bounded. A key that is not in the map needs room in
 * it, and an entry whose window has passed is evicted to make it: the map
 * is ordered by write time, so the expired entries come first and the
 * eviction costs one delete per new key. When the map is full of entries
 * whose window is still running, a NEW kind of refusal is not written down
 * at all: it is better to lose that row than to evict a live entry and let
 * the same refusal write a second row inside the minute. The throttle
 * lives in the isolate, so a durable one would have to live in the
 * database, and that needs a migration: it is out of scope here.
 */
export async function recordMcpRefusal(
  deps: ConfirmGateDeps,
  request: { userId: string; tool: string; code: string },
): Promise<void> {
  const throttleKey = `${request.userId}:${request.tool}:${request.code}`;

  // The throttle check is a loop, because every await inside it hands the
  // map over to another waiter. The map is read again after every await,
  // and the clock is read with it, so the decision is always made against
  // the state of the map at that moment and only one waiter can claim the
  // key.
  let nowMs = (deps.now ?? Date.now)();
  let existing: RefusalThrottleEntry | undefined = undefined;

  for (;;) {
    nowMs = (deps.now ?? Date.now)();
    existing = refusalThrottle.get(throttleKey);

    // No entry: this refusal may write its own row.
    if (existing === undefined) break;

    // An entry whose window has passed may be replaced only when its write
    // is over. A write that is still in flight holds a row that may not
    // exist yet, so an expired entry whose write is still running is
    // treated like a live one: replacing it would let a second row be
    // written for the same refusal.
    const windowPassed = nowMs - existing.at >= REFUSAL_THROTTLE_WINDOW_MS;
    if (windowPassed && existing.settled) break;

    // The window of this kind of refusal is still running, or the row of
    // the write it is throttled by is still being written. Whether that
    // row landed is not known yet, so wait for it: a refusal must not
    // skip a row that was never written.
    const rowLanded = await existing.landed;
    if (rowLanded) {
      console.warn(
        windowPassed
          ? `[mcp] ${request.tool} refused: ${request.code} (an earlier row is still being written, not logged again)`
          : `[mcp] ${request.tool} refused: ${request.code} (repeat within 60s, not logged again)`,
      );
      return;
    }

    // The row never landed, so the throttle must not remember it. The
    // entry is dropped, but only when the map still holds this very
    // entry: another waiter may have claimed the retry already and
    // replaced it, and that one must not be dropped with it.
    if (refusalThrottle.get(throttleKey) === existing) {
      refusalThrottle.delete(throttleKey);
    }

    // The map is read again: another waiter may have claimed the retry
    // already, and this one waits for that write instead of writing a
    // second row inside the minute.
    continue;
  }

  if (existing === undefined) {
    // A key that is not in the map needs room in it. The map is bounded
    // and ordered by write time, so the entries whose window has passed
    // come first: they are evicted, one delete per new key, until there
    // is room.
    while (refusalThrottle.size >= REFUSAL_THROTTLE_MAX_ENTRIES) {
      const oldestKey = refusalThrottle.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = refusalThrottle.get(oldestKey);
      if (oldest !== undefined && nowMs - oldest.at < REFUSAL_THROTTLE_WINDOW_MS) {
        // The oldest entry is still inside its window, and every entry
        // behind it is live too. The map is full of live entries, so the
        // refusal is not written down rather than evicting one of them
        // and letting the same refusal write a second row inside the
        // minute.
        console.warn(
          `[mcp] ${request.tool} refused: ${request.code} (refusal log is saturated, not logged)`,
        );
        return;
      }
      refusalThrottle.delete(oldestKey);
    }
  }

  // The map holds one entry per refused (owner, tool, code) and is bounded.
  // A write moves its key to the end of the map, so the map stays ordered
  // by write time and the oldest entry is the first one it hands out.
  //
  // There is no await between the last read of the map and this set: the
  // entry is installed synchronously, so the first refusal to get here
  // claims the key and every later one finds its live entry and waits for
  // that write instead of writing a second row.
  refusalThrottle.delete(throttleKey);
  const landed = writeRefusalRow(deps, request);
  const entry: RefusalThrottleEntry = { at: nowMs, landed, settled: false };
  // The entry is settled once its write resolves, either way: a write that
  // is still in flight must not be read as a finished one. The promise
  // never rejects, so this cannot leave an unhandled rejection behind.
  void landed.then(() => {
    entry.settled = true;
  });
  refusalThrottle.set(throttleKey, entry);

  const written = await landed;
  if (!written) {
    // The row did not land, so the throttle must not remember it: the
    // throttle remembers what was written. The entry is dropped, but only
    // when the map still holds this very entry: a newer write for the same
    // key has replaced it, and that one must not be dropped with it.
    if (refusalThrottle.get(throttleKey) === entry) {
      refusalThrottle.delete(throttleKey);
    }
  }
}

// The code an API answer carries. A body is untrusted input, so a code is
// only taken from it when it is shaped like a code: an upper-case word of
// letters, digits and underscores. Anything else is not written down as if
// it were a code.
const FORWARDED_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The code a forwarded answer carries, or null when it carries none.
 *
 * The API answers a refusal with its error envelope: `{ success: false,
 * error: { code, message } }` (see apiError in ../n8n-api/index.ts). So the
 * code is read from `error.code` first, and a top-level `code` is the
 * fallback for an answer that carries it there.
 *
 * A body is untrusted input, so a code is only taken from it when it is
 * shaped like a code: an upper-case word of letters, digits and underscores.
 * Anything else is not a code, and the status names the refusal instead.
 */
function forwardedCode(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;

  const body = data as { error?: unknown; code?: unknown };

  // The envelope the API answers a refusal with: error.code.
  const envelope = body.error;
  if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
    const envelopeCode = (envelope as { code?: unknown }).code;
    if (typeof envelopeCode === "string" && FORWARDED_CODE_RE.test(envelopeCode)) {
      return envelopeCode;
    }
  }

  // The top-level code, for an answer that carries one there.
  const bodyCode = body.code;
  if (typeof bodyCode === "string" && FORWARDED_CODE_RE.test(bodyCode)) {
    return bodyCode;
  }

  return null;
}

/**
 * Record a refusal the API answered with a 4xx.
 *
 * Some API routes refuse a call with a 4xx and a body and write no row of
 * their own, so the refusal only exists as the answer the MCP tool
 * forwarded. This turns that answer back into a durable row, so a refused
 * call leaves the same trace behind the API as it would have left here.
 *
 * Only a 4xx is a refusal. A 2xx is a call that ran, and a 5xx is an
 * outage of the API, not a refused call; neither is recorded here.
 *
 * A 429 is not recorded either: the API's central rate limiter answers it
 * before any route runs and records it itself (see recordRateLimitRefusal
 * in ../n8n-api/refusalLog.ts). Recording it here as well would write the
 * same refusal twice.
 *
 * The code is the one the answer carries, in the error envelope the API
 * answers a refusal with (`{ success: false, error: { code, message } }`,
 * see apiError in ../n8n-api/index.ts), and a top-level code is the fallback
 * for an answer that carries one there. When the answer carries no code
 * that is shaped like one, the status names it. The body itself is never
 * written down and never logged: it may name the account, the comment, the
 * message.
 *
 * The recorder never throws: a broken log must not turn a refused call
 * into a broken answer.
 */
export async function recordForwardedRefusal(
  deps: ConfirmGateDeps,
  request: { userId: string; tool: string; status: number; data: unknown },
): Promise<void> {
  try {
    if (request.status < 400 || request.status > 499) return;

    // The API's central rate limiter records every 429 itself, before the
    // route behind this tool runs. The row is written once, there.
    if (request.status === 429) return;

    let code = `HTTP_${request.status}`;
    const forwarded = forwardedCode(request.data);
    if (forwarded !== null) {
      code = forwarded;
    }

    await recordMcpRefusal(deps, {
      userId: request.userId,
      tool: request.tool,
      code,
    });
  } catch {
    // The recorder does not throw, but nothing here may escape either: a
    // fault in it can only cost the row.
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
 * The arguments are passed on, because a call may need a scope only
 * because of what it carries. Today that is create_post with a
 * webhook_url, which needs webhooks:manage. create_post's media:write is
 * not argument-based: it is fixed in TOOL_SCOPES, fails closed, because
 * the schema is .passthrough(). The gate does not read the arguments
 * itself; it hands them to argumentScopes in ./toolScopes.ts.
 *
 * A scope that cannot be granted yet is not answered with advice to
 * reconnect. Reconnecting would not help: the consent screen that could
 * offer the scope does not ship yet, so the only way to run the tool is an
 * API key. Telling the caller to reconnect would send them in circles.
 *
 * A tool nobody classified is answered the same way. It is not a scope, so
 * no token can be granted it and no reconnect can produce it: the refusal
 * names the API key as the way in, not a reconnect.
 *
 * The log names the tool and the code only. The arguments, the API key, the
 * token and its scopes stay out of it.
 *
 * The gate never throws: a broken log must not turn a refused call into a
 * broken answer.
 */
export async function refuseUngranted(
  deps: ConfirmGateDeps,
  request: { userId: string; tool: string; grant: ScopeGrant; args?: unknown },
): Promise<ScopeRefusal | null> {
  const scope = missingScope(request.grant, request.tool, request.args);
  if (scope === null) return null;

  await recordMcpRefusal(deps, {
    userId: request.userId,
    tool: request.tool,
    code: "SCOPE_NOT_GRANTED",
  });

  if (scope === UNCLASSIFIED_TOOL) {
    return {
      code: "SCOPE_NOT_GRANTED",
      message: "This tool is not available over OAuth. Use a Postora API key.",
    };
  }

  if (NOT_YET_GRANTABLE_SCOPES.has(scope)) {
    return {
      code: "SCOPE_NOT_GRANTED",
      message:
        `This tool is not available over OAuth yet (it needs the ${scope} scope, ` +
        `which cannot be granted yet). Use a Postora API key.`,
    };
  }

  return {
    code: "SCOPE_NOT_GRANTED",
    message:
      `This connection was not granted the ${scope} scope. ` +
      `Reconnect with that scope, or use a Postora API key.`,
  };
}
