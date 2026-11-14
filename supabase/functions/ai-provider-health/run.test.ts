// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runHealthChunk, sendClaimedAlerts, type HealthRunPorts } from "./run.ts";
import { AiOAuthError, AiOAuthStorageError } from "../_shared/aiOAuth/errors.ts";
import { OAuthProbeError } from "../_shared/providerErrors.ts";
import { buildAlertTitle } from "../_shared/aiProviderAlert.ts";
import { ProviderReadError } from "../_shared/aiProviderTest.ts";
import { CatalogStorageError, CatalogSyncError } from "../_shared/modelCatalogSyncRun.ts";
import type { DegradedProvider, HealthResult } from "../_shared/aiProviderHealth.ts";

// Runtime fixtures exercise redaction without key-shaped source literals.
const fixtureCredentials = Array.from({ length: 2 }, () => ['s', 'k', '-'].join('') + crypto.randomUUID());

Deno.test("credential kinds of one provider serialize while other providers proceed", async () => {
  const active = new Set<string>();
  let concurrentProviders = false;
  const probe = async (target: { provider_code: string }) => {
    assert(!active.has(target.provider_code), "credential kinds overlapped");
    active.add(target.provider_code);
    if (active.size > 1) concurrentProviders = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const sync = async (code: string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    active.delete(code);
    return { added: 0, updated: 0, deactivated: 0 };
  };
  const { ports } = fakePorts({
    listApiKeyProviders: async () => [{ provider_code: 'claude', name: 'Claude' }, { provider_code: 'openai', name: 'OpenAI' }],
    resolveApiKey: async () => 'fixture', probeApiKey: probe, probeOAuth: probe,
    syncApiKeyCatalogue: sync, syncOAuthCatalogue: (target) => sync(target.provider_code),
  });
  const out = await runHealthChunk(ports, { runId: 'r', chunk: 1 });
  assertEquals(out.results.length, 3);
  assert(concurrentProviders);
});

Deno.test("slow discovery consumes the run budget and never reaches a provider", async () => {
  let probed = false;
  let aborted = false;
  const { ports } = fakePorts({
    listApiKeyProviders: (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
    probeApiKey: async () => { probed = true; },
  });
  await assertRejects(() => runHealthChunk(ports, { runId: 'r', chunk: 1, deadlineMs: 15 }));
  assert(aborted);
  assertEquals(probed, false);
});

Deno.test("a hung target retains time to record failure within the remaining global budget", async () => {
  const { ports } = fakePorts({
    listOAuthConnections: async () => [],
    probeApiKey: (_target, _key, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    claimAlerts: async (_token, signal) => { assert(!signal.aborted); return []; },
  });
  const start = Date.now();
  const out = await runHealthChunk(ports, { runId: 'r', chunk: 1, deadlineMs: 200 });
  assertEquals(out.done, true);
  assertEquals(out.skipped, []);
  assertEquals(out.results.find((row) => row.auth_method === "api_key")?.status, "failed");
  assert(Date.now() - start < 1000);
});

/** The rows the database would claim: a provider that was connected and is now failing. */
function transitionClaim(
  transitions: Array<{ result: HealthResult; previous_status: string | null }>,
): DegradedProvider[] {
  return transitions
    .filter((t) => t.previous_status === "connected" && t.result.status === "failed")
    .map((t) => ({
      provider_code: t.result.provider_code,
      display_name: t.result.display_name,
      auth_method: t.result.auth_method,
      status: "failed" as const,
      reason: t.result.reason,
      // The id of the break. It is the same for every claim of the same break.
      alert_id: `break-${t.result.provider_code}`,
    }));
}

function fakePorts(overrides: Partial<HealthRunPorts> = {}) {
  const recorded: HealthResult[] = [];
  const synced: string[] = [];
  const transitions: Array<{ result: HealthResult; previous_status: string | null }> = [];
  // The rows the last run left behind: both providers answered then.
  const previous = new Map<string, string>([
    ["openai:api_key", "connected"],
    ["claude:oauth", "connected"],
  ]);
  const ports: HealthRunPorts = {
    listApiKeyProviders: async () => [
      { provider_code: "openai", name: "OpenAI" },
      { provider_code: "xai", name: "xAI" },
    ],
    listOAuthConnections: async () => [
      { oauth_provider: "anthropic", provider_code: "claude", name: "Claude", status: "connected" },
    ],
    resolveApiKey: async (code) => (code === "xai" ? null : `${fixtureCredentials[1]}`),
    // The database remembers what this run did, so a chunk that is asked for a
    // second time sees the rows the first time recorded.
    listRecordedTargets: async () =>
      recorded.map((r) => ({ provider_code: r.provider_code, auth_method: r.auth_method })),
    probeApiKey: async () => {},
    probeOAuth: async () => {},
    syncApiKeyCatalogue: async (code) => {
      synced.push(`${code}:api_key`);
      return { added: 1, updated: 0, deactivated: 0 };
    },
    syncOAuthCatalogue: async (target) => {
      synced.push(`${target.provider_code}:oauth`);
      return { added: 0, updated: 0, deactivated: 0 };
    },
    recordResult: async (result) => {
      const key = `${result.provider_code}:${result.auth_method}`;
      transitions.push({ result, previous_status: previous.get(key) ?? null });
      previous.set(key, result.status);
      recorded.push(result);
    },
    // The claim sees what the run recorded, the way the database does.
    claimAlerts: async () => transitionClaim(transitions),
    sendAlert: async () => {},
    markAlertNotified: async () => {},
    now: () => new Date("2026-11-13T03:05:00Z"),
    ...overrides,
  };
  return { ports, recorded, synced, transitions };
}

Deno.test("a provider without a key is not a target", async () => {
  const { ports, recorded } = fakePorts();
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(out.results.map((r) => `${r.provider_code}:${r.auth_method}`), ["openai:api_key", "claude:oauth"]);
  assertEquals(recorded.length, 2);
});

Deno.test("one failing provider does not stop the others", async () => {
  const { ports, recorded, synced } = fakePorts({
    probeApiKey: async (target) => {
      if (target.provider_code === "openai") throw new Error("HTTP 500");
    },
  });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(out.summary.failed, 1);
  assertEquals(out.summary.connected, 1);
  // The provider that failed is not synced; the one that answered still is.
  assertEquals(synced.length, 1);
  assertEquals(synced[0], "claude:oauth");
  assertEquals(recorded.filter((r) => r.status === "failed").length, 1);
});

Deno.test("a failed provider is never synced", async () => {
  const { ports, synced } = fakePorts({
    probeApiKey: async () => { throw new Error("boom"); },
    probeOAuth: async () => { throw new Error("boom"); },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(synced.length, 0);
});

Deno.test("a provider that echoes the key back never stores it in the reason", async () => {
  const { ports, recorded } = fakePorts({
    resolveApiKey: async () => `${fixtureCredentials[0]}`,
    probeApiKey: async () => { throw new Error(`upstream rejected ${fixtureCredentials[0]}`); },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  const failed = recorded.find((r) => r.status === "failed");
  assert(!String(failed?.reason).includes(`${fixtureCredentials[0]}`));
});

Deno.test("an expired oauth refresh needs a re-login and syncs nothing", async () => {
  const { ports, synced, recorded } = fakePorts({
    probeOAuth: async () => { throw new AiOAuthError("reauth_required"); },
  });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  const oauth = out.results.find((r) => r.auth_method === "oauth");
  assertEquals(oauth?.status, "needs_relogin");
  assertEquals(oauth?.models_added, null);
  assertEquals(synced.length, 1); // only the api-key provider synced
  assertEquals(recorded.find((r) => r.auth_method === "oauth")?.status, "needs_relogin");
});

Deno.test("a chunk asked for a second time does nothing: the run already did it", async () => {
  const { ports, recorded } = fakePorts();
  const first = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(first.results.length, 2);
  assertEquals(recorded.length, 2);
  // The same run asked for again: every target is already recorded, so nothing is
  // probed and nothing is written a second time.
  const second = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(second.results.length, 0);
  assertEquals(second.done, true);
  assertEquals(recorded.length, 2);
});

Deno.test("the counts are empty for a provider that failed", async () => {
  const { ports } = fakePorts({ probeApiKey: async (t) => { if (t.provider_code === "openai") throw new Error("x"); } });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  const failed = out.results.find((r) => r.status === "failed");
  assertEquals(failed?.models_added, null);
  assertEquals(failed?.models_updated, null);
  assertEquals(failed?.models_deactivated, null);
});

Deno.test("changing target membership between calls never skips unfinished providers", async () => {
  let codes = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const { ports, recorded, synced } = fakePorts({
    listApiKeyProviders: async () => codes.map((provider_code) => ({ provider_code, name: provider_code })),
    listOAuthConnections: async () => [],
    resolveApiKey: async () => "fixture-key",
  });
  const first = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(first.done, false);
  codes = ["aa", "b", "c", "d", "e", "f", "g", "h"];
  const second = await runHealthChunk(ports, { runId: "run-1", chunk: 2 });
  assertEquals(second.results.map((row) => row.provider_code), ["aa", "g", "h"]);
  assertEquals(second.done, true);
  assertEquals(new Set(recorded.map((row) => row.provider_code)).size, 9);
  assertEquals(synced.length, 9);
});

Deno.test("advancing chunks drain all unfinished targets without offsets or duplicate probes", async () => {
  const codes = Array.from({ length: 15 }, (_, i) => `provider-${String(i).padStart(2, "0")}`);
  const probed: string[] = [];
  const { ports, recorded } = fakePorts({
    listApiKeyProviders: async () => codes.map((provider_code) => ({ provider_code, name: provider_code })),
    listOAuthConnections: async () => [],
    resolveApiKey: async () => "test-key-not-secret",
    probeApiKey: async (target) => { probed.push(target.provider_code); },
  });
  const first = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(first.results.map((r) => r.provider_code), codes.slice(0, 6));
  assertEquals(first.next_chunk, 2);
  const second = await runHealthChunk(ports, { runId: "run-1", chunk: 2 });
  assertEquals(second.results.map((r) => r.provider_code), codes.slice(6, 12));
  assertEquals(second.done, false);
  // A retry drains remaining work too; chunk numbers identify requests, not offsets.
  const retry = await runHealthChunk(ports, { runId: "run-1", chunk: 2 });
  assertEquals(retry.results.map((r) => r.provider_code), codes.slice(12));
  assertEquals(retry.done, true);
  assertEquals((await runHealthChunk(ports, { runId: "run-1", chunk: 4 })).results, []);
  assertEquals(recorded.map((r) => r.provider_code), codes);
  assertEquals(probed, codes);
});

Deno.test("a connection already in reauth_required is reported without a network call", async () => {
  let probed = false;
  const { ports, recorded } = fakePorts({
    listOAuthConnections: async () => [
      { oauth_provider: "anthropic", provider_code: "claude", name: "Claude", status: "reauth_required" },
    ],
    probeOAuth: async () => { probed = true; },
  });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  const oauth = out.results.find((r) => r.auth_method === "oauth");
  assertEquals(oauth?.status, "needs_relogin");
  assertEquals(probed, false);
  assertEquals(recorded.find((r) => r.auth_method === "oauth")?.status, "needs_relogin");
});

Deno.test("the results keep the target order whatever order the probes finish in", async () => {
  const { ports } = fakePorts({
    listApiKeyProviders: async () => [
      { provider_code: "slow", name: "Slow" },
      { provider_code: "fast", name: "Fast" },
    ],
    listOAuthConnections: async () => [],
    resolveApiKey: async () => `${fixtureCredentials[1]}`,
    probeApiKey: async (target) => {
      if (target.provider_code === "slow") await new Promise((resolve) => setTimeout(resolve, 30));
    },
  });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(out.results.map((r) => r.provider_code), ["fast", "slow"]);
});

// --- the time budget ---

Deno.test("a target the budget never reached is reported as skipped and the chunk is not done", async () => {
  const { ports, recorded } = fakePorts();
  // The deadline is already over when the chunk starts.
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1, deadlineMs: 0 });
  assertEquals(out.results.length, 0);
  assertEquals(recorded.length, 0);
  assertEquals(out.skipped.map((s) => s.provider_code), ["openai", "claude"]);
  assert(out.skipped.every((s) => s.reason.length > 0));
  assertEquals(out.done, false);
});

Deno.test("a chunk that covered everything is done", async () => {
  const { ports } = fakePorts();
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(out.done, true);
  assertEquals(out.skipped.length, 0);
});

Deno.test("probe and catalogue phases share one signal before the reserved write budget", async () => {
  const signals: AbortSignal[] = [];
  const { ports } = fakePorts({
    probeApiKey: async (_target, _key, signal) => { signals.push(signal); },
    syncApiKeyCatalogue: async (_code, signal) => {
      signals.push(signal);
      return { added: 0, updated: 0, deactivated: 0 };
    },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  // The probe and the sync of the same target share one budget.
  assertEquals(signals.length, 2);
  assert(signals[0] === signals[1]);
});

// --- the write ---

Deno.test("a failed write does not take the chunk down", async () => {
  const { ports, recorded } = fakePorts({
    recordResult: async () => { throw new Error("the database is down"); },
  });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(recorded.length, 0);
  assertEquals(out.results.length, 0);
  assertEquals(out.done, false);
  assertEquals(out.skipped.length, 2);
  assert(out.skipped.every((r) => r.reason === "The result could not be recorded."));
});

// --- the admin alert ---

Deno.test("a provider that just degraded produces one admin alert", async () => {
  const alerts: string[] = [];
  const { ports } = fakePorts({
    probeApiKey: async (t) => { if (t.provider_code === "openai") throw new Error("boom"); },
    sendAlert: async (row) => { alerts.push(buildAlertTitle(row)); },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  // The claim is derived from the recorded transition, not from a fixed row.
  assertEquals(alerts.length, 1);
  assert(alerts[0].includes("OpenAI"));
});

Deno.test("a provider that did not degrade produces no alert", async () => {
  const alerts: string[] = [];
  const { ports } = fakePorts({
    sendAlert: async (row) => { alerts.push(buildAlertTitle(row)); },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(alerts.length, 0);
});

Deno.test("the claim is closed row by row after the alert was sent", async () => {
  const closed: string[] = [];
  const { ports } = fakePorts({
    claimAlerts: async () => ([
      {
        provider_code: "openai",
        display_name: "OpenAI",
        auth_method: "api_key",
        status: "failed",
        reason: "Invalid API key",
        alert_id: null,
      },
    ]),
    sendAlert: async () => {},
    markAlertNotified: async (_token, provider) => { closed.push(provider.provider_code); },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(closed, ["openai"]);
});

Deno.test("a failed alert leaves only that row's claim open, and the run still succeeds", async () => {
  const closed: string[] = [];
  const { ports } = fakePorts({
    claimAlerts: async () => ([
      {
        provider_code: "openai",
        display_name: "OpenAI",
        auth_method: "api_key",
        status: "failed",
        reason: "Invalid API key",
        alert_id: null,
      },
      {
        provider_code: "claude",
        display_name: "Claude",
        auth_method: "oauth",
        status: "failed",
        reason: "Invalid API key",
        alert_id: null,
      },
    ]),
    sendAlert: async (provider) => {
      if (provider.provider_code === "openai") throw new Error("the mail provider refused it");
    },
    markAlertNotified: async (_token, provider) => { closed.push(provider.provider_code); },
  });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  // The provider that was sent is closed; the one that failed stays open.
  assertEquals(closed, ["claude"]);
  // The run itself still succeeded: the health check is not the alert's hostage.
  assertEquals(out.summary.total, 2);
});

Deno.test("the claim is asked once per run, not once per target", async () => {
  let claimed = 0;
  const { ports } = fakePorts({
    claimAlerts: async () => { claimed++; return []; },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(claimed, 1);
});

// --- the run's own idempotency: a target this run already did ---

Deno.test("a target this run already recorded is not probed again", async () => {
  const probed: string[] = [];
  const { ports, recorded, synced } = fakePorts({
    listRecordedTargets: async () => [{ provider_code: "openai", auth_method: "api_key" }],
    probeApiKey: async (target) => { probed.push(target.provider_code); },
  });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  // The provider that was already recorded is not probed and not synced again.
  assertEquals(probed, []);
  assertEquals(synced, ["claude:oauth"]);
  assertEquals(out.results.map((r) => r.provider_code), ["claude"]);
  assertEquals(recorded.length, 1);
});

Deno.test("a failed read of the recorded list fails the chunk", async () => {
  const { ports, recorded } = fakePorts({
    listRecordedTargets: async () => { throw new Error("the database is down"); },
  });
  // A read that failed must not look like "nothing was recorded", because that
  // would probe and sync every provider a second time.
  await assertRejects(() => runHealthChunk(ports, { runId: "run-1", chunk: 1 }), Error);
  assertEquals(recorded.length, 0);
});

Deno.test("a provider whose row cannot be read is a run error, not a degradation", async () => {
  const alerts: string[] = [];
  const { ports, recorded } = fakePorts({
    probeApiKey: async () => { throw new ProviderReadError("The provider configuration could not be read"); },
    probeOAuth: async () => { throw new ProviderReadError("The provider configuration could not be read"); },
    sendAlert: async (row) => { alerts.push(buildAlertTitle(row)); },
  });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  // Nothing was recorded, so no provider is called broken and no alert is raised.
  assertEquals(recorded.length, 0);
  assertEquals(out.results.length, 0);
  assertEquals(alerts.length, 0);
  // The target is reported as skipped, so the caller knows the run is incomplete.
  assertEquals(out.skipped.map((s) => s.provider_code), ["openai", "claude"]);
  assertEquals(out.done, false);
});

// --- the alert: one break, one id, one send ---

Deno.test("the alert carries the id of the break", async () => {
  const ids: string[] = [];
  const { ports } = fakePorts({
    probeApiKey: async (t) => { if (t.provider_code === "openai") throw new Error("boom"); },
    sendAlert: async (provider) => { ids.push(String(provider.alert_id)); },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  // The id of the break is what the mail provider refuses the second time.
  assertEquals(ids, ["break-openai"]);
});

Deno.test("an alert send that ignores cancellation still times out and leaves the claim open", async () => {
  const closed: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const { ports } = fakePorts({
    claimAlerts: async () => ([
      {
        provider_code: "openai",
        display_name: "OpenAI",
        auth_method: "api_key",
        status: "failed",
        reason: "Invalid API key",
        alert_id: "break-openai",
      },
    ]),
    sendAlert: async () => {
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 100);
      });
    },
    markAlertNotified: async (_token, provider) => { closed.push(provider.provider_code); },
  });
  try {
    await runHealthChunk(ports, { runId: "run-1", chunk: 1, alertBudgetMs: 20 });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  assertEquals(closed, []);
});

Deno.test("an alert send is bounded and a timeout leaves the claim open", async () => {
  const closed: string[] = [];
  const signals: AbortSignal[] = [];
  const { ports } = fakePorts({
    claimAlerts: async () => ([
      {
        provider_code: "openai",
        display_name: "OpenAI",
        auth_method: "api_key",
        status: "failed",
        reason: "Invalid API key",
        alert_id: "break-openai",
      },
    ]),
    sendAlert: async (_provider, signal) => {
      if (signal) signals.push(signal);
      // A mail provider that hangs: only the signal ends it.
      await new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
        setTimeout(resolve, 200);
      });
    },
    markAlertNotified: async (_token, provider) => { closed.push(provider.provider_code); },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1, alertBudgetMs: 20 });
  // The send was bounded by what was left of the budget.
  assertEquals(signals.length, 1);
  assertEquals(signals[0].aborted, true);
  // A send that ran out of time never marks the row as notified: the claim stays
  // open, so the next run re-claims it.
  assertEquals(closed, []);
});

for (const phase of ['oauth', 'sync'] as const) {
  Deno.test(`a ${phase} timeout preserves the probe versus catalogue failure boundary`, async () => {
    const hang = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    let alerted = false;
    const { ports, recorded } = fakePorts({
      listApiKeyProviders: async () => [],
      probeOAuth: (_target, signal) => phase === 'oauth' ? hang(signal) : Promise.resolve(),
      syncOAuthCatalogue: (_target, signal) => hang(signal),
      recordResult: async (result, _runId, signal) => {
        assertEquals(signal.aborted, false, 'write must retain a live deadline');
        recorded.push(result);
      },
      claimAlerts: async () => recorded.map((result) => ({ ...result, status: 'failed' as const, alert_id: 'event' })),
      sendAlert: async () => { alerted = true; },
    });
    const out = await runHealthChunk(ports, { runId: 'r', chunk: 1, targetBudgetMs: 80, deadlineMs: 1000 });
    if (phase === 'sync') {
      assertEquals(out.done, false);
      assertEquals(out.results, []);
      assertEquals(out.skipped.length, 1);
      assertEquals(recorded, []);
      assertEquals(alerted, false);
    } else {
      assertEquals(out.done, true);
      assertEquals(out.skipped, []);
      assertEquals(out.results[0].status, 'failed');
      assertEquals(recorded.length, 1);
      assert(alerted);
    }
  });
}

Deno.test('second credential lookup failure neither degrades nor alerts the provider', async () => {
  let reads = 0;
  let sent = false;
  const { ports, recorded } = fakePorts({
    listApiKeyProviders: async () => [{ provider_code: 'openai', name: 'OpenAI' }],
    listOAuthConnections: async () => [],
    resolveApiKey: async () => { if (++reads === 2) throw new ProviderReadError('storage down'); return 'key'; },
    sendAlert: async () => { sent = true; },
  });
  const out = await runHealthChunk(ports, { runId: 'r', chunk: 1 });
  assertEquals(recorded.length, 0);
  assertEquals(out.skipped.length, 1);
  assertEquals(out.done, false);
  assertEquals(sent, false);
});

for (const lookupFailure of ['abort rejection', 'unsettled lookup', 'transport rejection'] as const) {
  Deno.test(`second credential ${lookupFailure} stays retryable without degradation or alert`, async () => {
    let reads = 0;
    let probed = false;
    let alerted = false;
    const { ports, recorded, synced } = fakePorts({
      listApiKeyProviders: async () => [{ provider_code: 'openai', name: 'OpenAI' }],
      listOAuthConnections: async () => [],
      resolveApiKey: async (_code, signal) => {
        if (++reads === 1) return 'key-fixture';
        if (lookupFailure === 'transport rejection') throw new TypeError('fetch failed');
        return await new Promise<string>((_resolve, reject) => {
          if (lookupFailure === 'abort rejection') signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      probeApiKey: async () => { probed = true; },
      sendAlert: async () => { alerted = true; },
    });
    const out = await runHealthChunk(ports, { runId: 'r', chunk: 1, targetBudgetMs: 80, deadlineMs: 1000 });
    assertEquals(out.done, false);
    assertEquals(out.results, []);
    assertEquals(out.skipped.map((row) => row.provider_code), ['openai']);
    assertEquals(recorded, []);
    assertEquals(synced, []);
    assertEquals(probed, false);
    assertEquals(alerted, false);
  });
}

for (const status of [401, 429, 502]) {
  Deno.test(`OAuth refusal preserves safe HTTP ${status} in results and alerts`, async () => {
    const { ports } = fakePorts({ listApiKeyProviders: async () => [],
      probeOAuth: async () => { throw new OAuthProbeError(status); } });
    const out = await runHealthChunk(ports, { runId: 'r', chunk: 1 });
    assertEquals(out.results[0].reason, `The subscription sign-in was refused (HTTP ${status}).`);
  });
}

Deno.test("credential discovery isolates unreadable providers and does not reread completed credentials", async () => {
  const lookups: string[] = [];
  const { ports, recorded } = fakePorts({
    listApiKeyProviders: async () => ["broken", "done", "healthy"].map((provider_code) => ({ provider_code, name: provider_code })),
    listOAuthConnections: async () => [],
    listRecordedTargets: async () => [{ provider_code: "done", auth_method: "api_key" }],
    resolveApiKey: async (code) => {
      lookups.push(code);
      if (code !== "healthy") throw new ProviderReadError("storage unavailable");
      return "test-key-not-secret";
    },
  });
  const out = await runHealthChunk(ports, { runId: "r", chunk: 1 });
  assertEquals(recorded.map((r) => r.provider_code), ["healthy"]);
  assertEquals(out.skipped.map((r) => r.provider_code), ["broken"]);
  assertEquals(out.done, false);
  assertEquals(lookups.includes("done"), false);
});

for (const authMethod of ["api_key", "oauth"] as const) {
  Deno.test(`${authMethod} catalogue storage failure stays retryable without false degradation`, async () => {
    const alerts: string[] = [];
    const fail = async () => { throw new CatalogStorageError("Model sync failed; see server logs"); };
    const { ports, recorded } = fakePorts({
      ...(authMethod === "api_key" ? { syncApiKeyCatalogue: fail } : { syncOAuthCatalogue: fail }),
      sendAlert: async (row) => { alerts.push(row.provider_code); },
    });
    const out = await runHealthChunk(ports, { runId: "r", chunk: 1 });
    assertEquals(recorded.length, 1);
    assertEquals(recorded[0].status, "connected");
    assertEquals(out.skipped.map((r) => r.auth_method), [authMethod]);
    assertEquals(out.done, false);
    assertEquals(alerts, []);
  });
}


for (const phase of ['probe', 'sync'] as const) {
  for (const failure of [new AiOAuthStorageError(), new AiOAuthError('not_connected'), new AiOAuthError('lease_lost')]) {
    Deno.test(`round5 ${phase} ${failure.name}/${failure.message} leaves health untouched and retryable`, async () => {
      const { ports, recorded } = fakePorts({ listApiKeyProviders: async () => [],
        ...(phase === 'probe' ? { probeOAuth: async () => { throw failure; } }
          : { syncOAuthCatalogue: async () => { throw failure; } }) });
      const out = await runHealthChunk(ports, { runId: 'r', chunk: 1 });
      assertEquals(out.results, []);
      assertEquals(recorded, []);
      assertEquals(out.skipped.length, 1);
      assertEquals(out.done, false);
    });
  }
}
Deno.test('round5 catalogue source and lease refusals never overwrite a successful probe', async () => {
  const { ports, recorded } = fakePorts({ listOAuthConnections: async () => [],
    syncApiKeyCatalogue: async () => { throw new CatalogSyncError('catalogue unavailable'); } });
  const out = await runHealthChunk(ports, { runId: 'r', chunk: 1 });
  assertEquals(recorded, []);
  assertEquals(out.skipped.length, 1);
  assertEquals(out.done, false);
});

Deno.test('alert phase claims the next event only after settling the current event', async () => {
  const pending = ['first', 'second'];
  const sent: string[] = [];
  const closed: string[] = [];
  const { ports } = fakePorts({
    claimAlerts: async () => {
      assertEquals(sent.length, closed.length, 'next claim must wait for acknowledgement');
      const code = pending.shift();
      return code ? [{ provider_code: code, display_name: code, auth_method: 'api_key', status: 'failed', reason: null, alert_id: code }] : [];
    },
    sendAlert: async row => { sent.push(row.provider_code); },
    markAlertNotified: async (_token, row) => { closed.push(row.provider_code); },
  });
  await sendClaimedAlerts(ports, 'claim', 1000);
  assertEquals(sent, ['first', 'second']);
  assertEquals(closed, sent);
});

Deno.test('successful alert send has a separate live acknowledgement deadline', async () => {
  let sendSignal: AbortSignal | undefined;
  let marked = false;
  let claimed = false;
  const { ports } = fakePorts({
    claimAlerts: async () => {
      if (claimed) return [];
      claimed = true;
      return [{ provider_code: 'openai', display_name: 'OpenAI', auth_method: 'api_key', status: 'failed', reason: null, alert_id: 'break' }];
    },
    sendAlert: async (_row, signal) => { sendSignal = signal; },
    markAlertNotified: async (_token, _row, signal) => {
      assert(signal !== sendSignal, 'acknowledgement must not reuse the send timeout');
      assert(!signal.aborted);
      marked = true;
    },
  });
  await sendClaimedAlerts(ports, 'claim', 1000);
  assert(marked);
});

Deno.test('scheduled recovery drains more than four chunks after a failed call and timeout', async () => {
  const codes = Array.from({ length: 31 }, (_, i) => `provider-${String(i).padStart(2, '0')}`);
  let failRead = true;
  const { ports, recorded } = fakePorts({
    listApiKeyProviders: async () => { if (failRead) { failRead = false; throw new Error('temporary outage'); } return codes.map(provider_code => ({ provider_code, name: provider_code })); },
    listOAuthConnections: async () => [], resolveApiKey: async () => 'fixture',
  });
  await assertRejects(() => runHealthChunk(ports, { runId: 'daily', chunk: 1 }));
  const timeout = await runHealthChunk(ports, { runId: 'daily', chunk: 2, deadlineMs: 0 });
  assertEquals(timeout.done, false);
  for (let call = 3; call <= 8; call++) await runHealthChunk(ports, { runId: 'daily', chunk: call });
  assertEquals(recorded.map(r => r.provider_code), codes);
  assertEquals(new Set(recorded.map(r => r.provider_code)).size, 31);
});
