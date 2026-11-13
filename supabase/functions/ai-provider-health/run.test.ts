// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runHealthChunk, type HealthRunPorts } from "./run.ts";
import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";
import { buildAlertTitle } from "../_shared/aiProviderAlert.ts";
import type { DegradedProvider, HealthResult } from "../_shared/aiProviderHealth.ts";

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

Deno.test("a chunk past the end is done and writes nothing", async () => {
  const { ports, recorded } = fakePorts();
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 9 });
  assertEquals(out.done, true);
  assertEquals(out.results.length, 0);
  assertEquals(recorded.length, 0);
});

Deno.test("the counts are empty for a provider that failed", async () => {
  const { ports } = fakePorts({ probeApiKey: async (t) => { if (t.provider_code === "openai") throw new Error("x"); } });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  const failed = out.results.find((r) => r.status === "failed");
  assertEquals(failed?.models_added, null);
  assertEquals(failed?.models_updated, null);
  assertEquals(failed?.models_deactivated, null);
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
  assertEquals(out.results.length, 2);
  assert(out.results.every((r) => r.status === "failed"));
  assert(out.results.every((r) => r.reason === "The result could not be recorded."));
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
      },
      {
        provider_code: "claude",
        display_name: "Claude",
        auth_method: "oauth",
        status: "failed",
        reason: "Invalid API key",
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
