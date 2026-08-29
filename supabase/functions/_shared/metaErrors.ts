/**
 * Meta's structured error payload, reduced to the fields that are safe to log.
 *
 * Never widen this to carry the request URL or the raw fetch error: Meta passes the
 * credential in the request, and Deno embeds the full URL in network error messages.
 */
export interface MetaProviderError {
  type?: string;
  code?: number;
  error_subcode?: number;
  message?: string;
  /** Timeout, network failure or 5xx — retryable, and never a reason to force reauth. */
  transient: boolean;
}

export type MetaRefreshOutcome =
  | { ok: true; access_token: string; expires_in: number }
  | { ok: false; error: MetaProviderError };

/** Subcodes Meta documents as "the user must re-authorize". */
const META_PERMANENT_SUBCODES = new Set([458, 460, 463, 467]);

/**
 * Whether this failure means the grant is dead and no retry will help.
 *
 * Deliberately typed, not string-matched: PERMANENT_AUTH_ERRORS in refresh-tokens is a
 * substring matcher, and putting a bare `190` in it would match any message containing
 * those digits — an object id, a timestamp — and permanently flag a healthy account.
 */
export function isPermanentMetaError(error: MetaProviderError): boolean {
  if (error.transient) return false;
  if (error.type === "OAuthException" && error.code === 190) return true;
  return error.error_subcode !== undefined && META_PERMANENT_SUBCODES.has(error.error_subcode);
}

/**
 * Meta rate-limit codes. Not invented here — `_shared/threads-debug.ts` already
 * classifies exactly these, and duplicating that knowledge incompletely is how a rate
 * limit ends up counted as an auth failure.
 */
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** HTTP statuses that mean "ask again later", not "this grant is dead". */
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

/**
 * Reduce a Meta response to the sanitized fields worth logging, and decide whether the
 * failure is retryable.
 *
 * `transient` is NOT simply `status >= 500`. That naive rule is wrong in both directions:
 *   - HTTP 429 with code 4/17/32/613 is a rate limit, but would read as non-transient and,
 *     after three of them, latch a perfectly healthy account red.
 *   - HTTP 500 carrying {type:"OAuthException", code:190} is definitive evidence the grant
 *     is dead, but would read as transient and be retried forever.
 * Structured provider evidence therefore wins over the HTTP status.
 */
export function parseMetaError(status: number, body: unknown): MetaProviderError {
  const raw = (body as { error?: Record<string, unknown> } | null)?.error;
  const code = typeof raw?.code === "number" ? raw.code : undefined;
  const subcode = typeof raw?.error_subcode === "number" ? raw.error_subcode : undefined;
  const type = typeof raw?.type === "string" ? raw.type : undefined;

  // 1. A structured permanent code outranks any status.
  const structurallyPermanent =
    (type === "OAuthException" && code === 190) ||
    (subcode !== undefined && META_PERMANENT_SUBCODES.has(subcode));

  // 2. A structured rate limit is retryable however the status reads.
  const structurallyRetryable =
    (code !== undefined && META_RATE_LIMIT_CODES.has(code)) ||
    raw?.is_transient === true;

  const transient = structurallyPermanent
    ? false
    : structurallyRetryable || RETRYABLE_STATUSES.has(status) || status >= 500;

  return {
    type,
    code,
    error_subcode: subcode,
    message: typeof raw?.message === "string" ? raw.message : undefined,
    transient,
  };
}
