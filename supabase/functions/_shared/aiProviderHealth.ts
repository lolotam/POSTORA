// Planning, classification and sanitisation for the AI provider health run.
//
// WHY a pure module
// The run has two callers (the admin button and the daily cron job) and they must agree
// on every rule: which providers are targets, what a failure is called, what a reason may
// contain, and how the targets are split into chunks that fit the edge function's 50
// second budget. Keeping those rules here, with no I/O, is what makes them testable and
// what stops the two callers from drifting apart.

import { describeProviderFailure } from "./providerErrors.ts";
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
/** Targets per HTTP call. 6 x 15s / 3 concurrent = 30s even when every target times out. */
export const HEALTH_CHUNK_SIZE = 6;

/** The reason a target the time budget never reached is reported with. */
export const HEALTH_SKIPPED_REASON = "The run ran out of time before this provider was tested.";

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
  if (signal.aborted) return Promise.reject(signal.reason);
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
  // Sorted so the chunk boundaries do not move when a provider is added or removed.
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

export function sliceHealthChunk(
  targets: HealthTarget[],
  chunk: number,
): { slice: HealthTarget[]; done: boolean; nextChunk: number | null } {
  const index = Math.max(1, Math.floor(chunk)) - 1;
  const slice = targets.slice(index * HEALTH_CHUNK_SIZE, (index + 1) * HEALTH_CHUNK_SIZE);
  const done = slice.length === 0 || (index + 1) * HEALTH_CHUNK_SIZE >= targets.length;
  return { slice, done, nextChunk: done ? null : index + 2 };
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
    reason: sanitizeReason(describeProviderFailure("Provider", status, bodyText), apiKey ?? null),
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

/** FNV-1a: a small, dependency-free hash so the run id is stable across processes. */
function fnv1a(seed: string): number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * A stable UUID-shaped run id. The daily id depends only on the UTC date, so the four
 * cron entries of one day share a run id; the manual id depends on the browser's token,
 * so two clicks never share one. The shape is a real UUID because the database column
 * it lands in is a uuid.
 */
export function deriveRunId(scope: "daily" | "manual", token: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const seed = scope === "daily" ? `daily:${day}` : `manual:${token}`;
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  const s = hex(fnv1a(seed)) + hex(fnv1a(`${seed}:2`)) + hex(fnv1a(`${seed}:3`)) + hex(fnv1a(`${seed}:4`));
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
