// The provider health runner: plan the targets, take the chunk's slice, test each
// one, sync the ones that passed, record the outcome.
//
// WHY a runner and not a script
// The admin button and the daily cron job must do exactly the same thing, so the work
// lives here and both callers reach it through the edge function's single door.

import {
  HEALTH_ALERT_BUDGET_MS,
  HEALTH_READ_FAILED_REASON,
  HEALTH_RUN_CONCURRENCY,
  HEALTH_RUN_DEADLINE_MS,
  HEALTH_SKIPPED_REASON,
  HEALTH_TARGET_BUDGET_MS,
  MAX_ALERT_SEND_TIMEOUT_MS,
  classifyApiKeyFailure,
  classifyOAuthFailure,
  planHealthTargets,
  sliceHealthChunk,
  summarizeHealthResults,
  withSignal,
  type DegradedProvider,
  type HealthResult,
  type HealthStatus,
  type HealthTarget,
} from "../_shared/aiProviderHealth.ts";
import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";
import { OAuthProbeError, ProviderTestError } from "../_shared/providerErrors.ts";
import { ProviderReadError } from "../_shared/aiProviderTest.ts";
import { CatalogStorageError } from "../_shared/modelCatalogSyncRun.ts";

export interface HealthRunPorts {
  listApiKeyProviders(signal: AbortSignal): Promise<Array<{ provider_code: string; name: string }>>;
  listOAuthConnections(signal: AbortSignal): Promise<
    Array<{ oauth_provider: string; provider_code: string; name: string; status: string }>
  >;
  resolveApiKey(providerCode: string, signal: AbortSignal): Promise<string | null>;
  /**
   * The targets this run has already recorded.
   *
   * A target in that list is not probed and not synced again: a chunk that is
   * retried must not test the same provider twice. The read throws when it
   * fails, because a failed read must never look like "nothing was recorded".
   */
  listRecordedTargets(
    runId: string,
    signal: AbortSignal,
  ): Promise<Array<{ provider_code: string; auth_method: string }>>;
  /** The probe, the token refresh and the sync of one target share ONE signal. */
  probeApiKey(target: HealthTarget, key: string, signal: AbortSignal): Promise<void>;
  probeOAuth(target: HealthTarget, signal: AbortSignal): Promise<void>;
  syncApiKeyCatalogue(
    providerCode: string,
    signal: AbortSignal,
  ): Promise<{ added: number | null; updated: number | null; deactivated: number | null }>;
  syncOAuthCatalogue(
    target: HealthTarget,
    signal: AbortSignal,
  ): Promise<{ added: number; updated: number; deactivated: number }>;
  recordResult(result: HealthResult, runId: string, signal: AbortSignal): Promise<void>;
  /** Claims the providers whose alert is still pending; the token is the claim's identity. */
  claimAlerts(claimToken: string, signal: AbortSignal): Promise<DegradedProvider[]>;
  /** Sends one admin alert. A failure here must not fail the run. */
  sendAlert(provider: DegradedProvider, signal?: AbortSignal): Promise<void>;
  /** Closes the claim of ONE row, so a failed send leaves only that row open. */
  markAlertNotified(claimToken: string, provider: DegradedProvider, signal: AbortSignal): Promise<void>;
  now(): Date;
}

export interface HealthRunOptions {
  runId: string;
  chunk: number;
  deadlineMs?: number;
  concurrency?: number;
  alertBudgetMs?: number;
  targetBudgetMs?: number;
}

/** A target the time budget never reached. It was not tested, so it has no result. */
export interface HealthSkippedTarget {
  provider_code: string;
  auth_method: "api_key" | "oauth";
  reason: string;
}

export interface HealthChunkResponse {
  run_id: string;
  chunk: number;
  done: boolean;
  next_chunk: number | null;
  results: HealthResult[];
  skipped: HealthSkippedTarget[];
  summary: { total: number; connected: number; failed: number; needs_relogin: number };
}

/** Routes the two failure families to a status and a sanitized sentence. */
function classifyTargetFailure(
  error: unknown,
  apiKey: string | null,
): { status: HealthStatus; reason: string } {
  if (error instanceof AiOAuthError) return classifyOAuthFailure(error.code);
  if (error instanceof OAuthProbeError) return { status: "failed", reason: error.message };
  if (error instanceof ProviderTestError) return classifyApiKeyFailure(error.status, error.body, apiKey);
  return { status: "failed", reason: "The provider could not be checked." };
}

/** What one target's test found. */
interface TargetProbe {
  status: HealthStatus;
  reason: string | null;
  /** Kept so a later failure can be redacted against it. It is never stored or logged. */
  apiKey: string | null;
}

/** What one target's test and catalogue sync found. */
interface TargetOutcome {
  status: HealthStatus;
  reason: string | null;
  models_added: number | null;
  models_updated: number | null;
  models_deactivated: number | null;
}

/**
 * Tests one target. A failure never leaves this function: the failure becomes the
 * status. The signal is the target's whole budget: the probe, the token refresh
 * and the catalogue sync share it, so a target that runs out of time stops
 * working instead of only being abandoned.
 *
 * A read failure is the one exception: the provider's own row could not be read,
 * so nothing is known about the provider. That is a run error, not a degradation,
 * and it is re-thrown so the caller leaves the row alone.
 */
async function probeTarget(
  ports: HealthRunPorts,
  target: HealthTarget,
  signal: AbortSignal,
): Promise<TargetProbe> {
  let apiKey: string | null = null;
  try {
    if (target.needs_relogin) {
      // The stored sign-in is already revoked: report it without a probe, so no
      // network call is made and its models are never touched.
      return { status: "needs_relogin", reason: classifyOAuthFailure("reauth_required").reason, apiKey: null };
    }
    if (target.auth_method === "oauth") {
      await withSignal(ports.probeOAuth(target, signal), signal);
      return { status: "connected", reason: null, apiKey: null };
    }
    apiKey = await withSignal(ports.resolveApiKey(target.provider_code, signal), signal);
    if (!apiKey) {
      // The planner already dropped the providers without a key, so reaching here
      // means the key vanished between the plan and the probe.
      throw new Error("The API key is no longer configured");
    }
    await withSignal(ports.probeApiKey(target, apiKey, signal), signal);
    return { status: "connected", reason: null, apiKey };
  } catch (error) {
    // The provider's row could not be read. This is not a broken provider, so it
    // must not become a degradation and must not raise an alert.
    if (error instanceof ProviderReadError) throw error;
    const classified = classifyTargetFailure(error, apiKey);
    return { status: classified.status, reason: classified.reason, apiKey };
  }
}

/**
 * Syncs the catalogue of a target that answered. A provider whose test failed is
 * never synced, so its models are never deactivated and never deleted.
 */
async function syncTarget(
  ports: HealthRunPorts,
  target: HealthTarget,
  signal: AbortSignal,
  probe: TargetProbe,
): Promise<TargetOutcome> {
  const noCounts = { models_added: null, models_updated: null, models_deactivated: null };
  if (probe.status !== "connected") {
    return { status: probe.status, reason: probe.reason, ...noCounts };
  }
  try {
    const report = target.auth_method === "oauth"
      ? await withSignal(ports.syncOAuthCatalogue(target, signal), signal)
      : await withSignal(ports.syncApiKeyCatalogue(target.provider_code, signal), signal);
    return {
      status: "connected",
      reason: probe.reason,
      models_added: report.added,
      models_updated: report.updated,
      models_deactivated: report.deactivated,
    };
  } catch (error) {
    if (error instanceof ProviderReadError || error instanceof CatalogStorageError) throw error;
    return {
      status: "failed",
      reason: "The provider model catalogue could not be synchronized.",
      ...noCounts,
    };
  }
}

/** Writes the result. A write that fails must not take the whole chunk down. */
async function recordTargetResult(
  ports: HealthRunPorts,
  result: HealthResult,
  runId: string,
  signal: AbortSignal,
): Promise<HealthResult | null> {
  try {
    await withSignal(ports.recordResult(result, runId, signal), signal);
    return result;
  } catch (error) {
    console.error("event: 'ai_provider_health_write_failed'", error instanceof Error ? error.name : "error");
    return null;
  }
}

/**
 * Tests one target and, when it answered, syncs its catalogue. A failure never
 * leaves this function: the failure becomes the result.
 *
 * A target whose own row could not be read has no result at all: it is reported
 * as skipped, so no row is written, no provider is called broken and no alert is
 * raised.
 */
async function runOneTarget(
  ports: HealthRunPorts,
  target: HealthTarget,
  runId: string,
  signal: AbortSignal,
  writeSignal: AbortSignal,
): Promise<{ result?: HealthResult; skipReason?: string }> {
  const started = Date.now();
  const checkedAt = ports.now().toISOString();
  let probe: TargetProbe;
  let outcome: TargetOutcome;
  try {
    probe = await probeTarget(ports, target, signal);
    outcome = await syncTarget(ports, target, signal, probe);
  } catch (error) {
    if (error instanceof ProviderReadError || error instanceof CatalogStorageError) {
      // A run error, not a degradation. The reason is a fixed sentence: the
      // failure itself may name a table or a column, never a credential.
      console.error("event: 'ai_provider_health_infrastructure_failed'", error.name);
      return { skipReason: error instanceof ProviderReadError ? HEALTH_READ_FAILED_REASON : "The provider catalogue could not be stored." };
    }
    throw error;
  }
  const result: HealthResult = {
    provider_code: target.provider_code,
    auth_method: target.auth_method,
    display_name: target.display_name,
    status: outcome.status,
    reason: outcome.reason,
    models_added: outcome.models_added,
    models_updated: outcome.models_updated,
    models_deactivated: outcome.models_deactivated,
    latency_ms: Date.now() - started,
    checked_at: checkedAt,
  };
  const recorded = await recordTargetResult(ports, result, runId, writeSignal);
  return recorded ? { result: recorded } : { skipReason: "The result could not be recorded." };
}

/**
 * Sends one alert and closes that row's claim. The row stays open when the send
 * fails, so the next run re-claims it.
 */
async function sendOneAlert(
  ports: HealthRunPorts,
  claimToken: string,
  provider: DegradedProvider,
  signal: AbortSignal,
): Promise<void> {
  try {
    await withSignal(ports.sendAlert(provider, signal), signal);
  } catch (error) {
    // The claim stays open on purpose: the row is re-claimed after ten minutes.
    // A send that ran out of time lands here too, so a timeout never marks the
    // row as notified.
    console.error("event: 'ai_provider_alert_failed'", error instanceof Error ? error.name : "error");
    return;
  }
  try {
    // One row at a time: a send that failed for another provider must not close
    // this row's alert.
    await withSignal(ports.markAlertNotified(claimToken, provider, signal), signal);
  } catch (error) {
    console.error("event: 'ai_provider_alert_mark_failed'", error instanceof Error ? error.name : "error");
  }
}

/**
 * Claims the providers whose alert is still pending, sends one alert each and
 * closes each claim on its own. A send that fails leaves only that row open, so
 * the next run re-claims it instead of losing the alert -- and the rows that were
 * sent are not sent again.
 *
 * Every send is bounded: by what is left of the alert budget and by the send
 * ceiling. A mail provider that hangs must not eat the run.
 */
async function sendClaimedAlerts(
  ports: HealthRunPorts,
  claimToken: string,
  budgetMs: number,
): Promise<void> {
  if (budgetMs <= 0) return;
  const deadline = Date.now() + budgetMs;
  const phaseSignal = AbortSignal.timeout(Math.max(1, Math.floor(budgetMs)));
  let claimed: DegradedProvider[];
  try {
    claimed = await withSignal(ports.claimAlerts(claimToken, phaseSignal), phaseSignal);
  } catch (error) {
    console.error("event: 'ai_provider_alert_claim_failed'", error instanceof Error ? error.name : "error");
    return;
  }
  if (!claimed.length) return;

  for (const provider of claimed) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // The alert phase runs after the target phase, so it gets what is left of
      // the budget. The rows that were not reached stay claimed and are re-claimed
      // after ten minutes.
      console.error("event: 'ai_provider_alert_budget_exhausted'");
      return;
    }
    const timeoutMs = Math.min(remaining, MAX_ALERT_SEND_TIMEOUT_MS);
    await sendOneAlert(ports, claimToken, provider, AbortSignal.timeout(timeoutMs));
  }
}

/**
 * Runs one chunk of the health check. The chunk is a slice of the planned targets
 * that fits the edge function's time budget; the caller asks for the next chunk
 * until `done` is true.
 */
export async function runHealthChunk(
  ports: HealthRunPorts,
  options: HealthRunOptions,
): Promise<HealthChunkResponse> {
  const deadline = Date.now() + (options.deadlineMs ?? HEALTH_RUN_DEADLINE_MS);
  const runSignal = AbortSignal.timeout(Math.max(1, Math.floor(deadline - Date.now())));
  const apiKeyProviders = await withSignal(ports.listApiKeyProviders(runSignal), runSignal);
  const connections = await withSignal(ports.listOAuthConnections(runSignal), runSignal);
  const oauthConnections = connections.filter((c) => c.status !== "reauth_required");
  const reauthConnections = connections.filter((c) => c.status === "reauth_required");

  // Read completion before resolving credentials: a completed provider must not
  // abort a later chunk just because its configuration is temporarily unavailable.
  const recorded = await withSignal(ports.listRecordedTargets(options.runId, runSignal), runSignal);
  const alreadyDone = new Set(recorded.map((r) => `${r.provider_code}:${r.auth_method}`));
  const discoverySkipped: HealthSkippedTarget[] = [];

  // A provider with no configured credential is not a target: there is nothing to
  // test and nothing to sync. The key is resolved again before the probe, so a key
  // that vanishes mid-run fails that target instead of the whole run.
  const configured: Array<{ provider_code: string; name: string }> = [];
  for (const provider of apiKeyProviders) {
    if (alreadyDone.has(`${provider.provider_code}:api_key`)) continue;
    try {
      const key = await withSignal(ports.resolveApiKey(provider.provider_code, runSignal), runSignal);
      if (key) configured.push(provider);
    } catch (error) {
      if (!(error instanceof ProviderReadError)) throw error;
      console.error("event: 'ai_provider_health_discovery_read_failed'");
      discoverySkipped.push({ provider_code: provider.provider_code, auth_method: "api_key", reason: HEALTH_READ_FAILED_REASON });
    }
  }

  const targets = planHealthTargets(configured, oauthConnections);
  // A connection already in reauth_required is a target that must be reported as
  // "needs re-login" without any network call.
  for (const c of [...reauthConnections].sort((a, b) => a.oauth_provider.localeCompare(b.oauth_provider))) {
    targets.push({
      provider_code: c.provider_code,
      auth_method: "oauth",
      display_name: c.name,
      oauth_provider: c.oauth_provider,
      needs_relogin: true,
    });
  }

  // The targets this run already did. A chunk that is retried must not probe and
  // sync the same provider twice, so the ones that are already recorded are taken
  // out of the list BEFORE the chunk is cut.
  //
  // A failed read fails the chunk. A read that failed must never look like "no
  // target was recorded", because that would probe every provider a second time.
  const remaining = targets.filter((t) => !alreadyDone.has(`${t.provider_code}:${t.auth_method}`));

  const { slice, done: covered, nextChunk } = sliceHealthChunk(remaining, options.chunk);
  const concurrency = options.concurrency ?? HEALTH_RUN_CONCURRENCY;
  const collected: Array<{ position: number; result?: HealthResult; skipReason?: string }> = [];
  const pending = new Set(slice.map((_target, position) => position));
  const activeProviders = new Set<string>();

  async function worker() {
    while (Date.now() < deadline) {
      const position = [...pending].find((p) => !activeProviders.has(slice[p].provider_code));
      if (position === undefined) return;
      pending.delete(position);
      const target = slice[position];
      activeProviders.add(target.provider_code);
      const budget = Math.max(1, Math.min(HEALTH_TARGET_BUDGET_MS, options.targetBudgetMs ?? HEALTH_TARGET_BUDGET_MS, Math.floor(deadline - Date.now())));
      const writeSignal = AbortSignal.any([runSignal, AbortSignal.timeout(budget)]);
      // Reserve part of the SAME target/global budget for the result write. A
      // hanging provider must not leave yesterday's healthy row untouched.
      const signal = AbortSignal.any([writeSignal, AbortSignal.timeout(Math.max(1,
        Math.floor(budget - Math.min(2_000, budget / 4))))]);
      try {
        const outcome = await runOneTarget(ports, target, options.runId, signal, writeSignal);
        collected.push({ position, ...outcome });
      } finally {
        activeProviders.delete(target.provider_code);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()));

  // The results follow the target order, not the completion order, so two runs of
  // the same chunk always answer in the same order.
  const results = collected
    .filter((c): c is { position: number; result: HealthResult } => !!c.result)
    .sort((a, b) => a.position - b.position)
    .map((c) => c.result);

  // A target the deadline never reached was not tested. A target whose row could
  // not be read was not tested either. Both are reported as skipped, and the chunk
  // is not done: the caller knows the run is incomplete.
  const skipped: HealthSkippedTarget[] = [...discoverySkipped];
  for (let position = 0; position < slice.length; position++) {
    const outcome = collected.find((c) => c.position === position);
    if (outcome?.result) continue;
    const target = slice[position];
    skipped.push({
      provider_code: target.provider_code,
      auth_method: target.auth_method,
      reason: outcome?.skipReason ?? HEALTH_SKIPPED_REASON,
    });
  }

  // The alert phase runs after the results are written: the rows must already be
  // recorded before the claim can see the transition.
  await sendClaimedAlerts(ports, crypto.randomUUID(), Math.min(options.alertBudgetMs ?? HEALTH_ALERT_BUDGET_MS, Math.max(0, deadline - Date.now())));

  // A skipped target means the chunk did not cover everything it was asked to, so
  // the caller has to come back for it.
  const chunkDone = covered && skipped.length === 0;
  return {
    run_id: options.runId,
    chunk: options.chunk,
    done: chunkDone,
    // The chunk is not done, so there is always a next one to ask for.
    next_chunk: chunkDone ? null : (nextChunk ?? options.chunk + 1),
    results,
    skipped,
    summary: summarizeHealthResults(results),
  };
}
