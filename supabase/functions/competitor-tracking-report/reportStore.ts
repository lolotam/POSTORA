/**
 * The database adapter of the competitor tracking report.
 *
 * WHAT THIS MODULE OWNS
 *
 *   Every database access this feature makes: exactly one RPC, with the
 *   VERIFIED USER's own bearer, and the strict validation of what the
 *   database actually returned.
 *
 * WHY THE READ RUNS AS THE CALLER
 *
 *   `read_own_competitor_tracking_report` is granted to `authenticated` and
 *   explicitly revoked from the service role. It derives the owner from
 *   `auth.uid()`, so the request has to reach PostgreSQL with the CALLER's
 *   own bearer - the public project key as the apikey, the user's token as
 *   the Authorization header.
 *
 *   A service-role call has no user to scope to, and a service-role call
 *   that names one would be an impersonation. This adapter therefore has no
 *   service-role path at all: the bearer is a parameter and it is always the
 *   verified user's bearer.
 *
 * WHY A FAILED READ IS NEVER AN EMPTY ONE
 *
 *   A missing `error` is a malformed envelope, not a completed read, and an
 *   explicit null error is the only completed read. A driver error is
 *   classified by its SQLSTATE and by the stable identifier the SQL reader
 *   puts at the front of its own message; the message itself is NEVER
 *   copied, because a PostgREST message can quote SQL, a table name or an
 *   id.
 *
 *   The same rule applies to the payload: a projection that does not have
 *   the documented shape is a failure, not an empty report. A refusal and
 *   an empty list are different facts and must never look alike.
 */

import {
  COMPETITOR_REPORT_MAX_CURSOR_LENGTH,
  CompetitorReportContractError,
  isRecord,
  type CompetitorReportRequest,
  type RawReportProjection,
} from "./contracts.ts";

/**
 * The RPC caller.
 *
 * The bearer is a parameter of every call: the adapter never holds a token
 * of its own and never falls back to a service credential.
 */
export type CompetitorReportRpcCaller = (
  functionName: string,
  args: Record<string, unknown>,
  verifiedBearer: string,
) => Promise<unknown>;

/** The stable failure kinds of the store. */
export type CompetitorReportStoreFailure =
  | "not_found"
  | "forbidden"
  | "invalid"
  | "unavailable"
  | "read_failed";

/**
 * A store failure.
 *
 * The message is fixed: it carries no driver text, no SQL fragment, no id
 * and no token.
 */
export class CompetitorReportStoreError extends Error {
  readonly failure: CompetitorReportStoreFailure;
  readonly sqlstate: string | null;

  constructor(failure: CompetitorReportStoreFailure, sqlstate: string | null = null) {
    super("The competitor tracking report could not be read.");
    this.name = "CompetitorReportStoreError";
    this.failure = failure;
    this.sqlstate = sqlstate;
  }
}

/** The RPC the report reads through. */
export const COMPETITOR_REPORT_RPC = "read_own_competitor_tracking_report";

/**
 * The reader.
 *
 * It owns the request shape, the identity of the call and the validation of
 * the answer. It owns no business rule: the assembler turns the projection
 * into the public DTO.
 */
export class CompetitorReportStore {
  constructor(private readonly rpc: CompetitorReportRpcCaller) {}

  /**
   * Reads the raw projection of one report request.
   *
   * @param request The validated request.
   * @param verifiedBearer The VERIFIED USER's bearer. It is forwarded
   *   unchanged, so the database derives the owner from `auth.uid()`.
   * @throws CompetitorReportStoreError when the read failed.
   * @throws CompetitorReportContractError when the answer is malformed.
   */
  async readReportInput(
    request: CompetitorReportRequest,
    verifiedBearer: string,
  ): Promise<RawReportProjection> {
    let envelope: unknown;
    try {
      envelope = await this.rpc(
        COMPETITOR_REPORT_RPC,
        { p_request: toRpcRequest(request) },
        verifiedBearer,
      );
    } catch (error) {
      if (error instanceof CompetitorReportStoreError) throw error;
      throw new CompetitorReportStoreError("read_failed");
    }

    const data = readCompletedData(envelope);
    return readProjection(data, request);
  }
}

/* -------------------------------------------------------------------------- */
/* The request                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The request the database expects.
 *
 * The SQL reader refuses an unknown key and refuses a key that does not
 * belong to the action, so the keys are added conditionally: a list carries
 * no watchlist id and no period, and a detail carries no state.
 */
export function toRpcRequest(request: CompetitorReportRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { action: request.action };

  if (request.action === "list") {
    payload.state = request.state;
  } else {
    payload.watchlist_id = request.watchlistId;
    payload.period_days = request.periodDays;
  }

  payload.limit = request.limit;

  if (request.cursor !== null) payload.cursor = request.cursor;

  return payload;
}

/* -------------------------------------------------------------------------- */
/* The failure classification                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The stable identifiers the SQL reader puts at the front of its messages.
 *
 * Only the identifier is read. The rest of the message is never copied.
 */
const SQL_IDENTIFIER_RE = /^(COMPETITOR_REPORT_[A-Z_]+)/;

/**
 * Classifies a driver error.
 *
 * The SQLSTATE is read first because it is the most stable signal; the
 * identifier refines it, and it is the identifier that names the refusal
 * the boundary maps onto a status code.
 */
function classifyDriverError(error: unknown): CompetitorReportStoreError {
  if (!isRecord(error)) {
    return new CompetitorReportStoreError("read_failed");
  }

  const code = error.code;
  const sqlstate = typeof code === "string" ? code : null;

  const message = error.message;
  const identifier = typeof message === "string"
    ? SQL_IDENTIFIER_RE.exec(message)?.[1] ?? null
    : null;

  if (identifier === "COMPETITOR_REPORT_NOT_FOUND" || sqlstate === "P0002") {
    return new CompetitorReportStoreError("not_found", sqlstate);
  }
  if (identifier === "COMPETITOR_REPORT_UNAUTHENTICATED" || sqlstate === "42501") {
    return new CompetitorReportStoreError("forbidden", sqlstate);
  }
  if (
    identifier === "COMPETITOR_REPORT_INVALID_REQUEST" ||
    identifier === "COMPETITOR_REPORT_INVALID_CURSOR" ||
    sqlstate === "22023"
  ) {
    return new CompetitorReportStoreError("invalid", sqlstate);
  }
  if (sqlstate === "PGRST202" || sqlstate === "42883" || sqlstate === "42P01") {
    // The reader or one of its tables is not deployed.
    return new CompetitorReportStoreError("unavailable", sqlstate);
  }

  return new CompetitorReportStoreError("read_failed", sqlstate);
}

/**
 * Reads the payload of a completed call.
 *
 * A missing `error` property is a malformed envelope and a failure: it is
 * never read as a completed read. A missing `data` is a failure as well: a
 * completed read that carries no projection is not an empty report.
 */
function readCompletedData(envelope: unknown): unknown {
  if (!isRecord(envelope)) {
    throw new CompetitorReportStoreError("read_failed");
  }
  if (!("error" in envelope) || !("data" in envelope)) {
    throw new CompetitorReportStoreError("read_failed");
  }
  const error = envelope.error;
  if (error !== null) {
    throw classifyDriverError(error);
  }
  const data = envelope.data;
  if (data === null || data === undefined) {
    throw new CompetitorReportStoreError("read_failed");
  }
  return data;
}

/* -------------------------------------------------------------------------- */
/* The payload                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads the projection the database returned.
 *
 * The envelope is validated here. The ROWS are validated by the assembler,
 * which knows what a row means; this module only proves that what came back
 * is a projection of the requested action at all.
 */
function readProjection(data: unknown, request: CompetitorReportRequest): RawReportProjection {
  if (!isRecord(data)) {
    throw malformed("the reader returned a payload that is not an object");
  }

  if (data.version !== 1) {
    throw malformed("the reader returned another projection version");
  }

  if (data.action !== request.action) {
    throw malformed("the reader answered another action");
  }

  if (typeof data.as_of !== "string" || data.as_of.trim() === "") {
    throw malformed("the reader returned no as_of");
  }

  if (typeof data.capture_timezone !== "string" || data.capture_timezone.trim() === "") {
    throw malformed("the reader returned no capture timezone");
  }

  if (!isRecord(data.quota)) {
    throw malformed("the reader returned no quota");
  }

  readCursor(data.next_cursor);

  if (!Array.isArray(data.entries)) {
    throw malformed("the reader returned no entries array");
  }

  if (!Array.isArray(data.media)) {
    throw malformed("the reader returned no media array");
  }

  readActionShape(data, request);

  return data as unknown as RawReportProjection;
}

/**
 * The cursor of the projection.
 *
 * It is an opaque, bounded string. The database produced it with the exact
 * timestamp precision of the rows, and this module never re-encodes it.
 */
function readCursor(raw: unknown): void {
  if (raw === null || raw === undefined) return;
  if (typeof raw !== "string") {
    throw malformed("the reader returned a malformed cursor");
  }
  if (raw.length > COMPETITOR_REPORT_MAX_CURSOR_LENGTH) {
    throw malformed("the reader returned an oversized cursor");
  }
}

/**
 * The shape the action requires.
 *
 * A list carries no entry and a detail carries exactly the entry that was
 * asked for. A detail that answers another entry is a broken read, not a
 * silently wrong answer.
 */
function readActionShape(data: Record<string, unknown>, request: CompetitorReportRequest): void {
  if (request.action === "detail") {
    if (!isRecord(data.entry)) {
      throw malformed("the reader returned no entry for a detail read");
    }
    if (data.entry.watchlist_id !== request.watchlistId) {
      throw malformed("the reader answered for another entry");
    }
    return;
  }

  if (data.entry !== null && data.entry !== undefined) {
    throw malformed("the reader returned an entry for a list read");
  }
}

/** A malformed upstream payload. It is never an empty report. */
function malformed(reason: string): CompetitorReportContractError {
  return new CompetitorReportContractError("REPORT_UNAVAILABLE", reason);
}
