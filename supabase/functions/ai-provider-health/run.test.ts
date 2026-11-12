// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runHealthChunk, type HealthRunPorts } from "./run.ts";
import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";
import { buildAlertTitle } from "../_shared/aiProviderAlert.ts";

function fakePorts(overrides: Partial<HealthRunPorts> = {}) {
  const recorded: Array<{ provider_code: string; auth_method: string; status: string }> = [];
  const synced: string[] = [];
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
      recorded.push(result);
    },
    claimAlerts: async () => [],
    sendAlert: async () => {},
    markAlertsNotified: async () => {},
    now: () => new Date("2026-11-13T03:05:00Z"),
    ...overrides,
  };
  return { ports, recorded, synced };
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

// --- the admin alert ---

Deno.test("a provider that just degraded produces one admin alert", async () => {
  const alerts: string[] = [];
  const { ports } = fakePorts({
    probeApiKey: async (t) => { if (t.provider_code === "openai") throw new Error("boom"); },
    claimAlerts: async () => ([
      { provider_code: "openai", auth_method: "api_key", status: "failed", reason: "Invalid API key" },
    ]),
    sendAlert: async (row) => { alerts.push(buildAlertTitle(row)); },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(alerts.length, 1);
  assert(alerts[0].includes("openai"));
});

Deno.test("the claim is closed only after every alert was sent", async () => {
  const closed: string[] = [];
  const { ports } = fakePorts({
    claimAlerts: async () => ([
      { provider_code: "openai", auth_method: "api_key", status: "failed", reason: "Invalid API key" },
    ]),
    sendAlert: async () => {},
    markAlertsNotified: async (token) => { closed.push(token); },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(closed.length, 1);
});

Deno.test("a failed alert leaves the claim open so the next run re-claims the row", async () => {
  const closed: string[] = [];
  const { ports } = fakePorts({
    claimAlerts: async () => ([
      { provider_code: "openai", auth_method: "api_key", status: "failed", reason: "Invalid API key" },
    ]),
    sendAlert: async () => { throw new Error("the mail provider refused it"); },
    markAlertsNotified: async (token) => { closed.push(token); },
  });
  const out = await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(closed.length, 0);
  // The run itself still succeeded: the health check is not the alert's hostage.
  assertEquals(out.summary.total, 2);
});

Deno.test("nothing is claimed when no provider degraded", async () => {
  let claimed = 0;
  const { ports } = fakePorts({
    claimAlerts: async () => { claimed++; return []; },
  });
  await runHealthChunk(ports, { runId: "run-1", chunk: 1 });
  assertEquals(claimed, 1);
});
