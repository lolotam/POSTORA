// Planning, classification and sanitisation for the AI provider health run.
//
// WHY a pure module
// The run has two callers (the admin button and the daily cron job) and they must agree
// on every rule: which providers are targets, what a failure is called, what a reason may
// contain, and how the targets are split into chunks that fit the edge function's 50
// second budget. Keeping those rules here, with no I/O, is what makes them testable and
// what stops the two callers from drifting apart.

import { redactProviderError } from "./ai-routing-errors.ts";

export type HealthAuthMethod = "api_key" | "oauth";
export type HealthStatus = "connected" | "failed" | "needs_relogin";

export interface HealthTarget {
  provider_code: string;
  auth_method: HealthAuthMethod;
  display_name: string;
  /** The pi-ai OAuth provider id; present only for auth_method 'oauth'. */
  oauth_provider?: string;
  /**
   * The stored credential is already revoked. The target is reported as "needs
   * re-login" without a probe and without touching its models.
   */
  needs_relogin?: boolean;
}

export interface HealthResult {
  provider_code: string;
  auth_method: HealthAuthMethod;
  display_name: string;
  status: HealthStatus;
  reason: string | null;
  models_added: number | null;
  models_updated: number | null;
  models_deactivated: number | null;
  latency_ms: number | null;
  checked_at: string;
}

/** A provider that just degraded — the shape the admin alert is built from. */
export interface DegradedProvider {
  provider_code: string;
  /** The provider's display name: the alert names the provider, not its code. */
  display_name: string;
  auth_method: HealthAuthMethod;
  status: "failed" | "needs_relogin";
  reason: string | null;
  /**
   * The id of this break. It changes only when the provider ENTERS a broken state
   * and stays the same while the provider is still broken, so a re-claimed alert
   * carries the same id and the mail provider can refuse the second send.
   */
  alert_id: string | null;
}

/** Probes in flight at once. Three keeps 16 targets inside the 40 second budget. */
export const HEALTH_RUN_CONCURRENCY = 3;
/** One probe. The probes in ai-config have no timeout today; this bounds them. */
export const HEALTH_TARGET_TIMEOUT_MS = 12_000;
/**
 * One target's whole budget: the probe, the token refresh and the catalogue sync
 * share ONE signal. The probe alone may take 12 seconds, so the budget leaves the
 * sync a few seconds of its own. Six targets at 15 seconds over three workers is
 * 30 seconds, and the platform kills the function at 50.
 */
export const HEALTH_TARGET_BUDGET_MS = 15_000;
/** Server-side hard stop, 10 seconds of headroom under the 50 second platform limit. */
export const HEALTH_RUN_DEADLINE_MS = 40_000;
/**
 * The alert phase runs after the target phase, so it gets what is left. A row that
 * is not alerted inside this budget stays claimed and is re-claimed ten minutes later.
 */
export const HEALTH_ALERT_BUDGET_MS = 8_000;
/**
 * The ceiling for one alert send. A mail provider that hangs must not eat the whole
 * time budget, so every send is bounded by the smaller of this ceiling and what is
 * left of the alert budget.
 */
export const MAX_ALERT_SEND_TIMEOUT_MS = 5_000;
/** Targets per HTTP call. 6 x 15s / 3 concurrent = 30s even when every target times out. */
export const HEALTH_CHUNK_SIZE = 6;

/** The reason a target the time budget never reached is reported with. */
export const HEALTH_SKIPPED_REASON = "The run ran out of time before this provider was tested.";

/**
 * The reason a target whose own row could not be read is reported with. The target
 * was not tested, so it is not broken: the run could not find out.
 */
export const HEALTH_READ_FAILED_REASON = "The provider's configuration could not be read.";

/**
 * A fetch that cannot outlive the target's budget. The request's own signal and
 * the target's signal are both honoured: the tighter of the two wins.
 */
export function boundedFetch(signal: AbortSignal): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    })) as typeof fetch;
}

/**
 * Ends a phase that cannot be cancelled (a token refresh inside pi-ai) as soon as
 * the target's budget is over, instead of waiting for it.
 */
export function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller already started this operation; observe a later rejection too.
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const REASON_LIMIT = 500;

export function planHealthTargets(
  apiKeyProviders: Array<{ provider_code: string; name: string }>,
  oauthConnections: Array<{ oauth_provider: string; provider_code: string; name: string }>,
): HealthTarget[] {
  const targets: HealthTarget[] = [];
  // Stable ordering makes the results readable; completed targets are removed before slicing.
  for (const p of [...apiKeyProviders].sort((a, b) => a.provider_code.localeCompare(b.provider_code))) {
    targets.push({ provider_code: p.provider_code, auth_method: "api_key", display_name: p.name });
  }
  for (const c of [...oauthConnections].sort((a, b) => a.oauth_provider.localeCompare(b.oauth_provider))) {
    targets.push({
      provider_code: c.provider_code,
      auth_method: "oauth",
      display_name: c.name,
      oauth_provider: c.oauth_provider,
    });
  }
  return targets;
}

/**
 * The chunk is the FIRST N targets that are not recorded for this run yet.
 *
 * WHY a cursor and not an offset
 * The target list is re-planned on every call, so a provider that is added or
 * removed between two calls moves every boundary. An offset would then walk the
 * wrong targets and skip some of them. A cursor over what is left cannot walk past
 * a target: the ones that are already done are simply not in the list.
 *
 * `remaining` holds the targets of this run that have not been recorded yet.
 */
export function sliceHealthChunk(
  remaining: HealthTarget[],
  chunk: number,
): { slice: HealthTarget[]; done: boolean; nextChunk: number | null } {
  const slice = remaining.slice(0, HEALTH_CHUNK_SIZE);
  // Everything that is left fits in this one chunk, so this chunk covers the run.
  const done = remaining.length <= HEALTH_CHUNK_SIZE;
  return { slice, done, nextChunk: done ? null : chunk + 1 };
}

export function sanitizeReason(text: string, apiKey: string | null): string {
  // redactProviderError removes the exact key and any authorization / x-api-key header
  // value, then truncates. The key is used for the comparison and is never stored.
  const redacted = redactProviderError(text, apiKey ?? "");
  return redacted.slice(0, REASON_LIMIT);
}

export function classifyApiKeyFailure(
  status: number,
  bodyText: string,
  apiKey?: string | null,
): { status: HealthStatus; reason: string } {
  // A probe that timed out has no body to describe, and "API error: 504" would be a
  // worse sentence than saying what actually happened.
  if (status === 504) {
    return { status: "failed", reason: "The provider did not answer in time." };
  }
  return {
    status: "failed",
    reason: status === 401 ? "Invalid API key"
      : status === 403 ? "API key lacks required permissions"
      : status === 402 || /insufficient_balance|spending limit|used all available credits|customer_verification_required|1008/i.test(bodyText)
      ? "The provider account needs billing or additional credits."
      : status === 429 ? "Rate limit exceeded"
      : `The provider request failed (HTTP ${Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502}).`,
  };
}

/**
 * Maps the stable AiOAuthError code to a status and to one of a small set of fixed
 * sentences. A raw provider error never reaches this function.
 */
export function classifyOAuthFailure(code: string): { status: HealthStatus; reason: string } {
  if (code === "reauth_required" || code === "refresh_failed") {
    return { status: "needs_relogin", reason: "The subscription sign-in expired. Sign in again." };
  }
  if (code === "refresh_timeout") {
    return { status: "failed", reason: "The subscription sign-in could not be refreshed in time." };
  }
  if (code === "not_connected") {
    return { status: "needs_relogin", reason: "No subscription sign-in is connected." };
  }
  return { status: "failed", reason: "The subscription sign-in could not be checked." };
}

/**
 * A stable UUID-shaped run id. The daily id depends only on the UTC date, so the four
 * cron entries of one day share a run id; the manual id depends on the browser's token,
 * so two clicks never share one. The shape is a real UUID because the database column
 * it lands in is a uuid.
 */
export async function deriveRunId(scope: "daily" | "manual", token: string, now: Date): Promise<string> {
  // The browser creates this UUID with crypto.randomUUID() once per click and
  // reuses it for every chunk. Preserve all its entropy and retry identity.
  if (scope === "manual") return token;
  const day = now.toISOString().slice(0, 10);
  // Daily cron calls have no shared browser token: hash the UTC day so retries
  // and all four cron entries keep one identity, without a 32-bit bottleneck.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`daily:${day}`));
  const s = Array.from(new Uint8Array(digest).slice(0, 16), (n) => n.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

export function summarizeHealthResults(
  results: HealthResult[],
): { total: number; connected: number; failed: number; needs_relogin: number } {
  let connected = 0;
  let failed = 0;
  let needsRelogin = 0;
  for (const r of results) {
    if (r.status === "connected") connected++;
    else if (r.status === "failed") failed++;
    else needsRelogin++;
  }
  return { total: results.length, connected, failed, needs_relogin: needsRelogin };
}
