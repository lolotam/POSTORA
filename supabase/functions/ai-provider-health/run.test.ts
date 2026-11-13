// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runHealthChunk, type HealthRunPorts } from "./run.ts";
import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";
import { buildAlertTitle } from "../_shared/aiProviderAlert.ts";
import { ProviderReadError } from "../_shared/aiProviderTest.ts";
import type { DegradedProvider, HealthResult } from "../_shared/aiProviderHealth.ts";

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

Deno.test("a hung target receives only the remaining global budget", async () => {
  let claimed = false;
  const { ports } = fakePorts({
    probeApiKey: (_target, _key, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    claimAlerts: async () => { claimed = true; return []; },
  });
  const start = Date.now();
  const out = await runHealthChunk(ports, { runId: 'r', chunk: 1, deadlineMs: 20 });
  assertEquals(out.done, false);
  assert(out.skipped.length > 0);
  assert(Date.now() - start < 500);
  assertEquals(claimed, false);
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
    resolveApiKey: async (code) => (code === "xai" ? null : "sk-test"),
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
    resolveApiKey: async () => "sk-live-ABCDEF",
    probeApiKey: async () => { throw new Error("upstream rejected sk-live-ABCDEF"); },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  const failed = recorded.find((r) => r.status === "failed");
  assert(!String(failed?.reason).includes("sk-live-ABCDEF"));
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
    resolveApiKey: async () => "sk-test",
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

Deno.test("every phase of a target shares one signal", async () => {
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
