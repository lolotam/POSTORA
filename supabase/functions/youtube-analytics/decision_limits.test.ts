import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { YOUTUBE_ANALYTICS_REQUIRED_SCOPES } from "./contracts.ts";
import {
  decideYouTubeAnalytics,
  type YouTubeAnalyticsBinding,
  type YouTubeAnalyticsRpcRunner,
} from "./decision.ts";
import { checkAdmissionLimit, checkDataLimit, debitSharedBudget } from "./limits.ts";

const OWNER_ID = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";

function decisionPayload(reason = "ok", withCredentials = false) {
  const hidden = reason === "invalid_request" || reason === "not_found";
  return {
    ok: reason === "ok",
    reason,
    channel_id: hidden ? null : "UCfixturechannel000000001",
    binding_generation: hidden ? null : 4,
    binding_incarnation: hidden ? null : "0ee40001-0000-4000-8000-000000000041",
    connection_revision: hidden ? null : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    provider: hidden ? null : "native",
    needs_reauth: hidden ? null : false,
    granted_scopes: hidden ? null : [...YOUTUBE_ANALYTICS_REQUIRED_SCOPES],
    consent: { state: hidden ? "none" : "accepted", version: reason === "invalid_request" ? null : 1 },
    ...(reason === "ok" && withCredentials
      ? {
        credentials: {
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          token_expires_at: "2099-01-01T00:00:00.000Z",
        },
      }
      : {}),
  };
}

function rpcReturning(data: unknown, error: unknown = null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: YouTubeAnalyticsRpcRunner = (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve({ data, error });
  };
  return { rpc, calls };
}

Deno.test("decision maps ok and credentials without exposing tokens in its arguments", async () => {
  const { rpc, calls } = rpcReturning(decisionPayload("ok", true));
  const result = await decideYouTubeAnalytics(rpc, {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    withCredentials: true,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.binding.accountId, ACCOUNT_ID);
    assertEquals(result.binding.ownerId, OWNER_ID);
    assertEquals(result.binding.connectionRevision, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assertEquals(result.credentials?.accessToken, "synthetic-access");
  }
  assertEquals(calls[0].fn, "youtube_analytics_stage5_decide");
  assertEquals(calls[0].args.p_required_scopes, [...YOUTUBE_ANALYTICS_REQUIRED_SCOPES]);
  assertEquals(calls[0].args.p_with_credentials, true);
});

for (const reason of [
  "invalid_request",
  "not_found",
  "connection_changed",
  "provider_unsupported",
  "not_enabled",
  "consent_required",
  "reconnect_required",
  "missing_scope",
] as const) {
  Deno.test(`decision maps ${reason} to its typed reason`, async () => {
    const { rpc } = rpcReturning(decisionPayload(reason));
    const result = await decideYouTubeAnalytics(rpc, { ownerId: OWNER_ID, accountId: ACCOUNT_ID });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.code, reason);
      assertEquals(Boolean(result.binding), reason !== "invalid_request" && reason !== "not_found");
    }
  });
}

Deno.test("decision sends all three expected binding values together", async () => {
  const { rpc, calls } = rpcReturning(decisionPayload());
  const admission = await decideYouTubeAnalytics(rpc, { ownerId: OWNER_ID, accountId: ACCOUNT_ID });
  const binding = admission.ok ? admission.binding : null;
  assertEquals(binding !== null, true);
  await decideYouTubeAnalytics(rpc, {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    expected: binding as YouTubeAnalyticsBinding,
  });
  assertEquals(calls[1].args.p_expected_channel, "UCfixturechannel000000001");
  assertEquals(calls[1].args.p_expected_generation, 4);
  assertEquals(calls[1].args.p_expected_incarnation, "0ee40001-0000-4000-8000-000000000041");
});

for (const [name, data, error] of [
  ["RPC error", null, { code: "XX000" }],
  ["missing data", null, null],
  ["malformed data", { ok: true, reason: "ok" }, null],
  ["unknown reason", { ok: false, reason: "off" }, null],
  ["missing requested credentials", decisionPayload("ok", false), null],
] as const) {
  Deno.test(`decision fails closed on ${name}, never off or not_enabled`, async () => {
    const { rpc } = rpcReturning(data, error);
    const result = await decideYouTubeAnalytics(rpc, {
      ownerId: OWNER_ID,
      accountId: ACCOUNT_ID,
      withCredentials: name === "missing requested credentials",
    });
    assertEquals(result, { ok: false, code: "settings_unavailable" });
  });
}

Deno.test("decision catches a thrown RPC failure", async () => {
  const rpc: YouTubeAnalyticsRpcRunner = () => Promise.reject(new Error("database unavailable"));
  assertEquals(await decideYouTubeAnalytics(rpc, { ownerId: OWNER_ID, accountId: ACCOUNT_ID }), {
    ok: false,
    code: "settings_unavailable",
  });
});

Deno.test("admission uses the 120 per minute bucket and returns Retry-After", async () => {
  const { rpc, calls } = rpcReturning({ allowed: false, count: 121, retry_after: 12.2 });
  assertEquals(await checkAdmissionLimit(rpc, OWNER_ID), {
    ok: false,
    code: "rate_limited",
    retryAfterSeconds: 13,
  });
  assertEquals(calls[0], {
    fn: "check_rate_limit",
    args: {
      p_endpoint: `youtube-analytics:admit:${OWNER_ID}`,
      p_identifier: OWNER_ID,
      p_max_requests: 120,
      p_window_seconds: 60,
    },
  });
});

Deno.test("data limit checks burst then daily and stops on the first refusal", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const rpc: YouTubeAnalyticsRpcRunner = (_fn, args) => {
    calls.push(args);
    return Promise.resolve({
      data: calls.length === 1
        ? { allowed: true, count: 60, retry_after: 0 }
        : { allowed: false, count: 301, retry_after: 20 },
      error: null,
    });
  };
  assertEquals(await checkDataLimit(rpc, OWNER_ID), { ok: false, code: "rate_limited", retryAfterSeconds: 20 });
  assertEquals(calls.map((args) => args.p_endpoint), [
    `youtube-analytics:data:10m:${OWNER_ID}`,
    `youtube-analytics:data:24h:${OWNER_ID}`,
  ]);
  assertEquals(calls.map((args) => args.p_max_requests), [60, 300]);
  assertEquals(calls.map((args) => args.p_window_seconds), [600, 86400]);
});

for (const limiter of [checkAdmissionLimit, checkDataLimit]) {
  Deno.test(`${limiter.name} fails closed when its counter cannot be read`, async () => {
    const { rpc } = rpcReturning(null, { code: "XX000" });
    assertEquals(await limiter(rpc, OWNER_ID), { ok: false, code: "settings_unavailable" });
  });
}

Deno.test("data limit does not call the daily counter after a burst refusal", async () => {
  const { rpc, calls } = rpcReturning({ allowed: false, count: 61, retry_after: 5 });
  await checkDataLimit(rpc, OWNER_ID);
  assertEquals(calls.length, 1);
});

Deno.test("budget keys use Pacific dates and a 48-hour window on both sides of midnight", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const rpc: YouTubeAnalyticsRpcRunner = (_fn, args) => {
    calls.push(args);
    return Promise.resolve({ data: { allowed: true, count: calls.length, retry_after: 0 }, error: null });
  };
  assertEquals(await debitSharedBudget(rpc, "data", new Date("2026-11-20T07:59:00.000Z")), { ok: true });
  assertEquals(await debitSharedBudget(rpc, "data", new Date("2026-11-20T08:01:00.000Z")), { ok: true });
  assertEquals(calls.map((args) => args.p_endpoint), [
    "youtube-analytics:budget:data:2026-11-19",
    "youtube-analytics:budget:data:2026-11-20",
  ]);
  assertEquals(calls.map((args) => args.p_window_seconds), [172800, 172800]);
  assertEquals(calls.map((args) => args.p_identifier), ["project", "project"]);
});

Deno.test("budget allows exactly N debits, refuses N+1, and never refunds a spent debit", async () => {
  let count = 0;
  const rpc: YouTubeAnalyticsRpcRunner = () => {
    count += 1;
    return Promise.resolve({
      data: { allowed: count <= 3, count, retry_after: count > 3 ? 60 : 0 },
      error: null,
    });
  };
  const now = new Date("2026-11-20T12:00:00.000Z");
  assertEquals(await debitSharedBudget(rpc, "analytics", now), { ok: true });
  assertEquals(await debitSharedBudget(rpc, "analytics", now), { ok: true });
  assertEquals(await debitSharedBudget(rpc, "analytics", now), { ok: true });
  assertEquals(await debitSharedBudget(rpc, "analytics", now), {
    ok: false,
    code: "capacity_reached",
    retryAfterSeconds: 60,
  });
  assertEquals(count, 4);
});

for (const [name, counter, expected] of [
  ["vanished row", { allowed: true, count: 0, retry_after: 0 }, { ok: false, code: "settings_unavailable" }],
  ["missing counter", { allowed: true, retry_after: 0 }, { ok: false, code: "settings_unavailable" }],
  ["RPC error", null, { ok: false, code: "settings_unavailable" }],
  ["over ceiling", { allowed: true, count: 2001, retry_after: 9 }, { ok: false, code: "capacity_reached", retryAfterSeconds: 9 }],
] as const) {
  Deno.test(`budget refuses ${name} without granting a free request`, async () => {
    const { rpc } = rpcReturning(counter, name === "RPC error" ? { code: "XX000" } : null);
    assertEquals(await debitSharedBudget(rpc, "analytics", new Date("2026-11-20T12:00:00.000Z")), expected);
  });
}

Deno.test("decision rejects a malformed ok response that changes the expected binding", async () => {
  const first = rpcReturning(decisionPayload());
  const admission = await decideYouTubeAnalytics(first.rpc, { ownerId: OWNER_ID, accountId: ACCOUNT_ID });
  if (!admission.ok) throw new Error("expected admission");
  const changed = {
    ...decisionPayload(),
    channel_id: "UCchangedchannel0000000002",
  };
  const second = rpcReturning(changed);
  assertEquals(await decideYouTubeAnalytics(second.rpc, {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    expected: admission.binding,
  }), { ok: false, code: "settings_unavailable" });
});

Deno.test("an inconsistent allowed counter above its ceiling still refuses", async () => {
  const { rpc } = rpcReturning({ allowed: true, count: 121, retry_after: 4 });
  assertEquals(await checkAdmissionLimit(rpc, OWNER_ID), {
    ok: false,
    code: "rate_limited",
    retryAfterSeconds: 4,
  });
});

Deno.test("connection_changed after row deletion keeps its typed reason without a binding", async () => {
  const deletedRow = {
    ...decisionPayload("connection_changed"),
    channel_id: null,
    binding_generation: null,
    binding_incarnation: null,
    connection_revision: null,
    provider: null,
    needs_reauth: null,
    granted_scopes: null,
    consent: { state: "none", version: 1 },
  };
  const { rpc } = rpcReturning(deletedRow);
  const result = await decideYouTubeAnalytics(rpc, { ownerId: OWNER_ID, accountId: ACCOUNT_ID });
  assertEquals(result, {
    ok: false,
    code: "connection_changed",
    consent: { state: "none", version: 1 },
  });
});

Deno.test("Stage A decision honours an existing v1 acceptance when v2 reads as outdated, while Stage B refuses v1", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const rpc: YouTubeAnalyticsRpcRunner = (_fn, args) => {
    calls.push(args);
    const requestedVersion = Number(args.p_purpose_version);
    const isV1 = requestedVersion === 1;
    return Promise.resolve({
      data: {
        ...decisionPayload(isV1 ? "ok" : "consent_required"),
        consent: { state: isV1 ? "accepted" : "outdated", version: requestedVersion },
      },
      error: null,
    });
  };
  const stageA = await decideYouTubeAnalytics(rpc, {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    acceptedVersions: [1, 2],
  });
  assertEquals(stageA.ok, true);
  if (stageA.ok) {
    assertEquals(stageA.binding.consent, { state: "accepted", version: 1 });
  }
  assertEquals(calls.map((args) => args.p_purpose_version), [2, 1]);

  const stageB = await decideYouTubeAnalytics(rpc, {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    acceptedVersions: [2],
  });
  assertEquals(stageB.ok, false);
  if (!stageB.ok) {
    assertEquals(stageB.code, "consent_required");
    assertEquals(stageB.consent, { state: "outdated", version: 2 });
  }
});
