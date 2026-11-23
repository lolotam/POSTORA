/**
 * Lease-serialised YouTube OAuth access token refresh.
 *
 * All native YouTube token refresh paths (cron/force refresh, publishing JIT,
 * upload continuation, scheduled publishing JIT, and comment operations) run
 * through this module so concurrent workers cannot race against Google's token
 * endpoint or overwrite each other's credentials.
 *
 * Security invariants:
 * - Credentials travel only in RPC POST bodies, never in PostgREST URL filters.
 * - No access token, refresh token, or client secret is ever logged or
 *   returned in error reasons.
 * - Writes (both fresh tokens and invalid_grant -> needs_reauth) are fenced on
 *   the DB lease token so a stale holder writes nothing.
 * - A refresh response that omits refresh_token preserves the stored one.
 */

import { splitScopeString } from "./youtubeCommentCapability.ts";

/** Refresh tokens when 30 minutes or less remain on their 1-hour lifetime. */
export const YOUTUBE_TOKEN_REFRESH_WINDOW_MS = 30 * 60 * 1000;

/** Default lease duration held across one Google token exchange + DB commit. */
export const DEFAULT_YOUTUBE_REFRESH_LEASE_TTL_SECONDS = 60;

/** Bound outbound provider latency (ARCHITECTURE.md §26). */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export interface YouTubeStoredAccount {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  needs_reauth?: boolean | null;
  is_active?: boolean | null;
  auth_provider?: string | null;
}

export type AcquireLeaseResult =
  | { ok: true; lease_token: string; expires_at: string }
  | { ok: false; reason: string; expires_at?: string | null };

export type StoreTokenWithLeaseResult =
  | { ok: true }
  | { ok: false; reason: string };

export type RecordFailureWithLeaseResult =
  | {
    ok: true;
    needs_reauth: boolean;
    failure_count: number;
    transitioned: boolean;
    enqueued: number;
  }
  | { ok: false; reason: string };

export interface YouTubeRefreshStore {
  acquireLease(
    accountId: string,
    ttlSeconds: number,
  ): Promise<AcquireLeaseResult>;
  releaseLease(accountId: string, leaseToken: string): Promise<boolean>;
  readAccount(accountId: string): Promise<YouTubeStoredAccount | null>;
  storeTokenWithLease(input: {
    accountId: string;
    leaseToken: string;
    accessToken: string;
    tokenExpiresAt: string;
    refreshToken: string | null;
    grantedScopes: string[] | null;
  }): Promise<StoreTokenWithLeaseResult>;
  recordFailureWithLease(input: {
    accountId: string;
    leaseToken: string;
    errorMessage: string;
    isInvalidGrant: boolean;
    maxFailures?: number;
    lastAlertSentAt?: string | null;
  }): Promise<RecordFailureWithLeaseResult>;
}

export type GoogleRefreshExchangeResult =
  | {
    ok: true;
    accessToken: string;
    expiresIn: number;
    refreshToken: string | null;
    scope: string | null;
  }
  | {
    ok: false;
    invalidGrant: boolean;
    retryable: boolean;
    reason: string;
    status?: number;
  };

export type YouTubeRefreshOutcome =
  | {
    ok: true;
    status: "fresh" | "refreshed" | "reused";
    accessToken: string;
    expiresAt: string | null;
    grantedScopes: string[] | null;
  }
  | {
    ok: false;
    status: "needs_reauth" | "retryable_refusal" | "failed";
    retryable: boolean;
    reason: string;
    accessToken: string | null;
    expiresAt: string | null;
    needsReauth: boolean;
    transitioned?: boolean;
  };

export interface RefreshYouTubeAccountOptions {
  accountId: string;
  /** Optional already-loaded account snapshot for fast-path freshness checks. */
  snapshot?: Partial<YouTubeStoredAccount>;
  /** Force a refresh even when token_expires_at looks fresh (e.g. after a 401). */
  force?: boolean;
  /**
   * When true, non-invalid_grant failures also record failure_count via
   * recordFailureWithLease (used by refresh-tokens). On-demand callers leave
   * this false so transient 5xx/network errors never mutate failure_count.
   * invalid_grant ALWAYS records needs_reauth via recordFailureWithLease.
   */
  recordTransientFailure?: boolean;
  /**
   * Administrator recovery mode (force-refresh routes). Permits the token
   * exchange to run under the lease for an account already flagged
   * needs_reauth: the store RPC clears the flag as part of the persisted
   * write. Ordinary publishing refusals never set this, so a needs_reauth
   * account keeps refusing until an administrator or the user reconnects.
   */
  adminRecovery?: boolean;
  /**
   * Health-neutral mode (Stage 4 comment operations, spec 11). The exchange
   * and the token store run under the lease exactly as usual, but this call
   * never records account health: an invalid_grant does NOT set needs_reauth
   * and does not count a failure, and a successful exchange does NOT rewrite
   * `granted_scopes`. The refusal is still returned to the caller. Default
   * false: every existing caller behaves as before.
   */
  healthNeutral?: boolean;
  maxFailures?: number;
  lastAlertSentAt?: string | null;
  refreshWindowMs?: number;
  leaseTtlSeconds?: number;
  store: YouTubeRefreshStore;
  exchange?: (refreshToken: string) => Promise<GoogleRefreshExchangeResult>;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  log?: (level: "warn" | "error" | "info", message: string) => void;
}

/**
 * Whether a YouTube access token should be refreshed.
 * A missing or unparseable expiry is treated as expired.
 */
export function youtubeTokenNeedsRefresh(
  tokenExpiresAt: string | null | undefined,
  nowMs: number,
  windowMs = YOUTUBE_TOKEN_REFRESH_WINDOW_MS,
): boolean {
  if (!tokenExpiresAt) return true;
  const expiresAt = Date.parse(tokenExpiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - nowMs <= windowMs;
}

function isReusableFreshToken(
  fresh: YouTubeStoredAccount,
  nowMs: number,
  windowMs: number,
  force: boolean,
  priorAccessToken: string | null | undefined,
): fresh is YouTubeStoredAccount & { access_token: string } {
  if (!fresh.access_token) return false;
  // Both token-reuse success shortcuts refuse a flagged row: under admin
  // recovery the exchange must run so the store clears the flag, and a
  // flagged row was never a healthy token to reuse.
  if (fresh.needs_reauth === true) return false;
  if (youtubeTokenNeedsRefresh(fresh.token_expires_at, nowMs, windowMs)) {
    return false;
  }
  // Under force the stored token is only reused when it is provably NOT the
  // token the caller just saw fail: a known prior that differs. Without a
  // known prior there is nothing to compare, and reuse would re-send the very
  // token the caller suspects, so the lease holder refreshes instead.
  if (force && (!priorAccessToken || fresh.access_token === priorAccessToken)) {
    return false;
  }
  return true;
}

function sanitizeErrorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return "UnknownError";
}

function defaultLog(level: "warn" | "error" | "info", message: string): void {
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.log(message);
}

/**
 * OAuth error codes Google documents for the token endpoint. Each maps to the
 * fixed label it keeps in the log: a code the provider sends is a fact, the
 * string the provider sends is untrusted text.
 */
const KNOWN_OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "temporarily_unavailable",
  "invalid_client",
  "invalid_request",
  "unauthorized_client",
  "invalid_scope",
  "server_error",
]);

/**
 * The fixed log label for a provider refusal code. A recognized OAuth code is
 * echoed as itself; anything else — including a hostile endpoint echoing
 * credential-shaped text — collapses to one fixed label. The raw value never
 * reaches a log line.
 */
function sanitizedProviderErrorCode(providerError: string | null): string {
  if (!providerError) return "http_error";
  return KNOWN_OAUTH_ERROR_CODES.has(providerError)
    ? providerError
    : "unrecognized_provider_error";
}

/**
 * Exchanges a YouTube refresh token at Google's OAuth2 token endpoint.
 * Never logs credentials, request URLs, or raw provider error descriptions.
 */
export async function exchangeGoogleRefreshToken(
  refreshToken: string,
  options: {
    accountId: string;
    fetchImpl?: typeof fetch;
    log?: (level: "warn" | "error" | "info", message: string) => void;
  },
): Promise<GoogleRefreshExchangeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? defaultLog;
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      invalidGrant: false,
      retryable: false,
      reason: "refresh_not_configured",
    };
  }

  let response: Response;
  try {
    response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Log error.name only: Deno network errors can embed URLs or request context.
    log(
      "warn",
      `[youtube-refresh] token exchange failed for account=${options.accountId} error=${sanitizeErrorName(error)}`,
    );
    return {
      ok: false,
      invalidGrant: false,
      retryable: true,
      reason: "refresh_request_failed",
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    log(
      "warn",
      `[youtube-refresh] unreadable token response for account=${options.accountId} status=${response.status} error=${sanitizeErrorName(error)}`,
    );
    return {
      ok: false,
      invalidGrant: false,
      retryable: true,
      reason: "refresh_answer_unreadable",
      status: response.status,
    };
  }

  const body = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
  const providerError = typeof body.error === "string" ? body.error : null;

  if (!response.ok || providerError) {
    const isInvalidGrant = providerError === "invalid_grant";
    const retryable = !isInvalidGrant &&
      (response.status >= 500 ||
        response.status === 429 ||
        providerError === "temporarily_unavailable");
    log(
      "warn",
      `[youtube-refresh] provider refused refresh for account=${options.accountId} status=${response.status} code=${sanitizedProviderErrorCode(providerError)}`,
    );
    return {
      ok: false,
      invalidGrant: isInvalidGrant,
      retryable,
      reason: isInvalidGrant ? "invalid_grant" : "refresh_refused",
      status: response.status,
    };
  }

  const accessToken = typeof body.access_token === "string" &&
      body.access_token.length > 0
    ? body.access_token
    : null;
  const expiresIn = typeof body.expires_in === "number" &&
      Number.isFinite(body.expires_in) &&
      body.expires_in > 0
    ? body.expires_in
    : 0;
  if (!accessToken || expiresIn <= 0) {
    return {
      ok: false,
      invalidGrant: false,
      retryable: true,
      reason: "refresh_answer_incomplete",
    };
  }

  const rotatedRefresh = typeof body.refresh_token === "string" &&
      body.refresh_token.length > 0
    ? body.refresh_token
    : null;
  const scope = typeof body.scope === "string" && body.scope.trim().length > 0
    ? body.scope
    : null;

  return {
    ok: true,
    accessToken,
    expiresIn,
    refreshToken: rotatedRefresh,
    scope,
  };
}

interface RefreshQueryResult {
  data: unknown;
  error: unknown;
}

/** The client surface the lease store uses; rows stay `unknown` and are narrowed where read. */
interface YouTubeRefreshClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RefreshQueryResult>;
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): { maybeSingle(): PromiseLike<RefreshQueryResult> };
    };
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Supabase service-role adapter for the YouTube refresh lease RPCs. The parameter is
 * `unknown` because callers hold clients created against different supabase-js versions
 * and a typed client overflows TypeScript's instantiation depth (TS2589); it is narrowed
 * to the small surface above on entry.
 */
export function createSupabaseYouTubeRefreshStore(admin: unknown): YouTubeRefreshStore {
  const supabase = admin as YouTubeRefreshClient;
  return {
    async acquireLease(accountId, ttlSeconds) {
      const { data: raw, error } = await supabase.rpc(
        "acquire_youtube_refresh_lease",
        {
          p_account_id: accountId,
          p_ttl_seconds: ttlSeconds,
        },
      );
      const data = asRecord(raw);
      if (error || !data) {
        return { ok: false, reason: "lease_acquire_failed" };
      }
      if (data.ok === true && typeof data.lease_token === "string") {
        return {
          ok: true,
          lease_token: data.lease_token,
          expires_at: typeof data.expires_at === "string" ? data.expires_at : "",
        };
      }
      return {
        ok: false,
        reason: typeof data.reason === "string"
          ? data.reason
          : "lease_acquire_failed",
        expires_at: typeof data.expires_at === "string" ? data.expires_at : null,
      };
    },

    async releaseLease(accountId, leaseToken) {
      const { data, error } = await supabase.rpc(
        "release_youtube_refresh_lease",
        {
          p_account_id: accountId,
          p_lease_token: leaseToken,
        },
      );
      if (error) return false;
      return data === true;
    },

    async readAccount(accountId) {
      const { data: raw, error } = await supabase
        .from("social_accounts")
        .select(
          "id, access_token, refresh_token, token_expires_at, needs_reauth, is_active, auth_provider",
        )
        .eq("id", accountId)
        .maybeSingle();
      if (error) {
        throw new Error("youtube_account_read_failed");
      }
      const data = asRecord(raw);
      if (!data) return null;
      return {
        id: String(data.id),
        access_token: typeof data.access_token === "string"
          ? data.access_token
          : null,
        refresh_token: typeof data.refresh_token === "string"
          ? data.refresh_token
          : null,
        token_expires_at: typeof data.token_expires_at === "string"
          ? data.token_expires_at
          : null,
        needs_reauth: data.needs_reauth === true,
        is_active: data.is_active !== false,
        auth_provider: typeof data.auth_provider === "string"
          ? data.auth_provider
          : null,
      };
    },

    async storeTokenWithLease(input) {
      const { data: raw, error } = await supabase.rpc(
        "store_youtube_refreshed_token_with_lease",
        {
          p_account_id: input.accountId,
          p_lease_token: input.leaseToken,
          p_new_access_token: input.accessToken,
          p_new_token_expires_at: input.tokenExpiresAt,
          p_new_refresh_token: input.refreshToken,
          p_granted_scopes: input.grantedScopes,
        },
      );
      const data = asRecord(raw);
      if (error || !data) {
        return { ok: false, reason: "store_failed" };
      }
      if (data.ok === true) return { ok: true };
      return {
        ok: false,
        reason: typeof data.reason === "string" ? data.reason : "store_failed",
      };
    },

    async recordFailureWithLease(input) {
      const { data: raw, error } = await supabase.rpc(
        "record_youtube_refresh_failure_with_lease",
        {
          p_account_id: input.accountId,
          p_lease_token: input.leaseToken,
          p_error_message: input.errorMessage,
          p_is_invalid_grant: input.isInvalidGrant,
          p_max_failures: input.maxFailures ?? 3,
          p_last_alert_sent_at: input.lastAlertSentAt ?? null,
        },
      );
      const data = asRecord(raw);
      if (error || !data) {
        return { ok: false, reason: "failure_record_failed" };
      }
      if (data.ok === true) {
        return {
          ok: true,
          needs_reauth: data.needs_reauth === true,
          failure_count: typeof data.failure_count === "number"
            ? data.failure_count
            : 1,
          transitioned: data.transitioned === true,
          enqueued: typeof data.enqueued === "number" ? data.enqueued : 0,
        };
      }
      return {
        ok: false,
        reason: typeof data.reason === "string"
          ? data.reason
          : "failure_record_failed",
      };
    },
  };
}

async function resolveFromFreshRead(
  store: YouTubeRefreshStore,
  accountId: string,
  nowMs: () => number,
  windowMs: number,
  force: boolean,
  priorAccessToken: string | null | undefined,
  fallbackReason: string,
): Promise<YouTubeRefreshOutcome> {
  let fresh: YouTubeStoredAccount | null;
  try {
    fresh = await store.readAccount(accountId);
  } catch {
    return {
      ok: false,
      status: "retryable_refusal",
      retryable: true,
      reason: "account_read_failed",
      accessToken: null,
      expiresAt: null,
      needsReauth: false,
    };
  }
  if (!fresh) {
    return {
      ok: false,
      status: "failed",
      retryable: false,
      reason: "account_not_found",
      accessToken: null,
      expiresAt: null,
      needsReauth: false,
    };
  }
  if (fresh.needs_reauth === true) {
    return {
      ok: false,
      status: "needs_reauth",
      retryable: false,
      reason: "needs_reauth",
      accessToken: null,
      expiresAt: fresh.token_expires_at,
      needsReauth: true,
    };
  }
  if (isReusableFreshToken(fresh, nowMs(), windowMs, force, priorAccessToken)) {
    return {
      ok: true,
      status: "reused",
      accessToken: fresh.access_token,
      expiresAt: fresh.token_expires_at,
      grantedScopes: null,
    };
  }
  return {
    ok: false,
    status: "retryable_refusal",
    retryable: true,
    reason: fallbackReason,
    accessToken: null,
    expiresAt: fresh.token_expires_at,
    needsReauth: false,
  };
}

/**
 * Serialises a YouTube OAuth token refresh for one account through the DB lease.
 */
export async function refreshYouTubeAccountToken(
  options: RefreshYouTubeAccountOptions,
): Promise<YouTubeRefreshOutcome> {
  const {
    accountId,
    snapshot,
    force = false,
    adminRecovery = false,
    healthNeutral = false,
    recordTransientFailure = false,
    maxFailures = 3,
    lastAlertSentAt = null,
    refreshWindowMs = YOUTUBE_TOKEN_REFRESH_WINDOW_MS,
    leaseTtlSeconds = DEFAULT_YOUTUBE_REFRESH_LEASE_TTL_SECONDS,
    store,
    fetchImpl,
  } = options;
  const nowMs = options.nowMs ?? (() => Date.now());
  const log = options.log ?? defaultLog;

  // Fast-path checks on caller-provided snapshot. A flagged snapshot never
  // takes the fresh shortcut: under adminRecovery the caller asked for the
  // exchange, and the shortcut would otherwise silently leave the flag set.
  // Admin recovery skips the refusal: its whole purpose is to re-test a
  // flagged account at Google.
  if (!adminRecovery && snapshot?.needs_reauth === true) {
    return {
      ok: false,
      status: "needs_reauth",
      retryable: false,
      reason: "needs_reauth",
      accessToken: null,
      expiresAt: snapshot.token_expires_at ?? null,
      needsReauth: true,
    };
  }
  if (
    !force &&
    snapshot?.access_token &&
    snapshot.needs_reauth !== true &&
    !youtubeTokenNeedsRefresh(snapshot.token_expires_at, nowMs(), refreshWindowMs)
  ) {
    return {
      ok: true,
      status: "fresh",
      accessToken: snapshot.access_token,
      expiresAt: snapshot.token_expires_at ?? null,
      grantedScopes: null,
    };
  }
  if (snapshot && "refresh_token" in snapshot && !snapshot.refresh_token) {
    return {
      ok: false,
      status: "failed",
      retryable: false,
      reason: "no_refresh_token",
      accessToken: null,
      expiresAt: snapshot.token_expires_at ?? null,
      needsReauth: false,
    };
  }

  let lease: AcquireLeaseResult;
  try {
    lease = await store.acquireLease(accountId, leaseTtlSeconds);
  } catch (error) {
    log(
      "warn",
      `[youtube-refresh] lease acquire error account=${accountId} error=${sanitizeErrorName(error)}`,
    );
    return {
      ok: false,
      status: "retryable_refusal",
      retryable: true,
      reason: "lease_acquire_failed",
      accessToken: null,
      expiresAt: snapshot?.token_expires_at ?? null,
      needsReauth: false,
    };
  }

  if (!lease.ok) {
    if (lease.reason === "lease_held") {
      return await resolveFromFreshRead(
        store,
        accountId,
        nowMs,
        refreshWindowMs,
        force,
        snapshot?.access_token,
        "refresh_in_progress",
      );
    }
    const permanent = lease.reason === "account_not_found" ||
      lease.reason === "invalid_account";
    return {
      ok: false,
      status: permanent ? "failed" : "retryable_refusal",
      retryable: !permanent,
      reason: lease.reason,
      accessToken: null,
      expiresAt: snapshot?.token_expires_at ?? null,
      needsReauth: false,
    };
  }

  let leaseConsumed = false;
  try {
    // Double-checked read under the lease: another worker may have finished
    // refreshing or recorded invalid_grant immediately before we acquired it.
    let current: YouTubeStoredAccount | null;
    try {
      current = await store.readAccount(accountId);
    } catch (error) {
      log(
        "warn",
        `[youtube-refresh] account read failed under lease account=${accountId} error=${sanitizeErrorName(error)}`,
      );
      return {
        ok: false,
        status: "retryable_refusal",
        retryable: true,
        reason: "account_read_failed",
        accessToken: null,
        expiresAt: null,
        needsReauth: false,
      };
    }

    if (!current) {
      return {
        ok: false,
        status: "failed",
        retryable: false,
        reason: "account_not_found",
        accessToken: null,
        expiresAt: null,
        needsReauth: false,
      };
    }

    if (current.needs_reauth === true && !adminRecovery) {
      return {
        ok: false,
        status: "needs_reauth",
        retryable: false,
        reason: "needs_reauth",
        accessToken: null,
        expiresAt: current.token_expires_at,
        needsReauth: true,
      };
    }

    if (
      isReusableFreshToken(
        current,
        nowMs(),
        refreshWindowMs,
        force,
        snapshot?.access_token,
      )
    ) {
      return {
        ok: true,
        status: "reused",
        accessToken: current.access_token,
        expiresAt: current.token_expires_at,
        grantedScopes: null,
      };
    }

    if (!current.refresh_token) {
      return {
        ok: false,
        status: "failed",
        retryable: false,
        reason: "no_refresh_token",
        accessToken: null,
        expiresAt: current.token_expires_at,
        needsReauth: false,
      };
    }

    const exchangeResult = options.exchange
      ? await options.exchange(current.refresh_token)
      : await exchangeGoogleRefreshToken(current.refresh_token, {
        accountId,
        fetchImpl,
        log,
      });

    if (!exchangeResult.ok) {
      if (exchangeResult.invalidGrant && healthNeutral) {
        // Stage 4 reads and writes must not change stored health. The lease
        // is released by the finally block; nothing is recorded.
        return {
          ok: false,
          status: "needs_reauth",
          retryable: false,
          reason: "invalid_grant",
          accessToken: null,
          expiresAt: current.token_expires_at,
          needsReauth: true,
        };
      }
      if (exchangeResult.invalidGrant) {
        const recorded = await store.recordFailureWithLease({
          accountId,
          leaseToken: lease.lease_token,
          errorMessage: "YouTube refresh failed: invalid_grant",
          isInvalidGrant: true,
          maxFailures,
          lastAlertSentAt,
        });
        if (recorded.ok) {
          leaseConsumed = true;
          return {
            ok: false,
            status: "needs_reauth",
            retryable: false,
            reason: "invalid_grant",
            accessToken: null,
            expiresAt: current.token_expires_at,
            needsReauth: true,
            transitioned: recorded.transitioned,
          };
        }
        // Stale holder wrote nothing: check whether the live winner refreshed
        // or marked needs_reauth.
        return await resolveFromFreshRead(
          store,
          accountId,
          nowMs,
          refreshWindowMs,
          force,
          snapshot?.access_token,
          recorded.reason,
        );
      }

      if (recordTransientFailure && !healthNeutral) {
        const recorded = await store.recordFailureWithLease({
          accountId,
          leaseToken: lease.lease_token,
          errorMessage: `YouTube refresh failed: ${exchangeResult.reason}`,
          isInvalidGrant: false,
          maxFailures,
          lastAlertSentAt,
        });
        if (recorded.ok) {
          leaseConsumed = true;
          return {
            ok: false,
            status: recorded.needs_reauth ? "needs_reauth" : "failed",
            retryable: !recorded.needs_reauth && exchangeResult.retryable,
            reason: exchangeResult.reason,
            accessToken: null,
            expiresAt: current.token_expires_at,
            needsReauth: recorded.needs_reauth,
            transitioned: recorded.transitioned,
          };
        }
        return await resolveFromFreshRead(
          store,
          accountId,
          nowMs,
          refreshWindowMs,
          force,
          snapshot?.access_token,
          recorded.reason,
        );
      }

      return {
        ok: false,
        status: exchangeResult.retryable ? "retryable_refusal" : "failed",
        retryable: exchangeResult.retryable,
        reason: exchangeResult.reason,
        accessToken: null,
        expiresAt: current.token_expires_at,
        needsReauth: false,
      };
    }

    const now = nowMs();
    const expiry = new Date(now + exchangeResult.expiresIn * 1000);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now) {
      return {
        ok: false,
        status: "retryable_refusal",
        retryable: true,
        reason: "refresh_answer_incomplete",
        accessToken: null,
        expiresAt: current.token_expires_at,
        needsReauth: false,
      };
    }

    const expiresAt = expiry.toISOString();
    const parsedScopes = exchangeResult.scope
      ? splitScopeString(exchangeResult.scope)
      : [];
    // Health-neutral callers never rewrite the stored scope grants.
    const grantedScopes = !healthNeutral && parsedScopes.length > 0 ? parsedScopes : null;

    const stored = await store.storeTokenWithLease({
      accountId,
      leaseToken: lease.lease_token,
      accessToken: exchangeResult.accessToken,
      tokenExpiresAt: expiresAt,
      refreshToken: exchangeResult.refreshToken,
      grantedScopes,
    });

    if (stored.ok) {
      leaseConsumed = true;
      return {
        ok: true,
        status: "refreshed",
        accessToken: exchangeResult.accessToken,
        expiresAt,
        grantedScopes,
      };
    }

    // Stale holder wrote nothing. Re-read so we can reuse the winner's token
    // if one was committed; otherwise return a retryable refusal.
    return await resolveFromFreshRead(
      store,
      accountId,
      nowMs,
      refreshWindowMs,
      force,
      snapshot?.access_token,
      stored.reason,
    );
  } finally {
    if (!leaseConsumed) {
      try {
        await store.releaseLease(accountId, lease.lease_token);
      } catch (error) {
        log(
          "warn",
          `[youtube-refresh] lease release failed account=${accountId} error=${sanitizeErrorName(error)}`,
        );
      }
    }
  }
}
