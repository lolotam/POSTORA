/**
 * The typed errors of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   One closed vocabulary of failures the feature can report, and one
 *   error class that carries it. Every expected failure of the report
 *   boundary, of the owner RPCs and of the collection endpoint arrives
 *   here already normalized (ARCHITECTURE §32: expected business
 *   failures use typed errors, never thrown strings).
 *
 * WHY THE VOCABULARY IS CLOSED
 *
 *   The three boundaries speak three different dialects:
 *
 *     the report boundary   { "error": { "code": "REPORT_UNAVAILABLE" } }
 *     the collection endpoint { "error": "throttled" }
 *     PostgREST             { code: "23514", message: "COMPETITOR_..." }
 *
 *   The UI must not parse any of them. Infrastructure translates them
 *   into the codes below, exactly once, and the UI maps a code to a
 *   translated string. A code that is not in this list is never shown.
 *
 * THE THREE GROUPS
 *
 *   1. The report codes are the server's, verbatim. A report that fails
 *      is a report that is unavailable - never an empty report.
 *   2. The mutation codes name what the owner RPC refused. A refusal is
 *      a DEFINITE outcome: the statement was rejected and nothing was
 *      written.
 *   3. The collection codes name what stopped the enqueue. An
 *      indeterminate enqueue is its own code, because a lost write is
 *      never replayed automatically and never reported as a failure.
 */

/**
 * The closed set of failure codes of this feature.
 */
export type CompetitorTrackingErrorCode =
  /* The report boundary - the server's codes, verbatim. */
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "REPORT_UNAVAILABLE"
  /* The owner RPC mutations - a definite refusal. */
  | "QUOTA_EXCEEDED"
  | "INVALID_HANDLE"
  | "LABEL_INVALID"
  | "MUTATION_UNAVAILABLE"
  /* A mutation whose outcome could not be observed. */
  | "MUTATION_INDETERMINATE"
  /* The collection endpoint - the server's codes, normalised. */
  | "THROTTLED"
  | "COLLECTION_DISABLED"
  | "PROTECTED_CREDENTIALS_REQUIRED"
  | "SETTINGS_UNAVAILABLE"
  | "REQUEST_UNAVAILABLE"
  | "ENQUEUE_INDETERMINATE"
  | "STATUS_UNAVAILABLE"
  | "FORBIDDEN";

/**
 * A typed failure of the competitor tracking feature.
 *
 * `retryAfterSeconds` is the server's own deferral, when it published
 * one. It is never invented here.
 */
export class CompetitorTrackingError extends Error {
  readonly code: CompetitorTrackingErrorCode;

  /** The server's deferral, or null when the server published none. */
  readonly retryAfterSeconds: number | null;

  constructor(
    code: CompetitorTrackingErrorCode,
    message: string,
    options?: { retryAfterSeconds?: number | null },
  ) {
    super(message);
    this.name = "CompetitorTrackingError";
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds ?? null;
  }
}

/** Whether the value is a typed failure of this feature. */
export function isCompetitorTrackingError(value: unknown): value is CompetitorTrackingError {
  return value instanceof CompetitorTrackingError;
}

/**
 * The codes that mean "the outcome of the write is unknown".
 *
 * A caller must NOT retry these automatically and must NOT report them
 * as a failure: the statement may or may not have committed, so the only
 * honest next step is a read.
 */
export const INDETERMINATE_ERROR_CODES: readonly CompetitorTrackingErrorCode[] = [
  "MUTATION_INDETERMINATE",
  "ENQUEUE_INDETERMINATE",
];

/** Whether the code means the outcome of the write is unknown. */
export function isIndeterminateErrorCode(code: CompetitorTrackingErrorCode): boolean {
  return INDETERMINATE_ERROR_CODES.includes(code);
}
