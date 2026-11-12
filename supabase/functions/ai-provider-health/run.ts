// The provider health runner: plan the targets, take the chunk's slice, test each
// one, sync the ones that passed, record the outcome.
//
// WHY a runner and not a script
// The admin button and the daily cron job must do exactly the same thing, so the work
// lives here and both callers reach it through the edge function's single door.

import {
  HEALTH_RUN_CONCURRENCY,
  HEALTH_RUN_DEADLINE_MS,
  classifyApiKeyFailure,
  classifyOAuthFailure,
  planHealthTargets,
  sanitizeReason,
  sliceHealthChunk,
  summarizeHealthResults,
  type DegradedProvider,
  type HealthResult,
  type HealthStatus,
  type HealthTarget,
} from "../_shared/aiProviderHealth.ts";
import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";
import { ProviderTestError } from "../_shared/providerErrors.ts";

export interface HealthRunPorts {
  listApiKeyProviders(): Promise<Array<{ provider_code: string; name: string }>>;
  listOAuthConnections(): Promise<
    Array<{ oauth_provider: string; provider_code: string; name: string; status: string }>
  >;
  resolveApiKey(providerCode: string): Promise<string | null>;
  probeApiKey(target: HealthTarget, key: string): Promise<void>;
  probeOAuth(target: HealthTarget): Promise<void>;
  syncApiKeyCatalogue(providerCode: string): Promise<{ added: number; updated: number; deactivated: number }>;
  syncOAuthCatalogue(target: HealthTarget): Promise<{ added: number; updated: number; deactivated: number }>;
  recordResult(result: HealthResult, runId: string): Promise<void>;
  /** Claims the providers that just degraded; the token is the claim's identity. */
  claimAlerts(claimToken: string): Promise<DegradedProvider[]>;
  /** Sends one admin alert. A failure here must not fail the run. */
  sendAlert(provider: DegradedProvider): Promise<void>;
  /** Closes the claim once every claimed alert was sent. */
  markAlertsNotified(claimToken: string): Promise<void>;
  now(): Date;
}

export interface HealthRunOptions {
  runId: string;
  chunk: number;
  deadlineMs?: number;
  concurrency?: number;
}

export interface HealthChunkResponse {
  run_id: string;
  chunk: number;
  done: boolean;
  next_chunk: number | null;
  results: HealthResult[];
  summary: { total: number; connected: number; failed: number; needs_relogin: number };
}

/** Routes the two failure families to a status and a sanitized sentence. */
function classifyTargetFailure(
  error: unknown,
  apiKey: string | null,
): { status: HealthStatus; reason: string } {
  if (error instanceof AiOAuthError) return classifyOAuthFailure(error.code);
  if (error instanceof ProviderTestError) return classifyApiKeyFailure(error.status, error.body, apiKey);
  const message = error instanceof Error ? error.message : String(error);
  return { status: "failed", reason: sanitizeReason(message, apiKey) };
}

/**
 * Tests one target and, when it answered, syncs its catalogue. A failure never
 * leaves this function: the failure becomes the result.
 */
async function runOneTarget(
  ports: HealthRunPorts,
  target: HealthTarget,
  runId: string,
): Promise<HealthResult> {
  const started = Date.now();
  const checkedAt = ports.now().toISOString();
  let status: HealthStatus = "connected";
  let reason: string | null = null;
  let added: number | null = null;
  let updated: number | null = null;
  let deactivated: number | null = null;
  // Kept in scope so a reason can be redacted against it. It is never stored or logged.
  let apiKey: string | null = null;

  try {
    if (target.needs_relogin) {
      // The stored sign-in is already revoked: report it without a probe, so no
      // network call is made and its models are never touched.
      status = "needs_relogin";
      reason = classifyOAuthFailure("reauth_required").reason;
    } else if (target.auth_method === "oauth") {
      await ports.probeOAuth(target);
    } else {
      apiKey = await ports.resolveApiKey(target.provider_code);
      if (!apiKey) {
        // The planner already dropped the providers without a key, so reaching here
        // means the key vanished between the plan and the probe.
        throw new Error("The API key is no longer configured");
      }
      await ports.probeApiKey(target, apiKey);
    }
  } catch (error) {
    const classified = classifyTargetFailure(error, apiKey);
    status = classified.status;
    reason = classified.reason;
  }

  // Only a provider whose test passed is synced. A failed OAuth target is never
  // synced, so its models are never deactivated and never deleted.
  if (status === "connected") {
    try {
      const report = target.auth_method === "oauth"
        ? await ports.syncOAuthCatalogue(target)
        : await ports.syncApiKeyCatalogue(target.provider_code);
      added = report.added;
      updated = report.updated;
      deactivated = report.deactivated;
    } catch (error) {
      status = "failed";
      reason = sanitizeReason(error instanceof Error ? error.message : String(error), apiKey);
      added = null;
      updated = null;
      deactivated = null;
    }
  }

  const result: HealthResult = {
    provider_code: target.provider_code,
    auth_method: target.auth_method,
    display_name: target.display_name,
    status,
    reason,
    models_added: added,
    models_updated: updated,
    models_deactivated: deactivated,
    latency_ms: Date.now() - started,
    checked_at: checkedAt,
  };
  await ports.recordResult(result, runId);
  return result;
}

/**
 * Claims the providers that just degraded, sends one alert each and closes the
 * claim. A send that fails leaves the claim open, so the next run re-claims the row
 * instead of losing the alert.
 */
async function sendClaimedAlerts(ports: HealthRunPorts, claimToken: string): Promise<void> {
  let claimed: DegradedProvider[];
  try {
    claimed = await ports.claimAlerts(claimToken);
  } catch (error) {
    console.error("event: 'ai_provider_alert_claim_failed'", error instanceof Error ? error.name : "error");
    return;
  }
  if (!claimed.length) return;

  let sent = 0;
  for (const provider of claimed) {
    try {
      await ports.sendAlert(provider);
      sent++;
    } catch (error) {
      // The claim stays open on purpose: the row is re-claimed after ten minutes.
      console.error("event: 'ai_provider_alert_failed'", error instanceof Error ? error.name : "error");
    }
  }
  if (sent !== claimed.length) return;
  try {
    await ports.markAlertsNotified(claimToken);
  } catch (error) {
    console.error("event: 'ai_provider_alert_mark_failed'", error instanceof Error ? error.name : "error");
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
  const apiKeyProviders = await ports.listApiKeyProviders();
  const connections = await ports.listOAuthConnections();
  const oauthConnections = connections.filter((c) => c.status !== "reauth_required");
  const reauthConnections = connections.filter((c) => c.status === "reauth_required");

  // A provider with no configured credential is not a target: there is nothing to
  // test and nothing to sync. The key is resolved again before the probe, so a key
  // that vanishes mid-run fails that target instead of the whole run.
  const configured: Array<{ provider_code: string; name: string }> = [];
  for (const provider of apiKeyProviders) {
    const key = await ports.resolveApiKey(provider.provider_code);
    if (key) configured.push(provider);
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

  const { slice, done, nextChunk } = sliceHealthChunk(targets, options.chunk);
  const deadline = Date.now() + (options.deadlineMs ?? HEALTH_RUN_DEADLINE_MS);
  const concurrency = options.concurrency ?? HEALTH_RUN_CONCURRENCY;
  const collected: Array<{ position: number; result: HealthResult }> = [];
  let index = 0;

  async function worker() {
    while (index < slice.length && Date.now() < deadline) {
      const position = index++;
      const target = slice[position];
      collected.push({ position, result: await runOneTarget(ports, target, options.runId) });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()));

  // The results follow the target order, not the completion order, so two runs of
  // the same chunk always answer in the same order.
  const results = collected.sort((a, b) => a.position - b.position).map((c) => c.result);

  // The alert phase runs after the results are written: the claim compares the new
  // status with the previous one, so the rows must already be recorded.
  await sendClaimedAlerts(ports, crypto.randomUUID());

  return {
    run_id: options.runId,
    chunk: options.chunk,
    done,
    next_chunk: nextChunk,
    results,
    summary: summarizeHealthResults(results),
  };
}
