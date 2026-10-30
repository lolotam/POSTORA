/**
 * The Supabase adapter of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   Every wire name of this feature, mapped exactly once:
 *
 *     the report boundary    POST competitor-tracking-report
 *     the collection boundary POST competitor-snapshot-sync
 *     the owner RPCs         read_own_competitor_quota()
 *                            add_competitor_watchlist(text, text)
 *                            update_competitor_watchlist(uuid, text, boolean)
 *
 *   Nothing above this layer knows that a quota is an RPC, that a
 *   collection is an Edge Function or that a tracked handle lives in a
 *   table.
 *
 * THE RULES THIS MODULE ENFORCES
 *
 *   - EVERY CALL IS BOUNDED. A function call and an RPC call each run
 *     inside a deadline and are actually aborted when it expires. An
 *     unbounded call in a browser is a hung screen.
 *   - A FAILED READ IS NEVER AN EMPTY READ. A broken payload, a failed
 *     statement and a timeout are typed failures.
 *   - A LOST WRITE IS INDETERMINATE. A mutation whose outcome could not
 *     be observed is never reported as a failure and never retried.
 *   - THE SERVER'S ERROR TEXT NEVER REACHES THE CALLER. A stable
 *     `COMPETITOR_*` identifier or a SQLSTATE is mapped to a closed code
 *     here; the raw message is dropped.
 *   - THE REPORT PAYLOAD IS VALIDATED. The DTO is read by an independent
 *     reader, so an unknown version, a missing key or an unsafe number
 *     fails the read.
 *
 * WHY THE ERROR ENVELOPES ARE READ SEPARATELY
 *
 *   The two boundaries speak different dialects and the difference is
 *   not cosmetic:
 *
 *     the report boundary    { "error": { "code": "NOT_FOUND" } }
 *     the collection boundary { "error": "not_found" }
 *
 *   One is an object with an upper-snake code, the other is a bare
 *   string. Reading them with one parser would either accept the wrong
 *   shape or reject the right one.
 */

import { supabase } from "@/integrations/supabase/client";

import {
  COMPETITOR_REPORT_MAX_CURSOR_LENGTH,
  COMPETITOR_REPORT_MAX_LIMIT,
  parseCompetitorQuota,
  parseCompetitorReport,
  type CompetitorReportDetail,
  type CompetitorReportList,
  type CompetitorReportQuota,
} from "../domain/contracts";
import { CompetitorTrackingError, type CompetitorTrackingErrorCode } from "../domain/errors";
import type {
  CompetitorAddInput,
  CompetitorAddResult,
  CompetitorCollectionStatus,
  CompetitorDetailRequest,
  CompetitorEnqueueInput,
  CompetitorEnqueueResult,
  CompetitorListRequest,
  CompetitorReadOptions,
  CompetitorSetActiveInput,
  CompetitorSetActiveResult,
  CompetitorStatusRequest,
  CompetitorTrackingGateway,
} from "../application/ports";

/* -------------------------------------------------------------------------- */
/* The boundaries                                                                 */
/* -------------------------------------------------------------------------- */

const REPORT_FUNCTION = "competitor-tracking-report";
const SYNC_FUNCTION = "competitor-snapshot-sync";

/**
 * The ceiling of one report read.
 *
 * The server's own budget is fifteen seconds; the client waits a little
 * longer so the SERVER's refusal wins over the client's timeout and the
 * owner sees the server's reason.
 */
export const COMPETITOR_REPORT_TIMEOUT_MS = 20_000;

/** The ceiling of one collection call. */
export const COMPETITOR_COLLECTION_TIMEOUT_MS = 15_000;

/** The ceiling of one owner RPC. */
export const COMPETITOR_OWNER_RPC_TIMEOUT_MS = 10_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------------- */
/* The deadline                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of one bounded call.
 *
 * The discriminant is a STRING, not a boolean: this repository compiles
 * with `strictNullChecks: false`, and TypeScript does not narrow a
 * union on a boolean literal in that mode.
 */
type BoundedOutcome<T> =
  | { readonly status: "ok"; readonly value: T }
  | {
      readonly status: "failed";
      readonly reason: "timeout" | "aborted" | "error";
      readonly error?: unknown;
    };

/**
 * Runs one call inside a ceiling and aborts it when the ceiling expires.
 *
 * The losing promise is always settled, so a call that fails after the
 * caller gave up can never become an unhandled rejection.
 */
async function runBounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ceilingMs: number,
  callerSignal?: AbortSignal,
): Promise<BoundedOutcome<T>> {
  if (callerSignal?.aborted) {
    return { status: "failed", reason: "aborted" };
  }

  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: "failed", reason: "timeout" });
    }, ceilingMs);
  });

  const settled: Promise<BoundedOutcome<T>> = Promise.resolve()
    .then(() => work(controller.signal))
    .then(
      (value): BoundedOutcome<T> =>
        // A call that finished AFTER the caller cancelled is still an
        // abort: the caller has already moved on and must not be shown
        // the answer of a request it no longer wants.
        callerSignal?.aborted
          ? { status: "failed", reason: "aborted" }
          : { status: "ok", value },
      (error: unknown): BoundedOutcome<T> =>
        // A call that failed because the CALLER cancelled is an abort,
        // not a failed read: the query layer has to be able to tell the
        // two apart.
        callerSignal?.aborted
          ? { status: "failed", reason: "aborted" }
          : { status: "failed", reason: "error", error },
    );

  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * The abort error a cancelled read throws.
 *
 * It is a real `AbortError`, so the query layer recognises it as a
 * cancellation instead of a failure and keeps the previous owner's data
 * from flashing.
 */
function createAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/* -------------------------------------------------------------------------- */
/* The wire readers                                                               */
/* -------------------------------------------------------------------------- */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(response: Response | null): Promise<unknown> {
  if (response === null) return null;
  try {
    const text = await response.text();
    if (text.trim() === "") return null;
    return JSON.parse(text) as unknown;
  } catch {
    // A body that is not JSON is not an envelope. It is an unknown
    // failure, and the caller maps it through the status code.
    return null;
  }
}

function requireString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * The report boundary's error envelope: `{ "error": { "code": "..." } }`.
 *
 * The code is the whole contract. A body that carries anything else is
 * an unknown failure.
 */
function readReportErrorCode(payload: unknown): CompetitorTrackingErrorCode | null {
  if (!isPlainRecord(payload)) return null;
  const error = payload.error;
  if (!isPlainRecord(error)) return null;
  const code = error.code;
  if (code === "INVALID_REQUEST" || code === "UNAUTHORIZED" || code === "NOT_FOUND") {
    return code;
  }
  if (code === "REPORT_UNAVAILABLE") return code;
  return null;
}

/**
 * The collection boundary's error envelope: `{ "error": "not_found" }`.
 *
 * A bare string, in lower snake case. It is normalised into this
 * feature's closed vocabulary here, once.
 */
function readCollectionErrorCode(payload: unknown): CompetitorTrackingErrorCode | null {
  if (!isPlainRecord(payload)) return null;
  const error = payload.error;
  if (typeof error !== "string") return null;

  switch (error) {
    case "invalid_request":
    case "method_not_allowed":
    case "payload_too_large":
      return "INVALID_REQUEST";
    case "unauthorized":
      return "UNAUTHORIZED";
    case "forbidden":
      return "FORBIDDEN";
    case "not_found":
      return "NOT_FOUND";
    case "throttled":
      return "THROTTLED";
    case "collection_disabled":
      return "COLLECTION_DISABLED";
    case "protected_credentials_required":
      return "PROTECTED_CREDENTIALS_REQUIRED";
    case "settings_unavailable":
      return "SETTINGS_UNAVAILABLE";
    case "request_unavailable":
    case "service_auth_unavailable":
    case "work_indeterminate":
      return "REQUEST_UNAVAILABLE";
    case "enqueue_indeterminate":
      return "ENQUEUE_INDETERMINATE";
    case "status_unavailable":
      return "STATUS_UNAVAILABLE";
    default:
      return null;
  }
}

/**
 * The fallback code of an HTTP status with no readable envelope.
 *
 * It is only reached when the body was not one of the two known
 * envelopes, so it must stay coarse.
 */
function statusFallbackCode(
  status: number | null,
  fallback: CompetitorTrackingErrorCode,
): CompetitorTrackingErrorCode {
  if (status === 400 || status === 405 || status === 413) return "INVALID_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "THROTTLED";
  return fallback;
}

/**
 * The retry time of a refused call.
 *
 * The collection endpoint publishes `retry_after_seconds` in the BODY.
 * The `Retry-After` HEADER is the fallback, and the body wins because
 * the endpoint's restricted CORS policy does not expose the header to
 * the browser.
 */
function readRetryAfterSeconds(
  payload: unknown,
  response: Response | null,
): number | null {
  if (isPlainRecord(payload)) {
    const seconds = payload.retry_after_seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
      return Math.trunc(seconds);
    }
  }
  const header = response?.headers.get("Retry-After");
  if (header === null || header === undefined) return null;
  const parsed = Number.parseInt(header, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Maps a PostgREST error to this feature's vocabulary.
 *
 * The stable `COMPETITOR_*` identifiers are the sanctioned way to tell
 * the refusals apart; the SQLSTATE carries the rest. The raw message is
 * deliberately dropped: it can contain plan names and counts that are
 * not display copy.
 *
 * `transport` is the code of a call whose outcome could not be observed.
 * For a MUTATION that is indeterminate - the statement may have
 * committed. For a READ it is simply an unavailable read: nothing was
 * written, so nothing is unknown.
 */
function mapRpcError(
  error: unknown,
  fallback: CompetitorTrackingErrorCode,
  transport: CompetitorTrackingErrorCode,
): CompetitorTrackingError {
  if (!isPlainRecord(error)) {
    return new CompetitorTrackingError(transport, "the request could not be completed");
  }

  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";

  if (message.startsWith("COMPETITOR_QUOTA_EXCEEDED")) {
    return new CompetitorTrackingError("QUOTA_EXCEEDED", "the tracked-competitor limit is reached");
  }
  if (message.startsWith("COMPETITOR_USERNAME_INVALID")) {
    return new CompetitorTrackingError("INVALID_HANDLE", "the handle has a shape Instagram never issues");
  }
  if (message.startsWith("COMPETITOR_LABEL_INVALID")) {
    return new CompetitorTrackingError("LABEL_INVALID", "the label is longer than the database accepts");
  }
  if (message.startsWith("COMPETITOR_NOT_FOUND")) {
    return new CompetitorTrackingError("NOT_FOUND", "that competitor is not on the list");
  }
  if (message.startsWith("COMPETITOR_ADD_DENIED") || message.startsWith("COMPETITOR_UPDATE_DENIED")) {
    return new CompetitorTrackingError("UNAUTHORIZED", "the request needs a signed-in owner");
  }

  if (code === "42501") {
    return new CompetitorTrackingError("UNAUTHORIZED", "the request needs a signed-in owner");
  }
  if (code === "P0002") {
    return new CompetitorTrackingError("NOT_FOUND", "that competitor is not on the list");
  }

  // A statement that was rejected carries a SQLSTATE. A statement whose
  // outcome could not be observed does not.
  if (code === "") {
    return new CompetitorTrackingError(transport, "the request could not be completed");
  }

  return new CompetitorTrackingError(fallback, "the request could not be completed");
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The Supabase implementation of the competitor tracking port.
 */
export class SupabaseCompetitorTrackingGateway implements CompetitorTrackingGateway {
  /* --- The report boundary --------------------------------------------- */

  async list(
    request: CompetitorListRequest,
    options?: CompetitorReadOptions,
  ): Promise<CompetitorReportList> {
    const report = await this.readReport(
      {
        action: "list",
        state: request.state,
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.cursor === undefined || request.cursor === null
          ? {}
          : { cursor: request.cursor }),
      },
      options,
    );

    if (!("entries" in report)) {
      throw new CompetitorTrackingError("REPORT_UNAVAILABLE", "the report is not a competitor list");
    }
    return report;
  }

  async detail(
    request: CompetitorDetailRequest,
    options?: CompetitorReadOptions,
  ): Promise<CompetitorReportDetail> {
    if (!UUID_PATTERN.test(request.watchlistId)) {
      throw new CompetitorTrackingError("INVALID_REQUEST", "the watchlist id is not a uuid");
    }

    const report = await this.readReport(
      {
        action: "detail",
        watchlist_id: request.watchlistId,
        period_days: request.periodDays,
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.cursor === undefined || request.cursor === null
          ? {}
          : { cursor: request.cursor }),
      },
      options,
    );

    if (!("media" in report)) {
      throw new CompetitorTrackingError("REPORT_UNAVAILABLE", "the report is not a competitor detail");
    }
    return report;
  }

  /* --- The owner RPCs -------------------------------------------------- */

  async quota(options?: CompetitorReadOptions): Promise<CompetitorReportQuota> {
    const outcome = await runBounded(
      async (signal) => await supabase.rpc("read_own_competitor_quota").abortSignal(signal),
      COMPETITOR_OWNER_RPC_TIMEOUT_MS,
      options?.signal,
    );

    if (outcome.status !== "ok") {
      if (outcome.reason === "aborted") throw createAbortError();
      throw new CompetitorTrackingError("REPORT_UNAVAILABLE", "the tracked-competitor limit could not be read");
    }

    const { data, error } = outcome.value;
    if (error) {
      throw mapRpcError(error, "REPORT_UNAVAILABLE", "REPORT_UNAVAILABLE");
    }

    try {
      return parseCompetitorQuota(data);
    } catch {
      throw new CompetitorTrackingError("REPORT_UNAVAILABLE", "the tracked-competitor limit is malformed");
    }
  }

  async add(input: CompetitorAddInput): Promise<CompetitorAddResult> {
    const outcome = await runBounded(
      async (signal) =>
        await supabase
          .rpc("add_competitor_watchlist", {
            p_username: input.username,
            p_label: input.label ?? null,
          })
          .abortSignal(signal),
      COMPETITOR_OWNER_RPC_TIMEOUT_MS,
    );

    if (outcome.status !== "ok") {
      if (outcome.reason === "aborted" || outcome.reason === "timeout") {
        throw new CompetitorTrackingError(
          "MUTATION_INDETERMINATE",
          "the competitor could not be confirmed as tracked",
        );
      }
      throw new CompetitorTrackingError("MUTATION_UNAVAILABLE", "the competitor could not be tracked");
    }

    const { data, error } = outcome.value;
    if (error) {
      throw mapRpcError(error, "MUTATION_UNAVAILABLE", "MUTATION_INDETERMINATE");
    }

    const payload = isPlainRecord(data) ? data : null;
    if (payload === null) {
      throw new CompetitorTrackingError("MUTATION_INDETERMINATE", "the competitor could not be confirmed as tracked");
    }

    const watchlistId = requireString(payload.watchlist_id);
    const username = requireString(payload.username);
    const status = requireString(payload.status);
    if (watchlistId === null || username === null || status === null) {
      throw new CompetitorTrackingError("MUTATION_INDETERMINATE", "the competitor could not be confirmed as tracked");
    }

    const reactivated = payload.reactivated === true;
    const alreadyTracked = payload.already_tracked === true;

    return {
      watchlistId,
      username,
      isActive: payload.is_active !== false,
      status,
      reactivated,
      alreadyTracked,
      // The already-tracked reply legitimately carries NO quota. That is
      // not a broken payload and it is not a failure.
      quota: this.readOptionalQuota(payload.quota),
    };
  }

  async setActive(input: CompetitorSetActiveInput): Promise<CompetitorSetActiveResult> {
    const outcome = await runBounded(
      async (signal) =>
        await supabase
          .rpc("update_competitor_watchlist", {
            p_watchlist_id: input.watchlistId,
            // A null label PRESERVES the stored label. The database has
            // no convention for clearing one and this feature invents
            // none.
            p_label: input.label ?? null,
            p_is_active: input.isActive,
          })
          .abortSignal(signal),
      COMPETITOR_OWNER_RPC_TIMEOUT_MS,
    );

    if (outcome.status !== "ok") {
      if (outcome.reason === "aborted" || outcome.reason === "timeout") {
        throw new CompetitorTrackingError(
          "MUTATION_INDETERMINATE",
          "the change could not be confirmed",
        );
      }
      throw new CompetitorTrackingError("MUTATION_UNAVAILABLE", "the competitor could not be updated");
    }

    const { data, error } = outcome.value;
    if (error) {
      throw mapRpcError(error, "MUTATION_UNAVAILABLE", "MUTATION_INDETERMINATE");
    }

    const payload = isPlainRecord(data) ? data : null;
    if (payload === null) {
      throw new CompetitorTrackingError("MUTATION_INDETERMINATE", "the change could not be confirmed");
    }

    const watchlistId = requireString(payload.watchlist_id);
    const username = requireString(payload.username);
    const status = requireString(payload.status);
    if (watchlistId === null || username === null || status === null) {
      throw new CompetitorTrackingError("MUTATION_INDETERMINATE", "the change could not be confirmed");
    }

    return {
      watchlistId,
      username,
      label: optionalString(payload.label),
      isActive: payload.is_active === true,
      removedAt: optionalString(payload.removed_at),
      status,
      quota: this.readOptionalQuota(payload.quota),
    };
  }

  /* --- The collection boundary ----------------------------------------- */

  async enqueue(input: CompetitorEnqueueInput): Promise<CompetitorEnqueueResult> {
    if (!UUID_PATTERN.test(input.watchlistId)) {
      throw new CompetitorTrackingError("INVALID_REQUEST", "the watchlist id is not a uuid");
    }

    const outcome = await runBounded(
      async (signal) =>
        await supabase.functions.invoke<unknown>(SYNC_FUNCTION, {
          body: {
            mode: input.force ? "force" : "entry",
            watchlist_id: input.watchlistId,
          },
          signal,
        }),
      COMPETITOR_COLLECTION_TIMEOUT_MS,
    );

    if (outcome.status !== "ok") {
      if (outcome.reason === "aborted") throw createAbortError();
      if (outcome.reason === "timeout") {
        // The statement may have committed. The enqueue is never replayed.
        throw new CompetitorTrackingError(
          "ENQUEUE_INDETERMINATE",
          "the collection could not be confirmed",
        );
      }
      throw new CompetitorTrackingError("ENQUEUE_INDETERMINATE", "the collection could not be confirmed");
    }

    const { data, error, response } = outcome.value;
    const responseObject = response ?? null;

    if (error) {
      if (responseObject === null) {
        // The collector could not be reached at all. Whether the
        // statement committed is unknown, so the enqueue is never
        // replayed and never reported as a refusal.
        throw new CompetitorTrackingError(
          "ENQUEUE_INDETERMINATE",
          "the collection could not be confirmed",
        );
      }
      const payload = await readJsonBody(responseObject);
      const code =
        readCollectionErrorCode(payload) ??
        statusFallbackCode(responseObject.status, "REQUEST_UNAVAILABLE");
      throw new CompetitorTrackingError(code, "the collection could not be started", {
        retryAfterSeconds: readRetryAfterSeconds(payload, responseObject),
      });
    }

    const payload = isPlainRecord(data) ? data : null;
    if (payload === null) {
      throw new CompetitorTrackingError("ENQUEUE_INDETERMINATE", "the collection could not be confirmed");
    }

    if (payload.accepted === true) {
      return {
        outcome: "accepted",
        reason: requireString(payload.reason) ?? "queued",
        jobId: optionalString(payload.job_id),
        jobGeneration: optionalCount(payload.job_generation),
        status: optionalString(payload.status),
        capturedOn: optionalString(payload.captured_on),
      };
    }

    if (payload.accepted === false) {
      return {
        outcome: "deferred",
        reason: requireString(payload.reason) ?? "throttled",
        retryAfterSeconds: readRetryAfterSeconds(payload, responseObject) ?? 60,
        capturedOn: optionalString(payload.captured_on),
      };
    }

    // A receipt that is neither an acceptance nor a refusal is a receipt
    // this client does not understand. The write's outcome is unknown.
    throw new CompetitorTrackingError("ENQUEUE_INDETERMINATE", "the collection could not be confirmed");
  }

  async status(
    request: CompetitorStatusRequest,
    options?: CompetitorReadOptions,
  ): Promise<CompetitorCollectionStatus> {
    if (!UUID_PATTERN.test(request.watchlistId)) {
      throw new CompetitorTrackingError("INVALID_REQUEST", "the watchlist id is not a uuid");
    }

    const outcome = await runBounded(
      async (signal) =>
        await supabase.functions.invoke<unknown>(SYNC_FUNCTION, {
          body: { mode: "status", watchlist_id: request.watchlistId },
          signal,
        }),
      COMPETITOR_COLLECTION_TIMEOUT_MS,
      options?.signal,
    );

    if (outcome.status !== "ok") {
      if (outcome.reason === "aborted") throw createAbortError();
      throw new CompetitorTrackingError("STATUS_UNAVAILABLE", "the collection status could not be read");
    }

    const { data, error, response } = outcome.value;
    const responseObject = response ?? null;

    if (error) {
      const payload = await readJsonBody(responseObject);
      const code =
        readCollectionErrorCode(payload) ??
        statusFallbackCode(responseObject?.status ?? null, "STATUS_UNAVAILABLE");
      throw new CompetitorTrackingError(code, "the collection status could not be read");
    }

    const payload = isPlainRecord(data) ? data : null;
    if (payload === null) {
      throw new CompetitorTrackingError("STATUS_UNAVAILABLE", "the collection status could not be read");
    }

    const targetKind = requireString(payload.target_kind);
    const targetId = requireString(payload.target_id);
    const capturedOn = requireString(payload.captured_on);
    const status = requireString(payload.status);
    const jobGeneration = optionalCount(payload.job_generation);
    const attempts = optionalCount(payload.attempts);
    const pendingOperations = optionalCount(payload.pending_operations);

    if (
      targetKind === null ||
      targetId === null ||
      capturedOn === null ||
      status === null ||
      jobGeneration === null ||
      attempts === null ||
      pendingOperations === null
    ) {
      throw new CompetitorTrackingError("STATUS_UNAVAILABLE", "the collection status could not be read");
    }

    // A NO job is a fact about the data ("none"), not a failed read. A
    // failed read raised above and never reaches this point.
    return {
      targetKind,
      targetId,
      capturedOn,
      status,
      jobGeneration,
      attempts,
      dueAt: optionalString(payload.due_at),
      nextRetryAt: optionalString(payload.next_retry_at),
      lastAttemptAt: optionalString(payload.last_attempt_at),
      lastSuccessAt: optionalString(payload.last_success_at),
      reasonCode: optionalString(payload.reason_code),
      pendingOperations,
    };
  }

  /* --- The internals ---------------------------------------------------- */

  private readOptionalQuota(value: unknown): CompetitorReportQuota | null {
    if (value === undefined || value === null) return null;
    try {
      return parseCompetitorQuota(value);
    } catch {
      return null;
    }
  }

  /**
   * Refuses a page size or a cursor the report boundary would refuse.
   *
   * The server is the authority and would answer INVALID_REQUEST anyway.
   * The check here saves a round trip and keeps the refusal typed.
   */
  private assertReportPaging(body: Record<string, unknown>): void {
    const limit = body.limit;
    if (
      limit !== undefined &&
      (typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > COMPETITOR_REPORT_MAX_LIMIT)
    ) {
      throw new CompetitorTrackingError(
        "INVALID_REQUEST",
        "the page size is outside the range the report accepts",
      );
    }

    const cursor = body.cursor;
    if (
      cursor !== undefined &&
      (typeof cursor !== "string" ||
        cursor.length === 0 ||
        cursor.length > COMPETITOR_REPORT_MAX_CURSOR_LENGTH)
    ) {
      throw new CompetitorTrackingError(
        "INVALID_REQUEST",
        "the cursor is not a cursor the report accepts",
      );
    }
  }

  private async readReport(
    body: Record<string, unknown>,
    options?: CompetitorReadOptions,
  ): Promise<CompetitorReportList | CompetitorReportDetail> {
    this.assertReportPaging(body);

    const outcome = await runBounded(
      async (signal) =>
        await supabase.functions.invoke<unknown>(REPORT_FUNCTION, {
          body,
          signal,
        }),
      COMPETITOR_REPORT_TIMEOUT_MS,
      options?.signal,
    );

    if (outcome.status !== "ok") {
      if (outcome.reason === "aborted") throw createAbortError();
      throw new CompetitorTrackingError("REPORT_UNAVAILABLE", "the competitor report could not be read");
    }

    const { data, error, response } = outcome.value;
    const responseObject = response ?? null;

    if (error) {
      const payload = await readJsonBody(responseObject);
      const code =
        readReportErrorCode(payload) ??
        statusFallbackCode(responseObject?.status ?? null, "REPORT_UNAVAILABLE");
      throw new CompetitorTrackingError(code, "the competitor report could not be read");
    }

    try {
      return parseCompetitorReport(data);
    } catch {
      // An unknown version, a missing key or an unsafe number is a
      // broken payload. It is never repaired and never read as an empty
      // report.
      throw new CompetitorTrackingError("REPORT_UNAVAILABLE", "the competitor report is malformed");
    }
  }
}

/**
 * The default adapter.
 *
 * The composition root of the feature wires this instance into the
 * application layer.
 */
export const defaultCompetitorTrackingGateway = new SupabaseCompetitorTrackingGateway();
