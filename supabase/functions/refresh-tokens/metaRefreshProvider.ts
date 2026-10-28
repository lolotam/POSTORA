/**
 * Bounded provider and alert transport for the protected Meta refresh.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The two outbound calls of the protected direct refresh: the Instagram
 *   token refresh itself, and the post-commit failure notification. Both are
 *   bounded, both validate what came back, and neither ever lets a credential
 *   reach a log line, a history row or a browser response.
 *
 * WHY THE SHAPE IS STRICT
 *
 *   The legacy helper (`_shared/social-auth.ts`) accepts any truthy token and
 *   substitutes a 60 day lifetime when the provider omits one. Both are
 *   unacceptable for a protected account: a fabricated expiry is a false
 *   claim about a credential, and a truthy check accepts whitespace and
 *   object-shaped junk. This module therefore owns its own parser and never
 *   inherits a lifetime it was not given.
 *
 *   The expiry of a refreshed token is anchored at the moment the request
 *   started, not at the moment the response was processed. A slow response
 *   must not move that lifetime. If the selected instant is already past
 *   when the body arrives, the token is refused before any writer.
 *
 * SECRETS
 *
 *   The refresh endpoint carries the credential in the query string, so the
 *   URL is a secret. Nothing here logs a URL, a request body, a provider
 *   body or a thrown error: the transport reports a stable category and the
 *   provider text is discarded.
 */

import {
  cleanExpirySeconds,
  createOperationBudget,
  protectedFetchJson,
  ProtectedProviderFailure,
  type OperationBudget,
} from "../_shared/metaOAuthProtectedBoundary.ts";
import { isPermanentMetaError, parseMetaError } from "../_shared/metaErrors.ts";
import type { MetaRefreshErrorCategory } from "./metaRefreshStore.ts";

/** The one supported refresh endpoint. A Page token never enters this URL. */
export const DIRECT_REFRESH_ENDPOINT =
  "https://graph.instagram.com/refresh_access_token";

/** One request, headers and body together. The accepted boundary owns this. */
export const PROTECTED_REFRESH_HTTP_TIMEOUT_MS = 8_000;

/** The notification call is bounded the same way as the provider call. */
export const PROTECTED_ALERT_HTTP_TIMEOUT_MS = 8_000;

/** The longest access token the accepted SQL will store. */
const MAX_ACCESS_TOKEN_LENGTH = 4096;

export type DirectRefreshProviderOutcome =
  | {
    kind: "success";
    accessToken: string;
    tokenExpiresAt: string;
    /** Null when the provider returned no refresh token. The stored one is preserved. */
    refreshToken: string | null;
  }
  | { kind: "classified_failure"; category: MetaRefreshErrorCategory }
  /** The provider failed in a way that cannot be attributed. The capture is retained. */
  | { kind: "unclassified_failure" };

// ---------------------------------------------------------------------------
// Provider failure classification
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasStructuredMetaError(body: unknown): boolean {
  if (!isPlainRecord(body)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(body, "error");
  if (descriptor === undefined || !("value" in descriptor)) return false;
  return isPlainRecord(descriptor.value);
}

/**
 * Turns a provider failure into one of the accepted SQL categories.
 *
 * The structured Meta error wins over the HTTP status, exactly as
 * `_shared/metaErrors.ts` decides it: a permanent `OAuthException` 190 or a
 * permanent subcode is permanent even on a 500, and a rate limit is
 * retryable even on a 400.
 *
 * A response that carries no Meta error object and no recognizable status is
 * NOT attributed. It is returned as unclassified so the caller defers with a
 * retained capture instead of counting a failure it cannot prove.
 */
export function classifyProviderFailure(input: {
  status: number;
  body: unknown;
}): { category: MetaRefreshErrorCategory } | { category: null } {
  const { status, body } = input;

  if (hasStructuredMetaError(body)) {
    const parsed = parseMetaError(status, body);

    // A permanent grant failure. Meta's structured contract proves that the
    // grant must be re-authorized; it does not distinguish an expiry from a
    // revocation, and every permanent category carries the same SQL policy
    // (count and latch), so one category is used instead of inventing a
    // distinction the provider contract does not make.
    if (isPermanentMetaError(parsed)) return { category: "provider_invalid_grant" };

    if (parsed.transient) {
      if (status === 429) return { category: "provider_rate_limited" };
      if (status >= 500) return { category: "provider_unavailable" };
      // A structured code that survives as transient is one of Meta's
      // rate-limit codes.
      if (parsed.code !== undefined) return { category: "provider_rate_limited" };
      return { category: "provider_transient" };
    }

    // A documented permission rejection. It counts toward the ceiling of
    // three; it is never immediate permanent evidence.
    if (parsed.code === 200) return { category: "provider_permission_denied" };

    // Meta's documented code 1 is a counted provider error. Any other
    // object is not evidence: the presence of an error object alone must
    // not count, and the provider text is never retained.
    if (parsed.type === "OAuthException" && parsed.code === 1) {
      return { category: "provider_error" };
    }
    return { category: null };
  }

  if (status === 429) return { category: "provider_rate_limited" };
  if (status === 408 || status === 425) return { category: "provider_transient" };
  if (status >= 500) return { category: "provider_unavailable" };
  return { category: null };
}

// ---------------------------------------------------------------------------
// Success validation
// ---------------------------------------------------------------------------

/**
 * A credential string the accepted SQL will store unchanged.
 *
 * The value must already be clean: non-blank, no surrounding whitespace,
 * no ASCII controls and no DEL, and no longer than the column. A dirty
 * value is refused. It is never trimmed or repaired.
 */
function cleanCredential(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_ACCESS_TOKEN_LENGTH) return null;
  if (value.trim() !== value) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return value;
}

/**
 * The provider refresh token, when the body carries one.
 *
 * A missing key, an explicit null and an explicit undefined preserve the
 * stored token. Any other unusable value is malformed: it is not an
 * omission, and it must not clear the stored token by being dropped.
 */
function parseRefreshToken(
  body: Record<string, unknown>,
): { ok: true; refreshToken: string | null } | { ok: false } {
  const descriptor = Object.getOwnPropertyDescriptor(body, "refresh_token");
  if (descriptor === undefined || !("value" in descriptor)) {
    return { ok: true, refreshToken: null };
  }
  if (descriptor.value === undefined || descriptor.value === null) {
    return { ok: true, refreshToken: null };
  }
  const token = cleanCredential(descriptor.value);
  if (token === null) return { ok: false };
  return { ok: true, refreshToken: token };
}

/**
 * A bearer type, when the provider supplies one. Meta answers `bearer`.
 */
function hasValidTokenType(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  return value.trim().toLowerCase() === "bearer";
}

/**
 * Validates a successful refresh body.
 *
 * The expiry is computed from the returned `expires_in` and the moment the
 * request started. A missing or unusable lifetime is a malformed response,
 * never a default: a fabricated 60 day expiry is how a dead token keeps
 * looking alive.
 */
export function parseDirectRefreshSuccess(
  body: unknown,
  requestStartedAtMs: number,
): { ok: true; accessToken: string; tokenExpiresAt: string; refreshToken: string | null } | {
  ok: false;
} {
  if (!isPlainRecord(body)) return { ok: false };
  if (body.error !== undefined && body.error !== null) return { ok: false };

  const accessDescriptor = Object.getOwnPropertyDescriptor(body, "access_token");
  if (accessDescriptor === undefined || !("value" in accessDescriptor)) return { ok: false };
  const accessToken = cleanCredential(accessDescriptor.value);
  if (accessToken === null) return { ok: false };
  if (!hasValidTokenType(body.token_type)) return { ok: false };

  const expiresIn = cleanExpirySeconds(body.expires_in);
  if (expiresIn === null || expiresIn <= 0) return { ok: false };

  const expiresAtMs = requestStartedAtMs + expiresIn * 1000;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= requestStartedAtMs) return { ok: false };

  const refreshToken = parseRefreshToken(body);
  if (!refreshToken.ok) return { ok: false };

  return {
    ok: true,
    accessToken,
    tokenExpiresAt: new Date(expiresAtMs).toISOString(),
    refreshToken: refreshToken.refreshToken,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface MetaRefreshTransportOptions {
  /** The Supabase base URL the notification endpoint lives under. */
  supabaseUrl?: string;
  /** The service role key the notification endpoint requires. */
  serviceRoleKey?: string;
  /** A strict owner-scoped read of the profile email. */
  readProfileEmail?: (userId: string) => PromiseLike<unknown>;
  /** Injected for tests. The production path uses the global fetch. */
  fetcher?: typeof fetch;
  /** Injected for tests. The production path uses the wall clock. */
  now?: () => number;
}

export interface MetaRefreshTransport {
  refreshDirectToken(input: {
    capturedToken: string;
    budget: OperationBudget;
  }): Promise<DirectRefreshProviderOutcome>;
  sendFailureAlert(input: {
    accountId: string;
    platform: string;
    username?: string | null;
    userId: string;
    errorCategory: string;
    failureCount: number;
    needsReauth: boolean;
    budget: OperationBudget;
  }): Promise<ProtectedAlertResult>;
}

export type ProtectedAlertOutcome = "accepted" | "unconfirmed" | "not_attempted";

export interface ProtectedAlertResult {
  outcome: ProtectedAlertOutcome;
  /** A stable reason. Never provider text, never a token, never a URL. */
  reason: string;
}

/**
 * Waits for one alert read only until the budget says so.
 *
 * Settling this race does not cancel the database query. The read may still
 * be running after the caller has stopped waiting. A late rejection is
 * attached so it cannot surface as unhandled.
 */
function readWithinBudget<T>(pending: PromiseLike<T>, timeoutMs: number): Promise<T> {
  const wrapped = Promise.resolve(pending);
  wrapped.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ProtectedProviderFailure("provider_timeout"));
    }, timeoutMs);
  });
  return Promise.race([wrapped, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function createMetaRefreshTransport(
  options: MetaRefreshTransportOptions = {},
): MetaRefreshTransport {
  const fetcher = options.fetcher;
  const now = options.now ?? Date.now;

  return {
    async refreshDirectToken(input) {
      const requestStartedAtMs = now();

      let timeoutMs: number;
      try {
        timeoutMs = input.budget.take(PROTECTED_REFRESH_HTTP_TIMEOUT_MS);
      } catch {
        // The account budget is gone. Nothing was sent, and a timeout is a
        // transient condition: it never counts against the grant.
        return { kind: "classified_failure", category: "provider_transient" };
      }

      // The credential travels in the query string, because this endpoint is
      // GET-only. The URL is therefore a secret and is never logged.
      const url =
        `${DIRECT_REFRESH_ENDPOINT}?grant_type=ig_refresh_token&access_token=` +
        encodeURIComponent(input.capturedToken);

      let response: { status: number; ok: boolean; body: unknown };
      try {
        response = await protectedFetchJson(url, { method: "GET" }, {
          timeoutMs,
          fetcher,
        });
      } catch (error) {
        if (error instanceof ProtectedProviderFailure && error.category === "provider_timeout") {
          return { kind: "classified_failure", category: "provider_transient" };
        }
        // A transport failure is never permanent evidence about the grant.
        return { kind: "classified_failure", category: "provider_transient" };
      }

      if (!response.ok) {
        const classified = classifyProviderFailure({
          status: response.status,
          body: response.body,
        });
        if (classified.category === null) return { kind: "unclassified_failure" };
        return { kind: "classified_failure", category: classified.category };
      }

      const parsed = parseDirectRefreshSuccess(response.body, requestStartedAtMs);
      if (!parsed.ok) {
        // A successful HTTP response that does not carry a usable token is a
        // malformed response. It counts toward the ceiling of three; it is
        // never immediate permanent evidence.
        return { kind: "classified_failure", category: "provider_response_invalid" };
      }

      // The lifetime stays anchored at the request start. Checked after the
      // body and before any writer: if that instant is already past, the
      // selected token is expired. It is not extended to the body clock.
      const selectedExpiryMs = Date.parse(parsed.tokenExpiresAt);
      if (!Number.isFinite(selectedExpiryMs) || selectedExpiryMs <= now()) {
        return { kind: "classified_failure", category: "provider_response_invalid" };
      }

      return {
        kind: "success",
        accessToken: parsed.accessToken,
        tokenExpiresAt: parsed.tokenExpiresAt,
        refreshToken: parsed.refreshToken,
      };
    },

    async sendFailureAlert(input) {
      const baseUrl = options.supabaseUrl;
      const serviceRoleKey = options.serviceRoleKey;
      if (!baseUrl || !serviceRoleKey) {
        return { outcome: "not_attempted", reason: "alert_transport_not_configured" };
      }

      if (!options.readProfileEmail) {
        return { outcome: "not_attempted", reason: "alert_profile_reader_missing" };
      }

      // Remaining budget before any alert work. An exhausted budget does not
      // start the profile read and does not start delivery.
      let profileTimeoutMs: number;
      try {
        profileTimeoutMs = input.budget.take(PROTECTED_ALERT_HTTP_TIMEOUT_MS);
      } catch {
        return { outcome: "not_attempted", reason: "alert_budget_exhausted" };
      }

      let profileRaw: unknown;
      try {
        profileRaw = await readWithinBudget(
          options.readProfileEmail(input.userId),
          profileTimeoutMs,
        );
      } catch (error) {
        if (error instanceof ProtectedProviderFailure && error.category === "provider_timeout") {
          // The caller stopped waiting. That does not cancel the database query.
          return { outcome: "not_attempted", reason: "alert_profile_deadline" };
        }
        return { outcome: "not_attempted", reason: "alert_profile_read_failed" };
      }

      const profile = parseProfileEmailRead(profileRaw, input.userId);
      if (!profile.ok) {
        return { outcome: "not_attempted", reason: "alert_profile_read_failed" };
      }

      // Delivery uses the same remaining budget. The accepted fetch bounds
      // the wait; aborting it does not prove the remote request stopped, and
      // HTTP 200 is not a delivery claim unless success is exactly true.
      let timeoutMs: number;
      try {
        timeoutMs = input.budget.take(PROTECTED_ALERT_HTTP_TIMEOUT_MS);
      } catch {
        return { outcome: "not_attempted", reason: "alert_budget_exhausted" };
      }

      const body = {
        failures: [
          {
            platform: input.platform,
            accountId: input.accountId,
            username: input.username ?? undefined,
            userId: input.userId,
            userEmail: profile.email ?? "",
            // The stable category is the whole error surface. A provider
            // message never reaches this endpoint.
            errorMessage: input.errorCategory,
            failedAt: new Date(now()).toISOString(),
            failureCount: input.failureCount,
            needsReauth: input.needsReauth,
          },
        ],
      };

      let response: { status: number; ok: boolean; body: unknown };
      try {
        response = await protectedFetchJson(
          `${baseUrl}/functions/v1/send-token-failure-alert`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${serviceRoleKey}`,
            },
            body: JSON.stringify(body),
          },
          { timeoutMs, fetcher },
        );
      } catch {
        // A delivery failure is not a refresh failure. The committed failure,
        // its counter and its alert marker stay exactly as the database wrote
        // them.
        return { outcome: "not_attempted", reason: "alert_delivery_failed" };
      }

      if (!response.ok) {
        return { outcome: "not_attempted", reason: "alert_delivery_failed" };
      }

      // The endpoint has HTTP 200 routes that carry no `success` flag: no
      // admin recipients, notifications disabled, or nothing to report. A 200
      // is therefore never proof that an email was delivered.
      if (isPlainRecord(response.body) && response.body.success === true) {
        return { outcome: "accepted", reason: "alert_accepted" };
      }
      return { outcome: "unconfirmed", reason: "alert_unconfirmed" };
    },
  };
}

/**
 * A strict owner-scoped read of one profile email.
 *
 * The envelope is checked the same way the accepted stores check it: an own
 * `data` property, an own `error: null`, and an own `email` property on the
 * row. A missing row is a genuine absence, not a failure; a malformed
 * envelope is a failure.
 */
export function parseProfileEmailRead(
  raw: unknown,
  expectedUserId?: string,
): { ok: true; email: string | null } | { ok: false } {
  if (!isPlainRecord(raw)) return { ok: false };
  const dataDescriptor = Object.getOwnPropertyDescriptor(raw, "data");
  const errorDescriptor = Object.getOwnPropertyDescriptor(raw, "error");
  if (!dataDescriptor || !("value" in dataDescriptor)) return { ok: false };
  if (!errorDescriptor || !("value" in errorDescriptor)) return { ok: false };
  if (errorDescriptor.value !== null) return { ok: false };
  if (dataDescriptor.value === null) return { ok: true, email: null };
  if (!isPlainRecord(dataDescriptor.value)) return { ok: false };

  // The projection supplies `id` beside the email. When the caller names the
  // owner, that id has to be the same owner. A missing row stays absence.
  if (expectedUserId !== undefined) {
    const idDescriptor = Object.getOwnPropertyDescriptor(dataDescriptor.value, "id");
    if (!idDescriptor || !("value" in idDescriptor) || idDescriptor.value !== expectedUserId) {
      return { ok: false };
    }
  }

  const emailDescriptor = Object.getOwnPropertyDescriptor(dataDescriptor.value, "email");
  if (!emailDescriptor || !("value" in emailDescriptor)) return { ok: false };
  if (emailDescriptor.value === null) return { ok: true, email: null };
  if (typeof emailDescriptor.value !== "string") return { ok: false };
  if (emailDescriptor.value.length === 0) return { ok: true, email: null };
  return { ok: true, email: emailDescriptor.value };
}

/**
 * A per-account budget that covers the provider call and the notification
 * together. The worst case of the accepted legacy account path is 24s, and
 * this budget never exceeds it.
 */
export function createAccountRefreshBudget(
  totalMs: number,
  now: () => number = Date.now,
): OperationBudget {
  return createOperationBudget(totalMs, now);
}
