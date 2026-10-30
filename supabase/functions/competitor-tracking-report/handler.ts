/**
 * The HTTP boundary of the competitor tracking report.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The request contract, the authorization rule, the deadline, the response
 *   mapping and one audit record per terminal path. It owns no SQL, no
 *   Supabase client, no provider call and no enqueue.
 *
 * THE WIRE CONTRACT
 *
 *   POST only. The body is a strict discriminated union on `action`:
 *
 *     { action: "list",   state: "active" | "removed", limit?, cursor? }
 *     { action: "detail", watchlist_id, period_days: 7 | 30, limit?, cursor? }
 *
 *   An unknown key, a key that does not belong to the action, a body over
 *   four kibibytes, a malformed JSON and a method other than POST are all
 *   refusals. None of them is a report.
 *
 * THE AUTHORIZATION RULE
 *
 *   The owner is derived from the VERIFIED auth identity and never from the
 *   body. A service credential is REFUSED: the database reader derives the
 *   owner from `auth.uid()` precisely so that an impersonation is impossible,
 *   and a service-role call has no user to scope to.
 *
 * ONE DEADLINE
 *
 *   The request has fifteen seconds, counted from before the body is read,
 *   and one second of that is reserved for the audit record and the response.
 *   Every dependency is bounded by the REMAINING budget. The ceilings are
 *   not additive.
 *
 * A FAILED READ IS NEVER AN EMPTY REPORT
 *
 *   A malformed upstream payload, a failed read and a timeout are failures
 *   with a stable code. They are never an empty list: an empty list is a fact
 *   about the data and a refusal is a fact about the request.
 *
 * NO SERVICE-ROLE CLIENT
 *
 *   The handler has no service credential and no second client. The audit
 *   record is a redacted console event, not a privileged database write.
 */

import { z } from "npm:zod@3.23.8";

import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { redactSensitive } from "../_shared/logging.ts";

import {
  COMPETITOR_REPORT_AUDIT_RESERVE_MS,
  COMPETITOR_REPORT_DEFAULT_LIMIT,
  COMPETITOR_REPORT_DEPENDENCY_CEILING_MS,
  COMPETITOR_REPORT_MAX_BODY_BYTES,
  COMPETITOR_REPORT_MAX_CURSOR_LENGTH,
  COMPETITOR_REPORT_MAX_LIMIT,
  COMPETITOR_REPORT_TOTAL_BUDGET_MS,
  CompetitorReportContractError,
  type CompetitorReport,
  type CompetitorReportErrorCode,
  type CompetitorReportRequest,
} from "./contracts.ts";
import { CompetitorReportStoreError } from "./reportStore.ts";

/* -------------------------------------------------------------------------- */
/* The request schema                                                            */
/* -------------------------------------------------------------------------- */

const limitSchema = z.number().int().min(1).max(COMPETITOR_REPORT_MAX_LIMIT).optional();

const cursorSchema = z.string().min(1).max(COMPETITOR_REPORT_MAX_CURSOR_LENGTH).optional();

const listRequestSchema = z.object({
  action: z.literal("list"),
  state: z.enum(["active", "removed"]),
  limit: limitSchema,
  cursor: cursorSchema,
}).strict();

const detailRequestSchema = z.object({
  action: z.literal("detail"),
  watchlist_id: z.string().uuid(),
  period_days: z.union([z.literal(7), z.literal(30)]),
  limit: limitSchema,
  cursor: cursorSchema,
}).strict();

const reportRequestSchema = z.discriminatedUnion("action", [
  listRequestSchema,
  detailRequestSchema,
]);

/* -------------------------------------------------------------------------- */
/* The dependencies                                                              */
/* -------------------------------------------------------------------------- */

/** The verified identity of the caller. */
export interface CompetitorReportIdentity {
  readonly userId: string;
  readonly isServiceRole: boolean;
}

export interface CompetitorReportHandlerDeps {
  /**
   * The shared authentication helper.
   *
   * It resolves the identity from the Authorization header and NEVER from
   * the request body.
   */
  readonly authenticate: (req: Request) => Promise<CompetitorReportIdentity>;
  /**
   * The reader.
   *
   * It receives the VERIFIED USER's bearer and forwards it unchanged to the
   * database, so PostgreSQL derives the owner from `auth.uid()`.
   */
  readonly readReport: (
    request: CompetitorReportRequest,
    verifiedBearer: string,
    now: Date,
  ) => Promise<CompetitorReport>;
  /** The clock. It is injected so the report is reproducible. */
  readonly nowFn?: () => Date;
  /** The audit sink. It never throws and never blocks the response. */
  readonly log?: (event: CompetitorReportLogEvent) => void;
}

/** One audit record. It carries no token, no body and no driver text. */
export interface CompetitorReportLogEvent {
  readonly event: "competitor_tracking_report";
  readonly action: string;
  readonly outcome: string;
  readonly status: number;
  readonly user_id?: string;
  readonly duration_ms?: number;
}

/* -------------------------------------------------------------------------- */
/* The deadline                                                                  */
/* -------------------------------------------------------------------------- */

export interface CompetitorReportDeadline {
  workMs(): number;
  totalMs(): number;
}

function createDeadline(startedAt: number): CompetitorReportDeadline {
  return {
    workMs: () =>
      COMPETITOR_REPORT_TOTAL_BUDGET_MS - COMPETITOR_REPORT_AUDIT_RESERVE_MS -
      (Date.now() - startedAt),
    totalMs: () => COMPETITOR_REPORT_TOTAL_BUDGET_MS - (Date.now() - startedAt),
  };
}

type BoundedOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "timeout" | "failed"; readonly error?: unknown };

/**
 * Runs one dependency inside a ceiling that is drawn from the REMAINING
 * budget.
 *
 * The losing promise is always settled, so a dependency that fails after the
 * caller gave up can never become an unhandled rejection and can never be
 * mistaken for a result.
 */
async function runBounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ceilingMs: number,
): Promise<BoundedOutcome<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{ readonly ok: false; readonly reason: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: "timeout" });
    }, Math.max(0, ceilingMs));
  });

  const settled = Promise.resolve()
    .then(() => work(controller.signal))
    .then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, reason: "failed", error }) as const,
    );

  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function dependencyCeiling(deadline: CompetitorReportDeadline): number {
  return Math.min(COMPETITOR_REPORT_DEPENDENCY_CEILING_MS, deadline.workMs());
}

/* -------------------------------------------------------------------------- */
/* The body                                                                      */
/* -------------------------------------------------------------------------- */

type BodyOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too_large" | "aborted" | "failed" };

function abandonReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // A synchronous cancel failure is not the body's outcome.
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BodyOutcome> {
  const body = request.body;
  if (!body) return { ok: false, reason: "failed" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  const onAbort = () => abandonReader(reader);
  signal.addEventListener("abort", onAbort, { once: true });
  const onCallerAbort = () => abandonReader(reader);
  request.signal.addEventListener("abort", onCallerAbort, { once: true });

  try {
    for (;;) {
      if (signal.aborted || request.signal.aborted) {
        abandonReader(reader);
        return { ok: false, reason: "aborted" };
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        abandonReader(reader);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }

    if (signal.aborted || request.signal.aborted) {
      return { ok: false, reason: "aborted" };
    }
  } catch {
    abandonReader(reader);
    return {
      ok: false,
      reason: signal.aborted || request.signal.aborted ? "aborted" : "failed",
    };
  } finally {
    signal.removeEventListener("abort", onAbort);
    request.signal.removeEventListener("abort", onCallerAbort);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(merged) };
}

/* -------------------------------------------------------------------------- */
/* The identity                                                                  */
/* -------------------------------------------------------------------------- */

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

/**
 * The bearer of the request.
 *
 * It is the SAME string the shared auth helper validates, because both read
 * the one Authorization header. The token is never logged and never echoed.
 */
function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = BEARER_PATTERN.exec(header);
  if (!match) return null;
  const token = match[1]!;
  return token.length > 0 ? token : null;
}

/* -------------------------------------------------------------------------- */
/* The responses                                                                 */
/* -------------------------------------------------------------------------- */

function jsonResponse(
  request: Request,
  body: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...restrictedCorsHeaders(request),
      "Content-Type": "application/json",
      // The report is one owner's private history. It is never stored by a
      // shared cache and never replayed after a sign-out.
      "Cache-Control": "no-store",
      ...(extraHeaders ?? {}),
    },
  });
}

/**
 * The stable error envelope: `{ "error": { "code": "..." } }`.
 *
 * The code is the whole contract. No message, no SQL fragment, no table
 * name and no driver text ever reaches the client.
 */
function errorResponse(
  request: Request,
  code: CompetitorReportErrorCode,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return jsonResponse(request, { error: { code } }, status, extraHeaders);
}

/* -------------------------------------------------------------------------- */
/* The handler                                                                   */
/* -------------------------------------------------------------------------- */

export function createCompetitorTrackingReportHandler(
  deps: CompetitorReportHandlerDeps,
): (request: Request) => Promise<Response> {
  const sink = deps.log ?? defaultLogSink;

  return async function handleCompetitorTrackingReport(request: Request): Promise<Response> {
    const startedAt = Date.now();
    const deadline = createDeadline(startedAt);

    // The audit context of this request. It is filled in as the request is
    // understood and it never carries anything but a closed literal and the
    // verified owner.
    const context: { action: string; userId?: string } = { action: "unknown" };

    const finish = (
      status: number,
      body: unknown,
      outcome: string,
      extraHeaders?: Record<string, string>,
    ): Response => {
      sink({
        event: "competitor_tracking_report",
        action: context.action,
        outcome,
        status,
        ...(context.userId ? { user_id: context.userId } : {}),
        duration_ms: Date.now() - startedAt,
      });
      return jsonResponse(request, body, status, extraHeaders);
    };

    const refuse = (
      status: number,
      code: CompetitorReportErrorCode,
      extraHeaders?: Record<string, string>,
    ): Response => {
      sink({
        event: "competitor_tracking_report",
        action: context.action,
        outcome: code,
        status,
        ...(context.userId ? { user_id: context.userId } : {}),
        duration_ms: Date.now() - startedAt,
      });
      return errorResponse(request, code, status, extraHeaders);
    };

    if (request.method === "OPTIONS") {
      // The preflight carries no body, no identity and no work.
      return new Response(null, { status: 204, headers: restrictedCorsHeaders(request) });
    }

    if (request.method !== "POST") {
      return refuse(405, "INVALID_REQUEST", { Allow: "POST, OPTIONS" });
    }

    // --- The body -------------------------------------------------------
    const bodyRead = await runBounded(
      (signal) => readBoundedBody(request, COMPETITOR_REPORT_MAX_BODY_BYTES, signal),
      dependencyCeiling(deadline),
    );

    if (!bodyRead.ok) {
      return refuse(503, "REPORT_UNAVAILABLE");
    }

    const body = bodyRead.value;
    if (!body.ok) {
      if (body.reason === "too_large") {
        return refuse(413, "INVALID_REQUEST");
      }
      if (body.reason === "aborted") {
        return refuse(503, "REPORT_UNAVAILABLE");
      }
      return refuse(400, "INVALID_REQUEST");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(body.text);
    } catch {
      return refuse(400, "INVALID_REQUEST");
    }

    const validated = reportRequestSchema.safeParse(parsedJson);
    if (!validated.success) {
      return refuse(400, "INVALID_REQUEST");
    }

    const input = validated.data;
    context.action = input.action;
    const reportRequest = toReportRequest(input);

    // --- The verified identity -----------------------------------------
    const bearer = readBearerToken(request);
    if (!bearer) {
      return refuse(401, "UNAUTHORIZED");
    }

    const authOutcome = await runBounded(
      () => deps.authenticate(request),
      dependencyCeiling(deadline),
    );

    if (!authOutcome.ok) {
      // The identity could not be established: the helper refused it, the
      // verifier could not be reached, or it did not answer in time. None of
      // those is a verified owner, so the request is refused.
      return refuse(401, "UNAUTHORIZED");
    }

    const identity = authOutcome.value;
    if (!identity || typeof identity.isServiceRole !== "boolean") {
      return refuse(401, "UNAUTHORIZED");
    }
    if (identity.isServiceRole) {
      // The service path never impersonates a user. The owner RPC derives
      // the owner from auth.uid(), so an impersonation would have to be a
      // different, unsound contract.
      return refuse(403, "UNAUTHORIZED");
    }
    if (typeof identity.userId !== "string" || identity.userId === "") {
      return refuse(401, "UNAUTHORIZED");
    }
    context.userId = identity.userId;

    // --- The read -------------------------------------------------------
    const now = deps.nowFn ? deps.nowFn() : new Date();

    const readOutcome = await runBounded(
      () => deps.readReport(reportRequest, bearer, now),
      dependencyCeiling(deadline),
    );

    if (!readOutcome.ok) {
      if (readOutcome.reason === "timeout") {
        return refuse(503, "REPORT_UNAVAILABLE");
      }
      const failure = mapFailure(readOutcome.error);
      return refuse(failure.status, failure.code);
    }

    return finish(200, readOutcome.value, "read");
  };
}

/**
 * The validated request.
 *
 * The limits and the cursor are already bounded by the schema; the default
 * limit is applied here so every consumer sees the same default.
 */
function toReportRequest(
  input: z.infer<typeof reportRequestSchema>,
): CompetitorReportRequest {
  const limit = input.limit ?? COMPETITOR_REPORT_DEFAULT_LIMIT;
  const cursor = input.cursor ?? null;

  if (input.action === "list") {
    return { action: "list", state: input.state, limit, cursor };
  }
  return {
    action: "detail",
    watchlistId: input.watchlist_id,
    periodDays: input.period_days,
    limit,
    cursor,
  };
}

/**
 * Maps a failure onto the stable code and the status.
 *
 * A refusal the database named is mapped exactly: a missing entry and
 * another owner's entry are the SAME 404, so the two cannot be told apart
 * from the outside.
 */
function mapFailure(error: unknown): { code: CompetitorReportErrorCode; status: number } {
  if (error instanceof CompetitorReportStoreError) {
    switch (error.failure) {
      case "not_found":
        return { code: "NOT_FOUND", status: 404 };
      case "forbidden":
        return { code: "UNAUTHORIZED", status: 401 };
      case "invalid":
        return { code: "INVALID_REQUEST", status: 400 };
      case "unavailable":
        return { code: "REPORT_UNAVAILABLE", status: 502 };
      default:
        return { code: "REPORT_UNAVAILABLE", status: 502 };
    }
  }

  if (error instanceof CompetitorReportContractError) {
    switch (error.code) {
      case "NOT_FOUND":
        return { code: "NOT_FOUND", status: 404 };
      case "UNAUTHORIZED":
        return { code: "UNAUTHORIZED", status: 401 };
      case "INVALID_REQUEST":
        return { code: "INVALID_REQUEST", status: 400 };
      default:
        return { code: "REPORT_UNAVAILABLE", status: 502 };
    }
  }

  return { code: "REPORT_UNAVAILABLE", status: 502 };
}

/**
 * The default audit sink.
 *
 * It writes ONE redacted line. The redaction is applied to the metadata, so
 * a token, a bearer or a credential can never reach the log even if a future
 * field carries one.
 */
function defaultLogSink(event: CompetitorReportLogEvent): void {
  const safe = redactSensitive({ ...event }) as Record<string, unknown>;
  console.log(JSON.stringify(safe));
}
