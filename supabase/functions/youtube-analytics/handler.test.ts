import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { refreshYouTubeAccountToken, type YouTubeRefreshOutcome } from "../_shared/youtubeTokenRefresh.ts";
import type { YouTubeAnalyticsReadResult } from "./analyticsReadClient.ts";
import { YOUTUBE_ANALYTICS_REQUIRED_SCOPES, type YouTubeAnalyticsErrorCode } from "./contracts.ts";
import { createBoundYouTubeAnalyticsRefreshStore } from "./credentials.ts";
import type {
  YouTubeAnalyticsBinding,
  YouTubeAnalyticsDecision,
  YouTubeAnalyticsDecisionDenial,
  YouTubeAnalyticsRpcRunner,
} from "./decision.ts";
import {
  createYouTubeAnalyticsHandler,
  type YouTubeAnalyticsPorts,
  type YouTubeAnalyticsTokenPort,
} from "./handler.ts";
import type { YouTubeAnalyticsLimitResult } from "./limits.ts";
import type { YouTubeAnalyticsAudit } from "./audit.ts";
import { FIXTURE_VIDEO_ID } from "./fixtures.ts";

const ENDPOINT = "https://api.postora.cloud/functions/v1/youtube-analytics";
const USER_ID = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const REQUEST_ID = "0ee90001-0000-4000-8000-000000000091";
const REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2026-11-20T12:00:00.000Z");
const BINDING: YouTubeAnalyticsBinding = {
  accountId: ACCOUNT_ID,
  ownerId: USER_ID,
  channelId: "UCfixturechannel000000001",
  bindingGeneration: 4,
  bindingIncarnation: "0ee40001-0000-4000-8000-000000000041",
  connectionRevision: REVISION,
  provider: "native",
  needsReauth: false,
  grantedScopes: [...YOUTUBE_ANALYTICS_REQUIRED_SCOPES],
  consent: { state: "accepted", version: 1 },
};

function allow(withCredentials = false): YouTubeAnalyticsDecision {
  return {
    ok: true,
    binding: BINDING,
    ...(withCredentials
      ? {
        credentials: {
          accessToken: "stored-access",
          refreshToken: "stored-refresh",
          tokenExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      }
      : {}),
  };
}

function deny(code: YouTubeAnalyticsErrorCode): YouTubeAnalyticsDecision {
  return {
    ok: false,
    code,
    ...(code !== "not_found" && code !== "invalid_request" && code !== "settings_unavailable"
      ? { binding: BINDING }
      : {}),
    consent: code === "consent_required" ? { state: "none", version: 1 } : BINDING.consent,
  };
}

function fresh(status: "fresh" | "reused" | "refreshed" = "fresh", accessToken = "stored-access"): YouTubeRefreshOutcome {
  return { ok: true, status, accessToken, expiresAt: "2099-01-01T00:00:00.000Z", grantedScopes: null };
}

function tokenFailure(status: "needs_reauth" | "retryable_refusal" = "needs_reauth"): YouTubeRefreshOutcome {
  return {
    ok: false,
    status,
    retryable: status === "retryable_refusal",
    reason: status === "needs_reauth" ? "invalid_grant" : "refresh_request_failed",
    accessToken: null,
    expiresAt: null,
    needsReauth: status === "needs_reauth",
  };
}

const OK_LIMIT: YouTubeAnalyticsLimitResult = { ok: true };
const CAPACITY: YouTubeAnalyticsLimitResult = { ok: false, code: "capacity_reached", retryAfterSeconds: 30 };

interface FixtureOptions {
  authenticated?: boolean;
  authUserId?: string;
  decideError?: boolean;
  decisions?: YouTubeAnalyticsDecision[];
  tokens?: YouTubeRefreshOutcome[];
  tokenDenials?: Array<YouTubeAnalyticsDecisionDenial | null>;
  tokenExchanges?: number[];
  admission?: YouTubeAnalyticsLimitResult;
  dataLimit?: YouTubeAnalyticsLimitResult;
  debits?: YouTubeAnalyticsLimitResult[];
  summaries?: YouTubeAnalyticsReadResult<{ metrics: []; has_data: boolean }>[];
  dailies?: YouTubeAnalyticsReadResult<{ rows: []; coverage: { first_day: null; last_day: null; days_returned: 0; days_missing: 7 } }>[];
  topVideos?: YouTubeAnalyticsReadResult<{ rows: Array<{ videoId: string; metrics: [] }> }>[];
  ownerships?: YouTubeAnalyticsReadResult<{ owned: true }>[];
  titles?: YouTubeAnalyticsReadResult<{
    titles: Record<string, string>;
    details: Record<string, { published_at: string | null; thumbnail_url: string | null }>;
  }>[];
  consentResult?: Awaited<ReturnType<YouTubeAnalyticsPorts["consent"]["record"]>>;
  audit?: YouTubeAnalyticsAudit;
  now?: Date;
}

function fixture(options: FixtureOptions = {}) {
  const decisions = [...(options.decisions ?? [])];
  const tokens = [...(options.tokens ?? [])];
  const tokenDenials = [...(options.tokenDenials ?? [])];
  const debits = [...(options.debits ?? [])];
  const summaries = [...(options.summaries ?? [])];
  const dailies = [...(options.dailies ?? [])];
  const topVideos = [...(options.topVideos ?? [])];
  const ownerships = [...(options.ownerships ?? [])];
  const titles = [...(options.titles ?? [])];
  const calls = {
    tokenEndpoint: 0,
    tokenGets: 0,
    data: 0,
    analytics: 0,
    ownership: 0,
    titles: 0,
    dataDebits: 0,
    analyticsDebits: 0,
    decide: 0,
    credentialDecisions: 0,
    consent: 0,
    auditRefusals: [] as Array<{ code: string; kind: string; accountId?: string }>,
    auditSuccess: [] as Array<{ operation: string; accountId?: string }>,
    decisionInputs: [] as Array<{ withCredentials?: boolean; expected?: YouTubeAnalyticsBinding }>,
    consentInputs: [] as Array<Parameters<YouTubeAnalyticsPorts["consent"]["record"]>[0]>,
  };
  const decisionInputs = calls.decisionInputs;
  const consentInputs = calls.consentInputs;
  const forceFlags: boolean[] = [];
  let tokenPort: YouTubeAnalyticsTokenPort | null = null;
  const defaultAudit: YouTubeAnalyticsAudit = {
    refusal: (entry, kind) => {
      calls.auditRefusals.push({ code: entry.code, kind, accountId: entry.accountId });
      return Promise.resolve();
    },
    success: (entry) => {
      calls.auditSuccess.push({ operation: entry.operation, accountId: entry.accountId });
      return Promise.resolve();
    },
  };
  const ports: YouTubeAnalyticsPorts = {
    auth: {
      authenticate: () => options.authenticated === false
        ? Promise.reject(new Error("unauthorized"))
        : Promise.resolve({ userId: options.authUserId ?? USER_ID }),
    },
    clock: { now: () => options.now ?? NOW },
    ids: { requestId: () => REQUEST_ID },
    decide: (input) => {
      calls.decide += 1;
      if (options.decideError) return Promise.reject(new Error("unexpected decision failure"));
      if (input.withCredentials) calls.credentialDecisions += 1;
      decisionInputs.push({ withCredentials: input.withCredentials, expected: input.expected });
      return Promise.resolve(decisions.shift() ?? allow(input.withCredentials));
    },
    limits: {
      admission: () => Promise.resolve(options.admission ?? OK_LIMIT),
      data: () => Promise.resolve(options.dataLimit ?? OK_LIMIT),
      debit: (kind) => {
        if (kind === "data") calls.dataDebits += 1;
        else calls.analyticsDebits += 1;
        return Promise.resolve(debits.shift() ?? OK_LIMIT);
      },
    },
    tokens: {
      bind: () => {
        let lastDenial: YouTubeAnalyticsDecisionDenial | null = null;
        tokenPort = {
          get lastDenial() {
            return lastDenial;
          },
          get: (_snapshot, force) => {
            calls.tokenGets += 1;
            forceFlags.push(force);
            const index = calls.tokenGets - 1;
            calls.tokenEndpoint += options.tokenExchanges?.[index] ?? 0;
            lastDenial = tokenDenials[index] ?? null;
            return Promise.resolve(tokens[index] ?? fresh());
          },
        };
        return tokenPort;
      },
    },
    reader: {
      readSummary: () => {
        calls.analytics += 1;
        return Promise.resolve(summaries.shift() ?? { ok: true, value: { metrics: [], has_data: true } });
      },
      readDaily: () => {
        calls.analytics += 1;
        return Promise.resolve(dailies.shift() ?? {
          ok: true,
          value: {
            rows: [],
            coverage: { first_day: null, last_day: null, days_returned: 0, days_missing: 7 },
          },
        });
      },
      readTopVideos: () => {
        calls.analytics += 1;
        return Promise.resolve(topVideos.shift() ?? {
          ok: true,
          value: { rows: [{ videoId: FIXTURE_VIDEO_ID, metrics: [] }] },
        });
      },
      lookupVideoOwnership: () => {
        calls.data += 1;
        calls.ownership += 1;
        return Promise.resolve(ownerships.shift() ?? { ok: true, value: { owned: true } });
      },
      lookupVideoTitles: () => {
        calls.data += 1;
        calls.titles += 1;
        return Promise.resolve(titles.shift() ?? {
          ok: true,
          value: {
            titles: { [FIXTURE_VIDEO_ID]: "Synthetic title" },
            details: {
              [FIXTURE_VIDEO_ID]: {
                published_at: "2026-11-01T12:00:00Z",
                thumbnail_url: "https://i.ytimg.com/vi/videoAAAAAAA/mqdefault.jpg",
              },
            },
          },
        });
      },
    },
    consent: {
      record: (input) => {
        calls.consent += 1;
        consentInputs.push(input);
        return Promise.resolve(options.consentResult ?? {
          ok: true,
          recorded: true,
          connectionRevision: REVISION,
          consent: { state: input.event, version: 1 },
        });
      },
    },
    audit: options.audit ?? defaultAudit,
  };
  return { handler: createYouTubeAnalyticsHandler(ports), calls, decisionInputs, consentInputs, forceFlags, tokenPort };
}

function body(operation = "summary", extra: Record<string, unknown> = {}) {
  if (operation === "status") return { operation, account_id: ACCOUNT_ID, ...extra };
  if (operation === "consent_accept") {
    return {
      operation,
      account_id: ACCOUNT_ID,
      purpose_version: 1,
      locale: "en",
      connection_revision: REVISION,
      ...extra,
    };
  }
  if (operation === "consent_withdraw") return { operation, account_id: ACCOUNT_ID, ...extra };
  return {
    operation,
    account_id: ACCOUNT_ID,
    period_days: 7,
    window_end: "2026-11-17",
    ...extra,
  };
}

function request(payload: unknown, method = "POST"): Request {
  return new Request(ENDPOINT, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(payload) : undefined,
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function assertCounts(
  calls: ReturnType<typeof fixture>["calls"],
  expected: { token: number; data: number; analytics: number; dataDebits?: number; analyticsDebits?: number },
) {
  assertEquals(calls.tokenEndpoint, expected.token, "token endpoint count");
  assertEquals(calls.data, expected.data, "Data API count");
  assertEquals(calls.analytics, expected.analytics, "Analytics API count");
  if (expected.dataDebits !== undefined) assertEquals(calls.dataDebits, expected.dataDebits, "data debit count");
  if (expected.analyticsDebits !== undefined) assertEquals(calls.analyticsDebits, expected.analyticsDebits, "analytics debit count");
}

Deno.test("method, anonymous and service-role-shaped callers get no-store refusals and no audit row", async () => {
  const f = fixture();
  const method = await f.handler(request({}, "GET"));
  assertEquals(method.status, 405);
  assertEquals(method.headers.get("Cache-Control"), "no-store");
  const anonymous = await f.handler(request(body(), "PUT"));
  assertEquals(anonymous.status, 405);
  const unauthenticated = fixture({ authenticated: false });
  const denied = await unauthenticated.handler(request(body()));
  assertEquals(denied.status, 401);
  assertEquals(denied.headers.get("Cache-Control"), "no-store");
  assertEquals(unauthenticated.calls.auditRefusals.length, 0);
  const serviceRole = fixture({ authUserId: "service_role" });
  const service = await serviceRole.handler(request(body()));
  assertEquals(service.status, 401);
  assertEquals(serviceRole.calls.auditRefusals.length, 0);
  const preflight = await f.handler(request({}, "OPTIONS"));
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("Cache-Control"), "no-store");
});

for (const [name, payload] of [
  ["unknown key", { ...body(), unexpected: true }],
  ["body user_id", { ...body(), user_id: USER_ID }],
  ["body channel_id", { ...body(), channel_id: "UCattacker" }],
  ["malformed video ID", body("summary", { video_id: "bad/id" })],
  ["malformed window_end", body("summary", { window_end: "2026-02-30" })],
  ["unsupported period", body("summary", { period_days: 8 })],
  ["top_videos video_id", body("top_videos", { video_id: FIXTURE_VIDEO_ID })],
  ["top_videos start_index 0", body("top_videos", { start_index: 0 })],
  ["top_videos start_index 192", body("top_videos", { start_index: 192 })],
  ["top_videos fractional start_index", body("top_videos", { start_index: 1.5 })],
  ["top_videos string start_index", body("top_videos", { start_index: "1" })],
] as const) {
  Deno.test(`strict validation refuses ${name} after admission and before decide`, async () => {
    const f = fixture();
    const response = await f.handler(request(payload));
    assertEquals(response.status, 400);
    assertEquals((await json(response)).error, "invalid_request");
    assertEquals(f.calls.decide, 0);
    assertEquals(f.calls.auditRefusals[0].accountId, undefined);
    assertCounts(f.calls, { token: 0, data: 0, analytics: 0 });
  });
}

Deno.test("malformed JSON still spends admission but no decision or Google call", async () => {
  const f = fixture();
  const response = await f.handler(new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  }));
  assertEquals(response.status, 400);
  assertEquals(f.calls.decide, 0);
  assertCounts(f.calls, { token: 0, data: 0, analytics: 0 });
});

Deno.test("admission limiter runs before validation and has a bounded terminal response", async () => {
  const f = fixture({ admission: { ok: false, code: "rate_limited", retryAfterSeconds: 17 } });
  const response = await f.handler(request({ not: "valid" }));
  assertEquals(response.status, 429);
  assertEquals((await json(response)).retry_after_seconds, 17);
  assertEquals(f.calls.decide, 0);
  assertEquals(f.calls.auditRefusals[0].kind, "admission");
});

for (const [code, status] of [
  ["not_found", 404],
  ["provider_unsupported", 409],
  ["not_enabled", 403],
  ["consent_required", 403],
  ["reconnect_required", 409],
  ["missing_scope", 403],
  ["connection_changed", 409],
] as const) {
  Deno.test(`admission reason ${code} has no token or Google work`, async () => {
    const f = fixture({ decisions: [deny(code)] });
    const response = await f.handler(request(body()));
    assertEquals(response.status, status);
    assertEquals((await json(response)).error, code);
    assertCounts(f.calls, { token: 0, data: 0, analytics: 0 });
  });
}

Deno.test("status success and refusal carry revision, reporting window, consent and purpose version", async () => {
  const ok = fixture();
  const available = await ok.handler(request(body("status")));
  assertEquals(available.status, 200);
  const availableBody = await json(available);
  assertEquals(availableBody.connection_revision, REVISION);
  assertEquals((availableBody.data as Record<string, unknown>).reporting_end_date, "2026-11-17");
  assertEquals((availableBody.data as Record<string, unknown>).purpose_version, 1);
  assertCounts(ok.calls, { token: 0, data: 0, analytics: 0 });

  const refused = fixture({ decisions: [deny("consent_required")] });
  const response = await refused.handler(request(body("status")));
  assertEquals(response.status, 403);
  const error = await json(response);
  assertEquals(error.error, "consent_required");
  assertEquals(error.connection_revision, REVISION);
  assertEquals(error.reporting_end_date, "2026-11-17");
  assertEquals(error.consent, { state: "none", version: 1 });
  assertEquals(error.purpose_version, 1);
});

Deno.test("consent accept and withdraw never read credentials or call Google and each audit once", async () => {
  for (const [operation, expectedEvent] of [
    ["consent_accept", "accepted"],
    ["consent_withdraw", "withdrawn"],
  ] as const) {
    const f = fixture();
    const response = await f.handler(request(body(operation)));
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Cache-Control"), "no-store");
    assertEquals(f.calls.consent, 1);
    assertEquals(f.consentInputs[0].event, expectedEvent);
    const payload = await json(response);
    assertEquals(((payload.data as { consent: { state: string } }).consent).state, expectedEvent);
    assertEquals(f.calls.decide, 0);
    assertEquals(f.calls.auditSuccess.length, 1);
    assertCounts(f.calls, { token: 0, data: 0, analytics: 0 });
  }
});

Deno.test("stale consent version, changed revision and not-enabled acceptance are typed refusals", async () => {
  for (const [result, status, code] of [
    [{ ok: false as const, code: "consent_version_stale" as const }, 409, "consent_version_stale"],
    [{ ok: false as const, code: "connection_changed" as const }, 409, "connection_changed"],
    [{ ok: false as const, code: "not_enabled" as const }, 403, "not_enabled"],
  ] as const) {
    const f = fixture({ consentResult: result });
    const response = await f.handler(request(body("consent_accept")));
    assertEquals(response.status, status);
    assertEquals((await json(response)).error, code);
    assertCounts(f.calls, { token: 0, data: 0, analytics: 0 });
  }
});

Deno.test("table row 1: credential refusal stops before token and Google", async () => {
  const f = fixture({ decisions: [allow(), deny("reconnect_required")] });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 409);
  assertCounts(f.calls, { token: 0, data: 0, analytics: 0 });
});

Deno.test("table row 2: valid summary makes one Analytics attempt", async () => {
  const f = fixture();
  const response = await f.handler(request(body()));
  assertEquals(response.status, 200);
  assertCounts(f.calls, { token: 0, data: 0, analytics: 1, analyticsDebits: 1 });
  assertEquals((await json(response)).connection_revision, REVISION);
});

Deno.test("table row 3: expired token refresh succeeds before one Analytics call", async () => {
  const f = fixture({ tokens: [fresh("refreshed", "new-access")], tokenExchanges: [1] });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 200);
  assertCounts(f.calls, { token: 1, data: 0, analytics: 1, analyticsDebits: 1 });
});

for (const [name, outcome, code, status] of [
  ["invalid grant", tokenFailure("needs_reauth"), "reconnect_required", 409],
  ["transient failure", tokenFailure("retryable_refusal"), "upstream_unavailable", 502],
] as const) {
  Deno.test(`table row 4: ${name} during refresh stops before Analytics`, async () => {
    const f = fixture({ tokens: [outcome], tokenExchanges: [1] });
    const response = await f.handler(request(body()));
    assertEquals(response.status, status);
    assertEquals((await json(response)).error, code);
    assertCounts(f.calls, { token: 1, data: 0, analytics: 0 });
  });
}

Deno.test("table row 5: Analytics 401 on a token refreshed in this request is never repeated", async () => {
  const f = fixture({
    tokens: [fresh("refreshed", "new-access")],
    tokenExchanges: [1],
    summaries: [{ ok: false, code: "unauthorized" }],
  });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 409);
  assertEquals((await json(response)).error, "reconnect_required");
  assertCounts(f.calls, { token: 1, data: 0, analytics: 1, analyticsDebits: 1 });
  assertEquals(f.forceFlags, [false]);
});

Deno.test("table row 6: valid token 401 forces one refresh and one new attempt", async () => {
  const f = fixture({
    tokens: [fresh(), fresh("refreshed", "new-access")],
    tokenExchanges: [0, 1],
    summaries: [{ ok: false, code: "unauthorized" }, { ok: true, value: { metrics: [], has_data: true } }],
  });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 200);
  assertCounts(f.calls, { token: 1, data: 0, analytics: 2, analyticsDebits: 2 });
  assertEquals(f.forceFlags, [false, true]);
});

Deno.test("table row 7: repeat 401 becomes reconnect_required", async () => {
  const f = fixture({
    tokens: [fresh(), fresh("refreshed", "new-access")],
    tokenExchanges: [0, 1],
    summaries: [{ ok: false, code: "unauthorized" }, { ok: false, code: "unauthorized" }],
  });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 409);
  assertCounts(f.calls, { token: 1, data: 0, analytics: 2, analyticsDebits: 2 });
});

Deno.test("table row 8: forced refresh bound refusal wins over helper outcome", async () => {
  const f = fixture({
    tokenDenials: [null, { code: "connection_changed", binding: BINDING }],
    summaries: [{ ok: false, code: "unauthorized" }],
  });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 409);
  assertEquals((await json(response)).error, "connection_changed");
  assertCounts(f.calls, { token: 0, data: 0, analytics: 1, analyticsDebits: 1 });
});

Deno.test("table row 9: refused repeat debit is capacity_reached after one real Analytics call", async () => {
  const f = fixture({
    tokens: [fresh(), fresh("refreshed", "new-access")],
    tokenExchanges: [0, 1],
    debits: [OK_LIMIT, CAPACITY],
    summaries: [{ ok: false, code: "unauthorized" }],
  });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 429);
  assertEquals((await json(response)).error, "capacity_reached");
  assertCounts(f.calls, { token: 1, data: 0, analytics: 1, analyticsDebits: 2 });
});

Deno.test("table row 10: first refused debit prevents decision and provider send", async () => {
  const f = fixture({ debits: [CAPACITY] });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 429);
  assertCounts(f.calls, { token: 0, data: 0, analytics: 0, analyticsDebits: 1 });
  assertEquals(f.calls.decide, 2);
});

Deno.test("table row 11: decision refusal after debit spends the unit but sends nothing", async () => {
  const f = fixture({ decisions: [allow(), allow(true), deny("consent_required")] });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 403);
  assertCounts(f.calls, { token: 0, data: 0, analytics: 0, analyticsDebits: 1 });
});

Deno.test("table row 12: owned video performs ownership then Analytics", async () => {
  const f = fixture();
  const response = await f.handler(request(body("summary", { video_id: FIXTURE_VIDEO_ID })));
  assertEquals(response.status, 200);
  assertCounts(f.calls, { token: 0, data: 1, analytics: 1, dataDebits: 1, analyticsDebits: 1 });
});

for (const [name, ownership, code, status] of [
  ["not owned", { ok: false as const, code: "video_not_found" as const }, "video_not_found", 404],
  ["quota", { ok: false as const, code: "quota_exceeded" as const }, "quota_exceeded", 429],
  ["timeout", { ok: false as const, code: "upstream_unavailable" as const }, "upstream_unavailable", 502],
] as const) {
  Deno.test(`table rows 13-14: ownership ${name} prevents Analytics`, async () => {
    const f = fixture({ ownerships: [ownership] });
    const response = await f.handler(request(body("summary", { video_id: FIXTURE_VIDEO_ID })));
    assertEquals(response.status, status);
    assertEquals((await json(response)).error, code);
    assertCounts(f.calls, { token: 0, data: 1, analytics: 0, dataDebits: 1 });
  });
}

Deno.test("table row 15: expired video request refreshes once before both reads", async () => {
  const f = fixture({ tokens: [fresh("refreshed", "new-access")], tokenExchanges: [1] });
  const response = await f.handler(request(body("summary", { video_id: FIXTURE_VIDEO_ID })));
  assertEquals(response.status, 200);
  assertCounts(f.calls, { token: 1, data: 1, analytics: 1, dataDebits: 1, analyticsDebits: 1 });
});

Deno.test("table row 16: ownership 401 forces refresh and repeats ownership before Analytics", async () => {
  const f = fixture({
    tokens: [fresh(), fresh("refreshed", "new-access")],
    tokenExchanges: [0, 1],
    ownerships: [{ ok: false, code: "unauthorized" }, { ok: true, value: { owned: true } }],
  });
  const response = await f.handler(request(body("summary", { video_id: FIXTURE_VIDEO_ID })));
  assertEquals(response.status, 200);
  assertCounts(f.calls, { token: 1, data: 2, analytics: 1, dataDebits: 2, analyticsDebits: 1 });
});

Deno.test("table row 17: Analytics 401 after forced refresh was spent on ownership never repeats", async () => {
  const f = fixture({
    tokens: [fresh(), fresh("refreshed", "new-access")],
    tokenExchanges: [0, 1],
    ownerships: [{ ok: false, code: "unauthorized" }, { ok: true, value: { owned: true } }],
    summaries: [{ ok: false, code: "unauthorized" }],
  });
  const response = await f.handler(request(body("summary", { video_id: FIXTURE_VIDEO_ID })));
  assertEquals(response.status, 409);
  assertCounts(f.calls, { token: 1, data: 2, analytics: 1, dataDebits: 2, analyticsDebits: 1 });
  assertEquals(f.forceFlags, [false, true]);
});

Deno.test("table row 18: Analytics debit refusal after ownership prevents Analytics", async () => {
  const f = fixture({ debits: [OK_LIMIT, CAPACITY] });
  const response = await f.handler(request(body("summary", { video_id: FIXTURE_VIDEO_ID })));
  assertEquals(response.status, 429);
  assertCounts(f.calls, { token: 0, data: 1, analytics: 0, dataDebits: 1, analyticsDebits: 1 });
});

Deno.test("table row 19: top videos enriches titles with one Data call", async () => {
  const f = fixture();
  const response = await f.handler(request(body("top_videos")));
  assertEquals(response.status, 200);
  const payload = await json(response);
  const data = payload.data as {
    titles: string;
    has_more: boolean;
    next_start_index: number | null;
    rows: Array<{ title: string; link: string; published_at: string | null; thumbnail_url: string | null }>;
  };
  assertEquals(data.titles, "complete");
  assertEquals(data.has_more, false);
  assertEquals(data.next_start_index, null);
  assertEquals(data.rows[0].title, "Synthetic title");
  assertEquals(data.rows[0].published_at, "2026-11-01T12:00:00Z");
  assertEquals(data.rows[0].thumbnail_url, "https://i.ytimg.com/vi/videoAAAAAAA/mqdefault.jpg");
  assert(data.rows[0].link.includes(encodeURIComponent(FIXTURE_VIDEO_ID)));
  assertCounts(f.calls, { token: 0, data: 1, analytics: 1, dataDebits: 1, analyticsDebits: 1 });
});

Deno.test("table row 20: title 401 returns analytics with unavailable titles and no refresh or repeat", async () => {
  const f = fixture({ titles: [{ ok: false, code: "unauthorized" }] });
  const response = await f.handler(request(body("top_videos")));
  assertEquals(response.status, 200);
  const data = (await json(response)).data as {
    titles: string;
    rows: Array<{ title: string | null; published_at: string | null; thumbnail_url: string | null }>;
  };
  assertEquals(data.titles, "unavailable");
  assertEquals(data.rows[0].title, null);
  assertEquals(data.rows[0].published_at, null);
  assertEquals(data.rows[0].thumbnail_url, null);
  assertCounts(f.calls, { token: 0, data: 1, analytics: 1, dataDebits: 1, analyticsDebits: 1 });
  assertEquals(f.forceFlags, [false]);
});

Deno.test("table row 21: refused title debit still returns analytics with unavailable titles", async () => {
  const f = fixture({ debits: [OK_LIMIT, CAPACITY] });
  const response = await f.handler(request(body("top_videos")));
  assertEquals(response.status, 200);
  assertEquals(((await json(response)).data as { titles: string }).titles, "unavailable");
  assertCounts(f.calls, { token: 0, data: 0, analytics: 1, dataDebits: 1, analyticsDebits: 1 });
});

Deno.test("table row 22: empty top videos skips title lookup", async () => {
  const f = fixture({ topVideos: [{ ok: true, value: { rows: [] } }] });
  const response = await f.handler(request(body("top_videos")));
  assertEquals(response.status, 200);
  assertEquals(((await json(response)).data as { rows: [] }).rows, []);
  assertCounts(f.calls, { token: 0, data: 0, analytics: 1, analyticsDebits: 1 });
  assertEquals(f.calls.titles, 0);
});

for (const [name, rowCount, startIndex, hasMore, nextStartIndex] of [
  ["full first page", 10, 1, true, 11],
  ["full last possible page", 10, 191, false, null],
  ["partial page", 9, 1, false, null],
  ["empty page", 0, 191, false, null],
] as const) {
  Deno.test(`top videos pagination handles ${name}`, async () => {
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      videoId: `video${String(index).padStart(7, "0")}`,
      metrics: [] as [],
    }));
    const f = fixture({ topVideos: [{ ok: true, value: { rows } }] });
    const response = await f.handler(request(body("top_videos", { start_index: startIndex })));
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Cache-Control"), "no-store");
    const data = (await json(response)).data as { has_more: boolean; next_start_index: number | null };
    assertEquals(data.has_more, hasMore);
    assertEquals(data.next_start_index, nextStartIndex);
  });
}

Deno.test("table row 23: final decision refusal discards provider data", async () => {
  const f = fixture({ decisions: [allow(), allow(true), allow(), deny("not_enabled")] });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 403);
  const payload = await json(response);
  assertEquals(payload.error, "not_enabled");
  assertEquals(payload.data, undefined);
  assertCounts(f.calls, { token: 0, data: 0, analytics: 1, analyticsDebits: 1 });
  assertEquals(f.calls.auditSuccess.length, 0);
});

Deno.test("consent withdrawal at credential, pre-attempt and final checks stops at the next decision", async () => {
  const credential = fixture({ decisions: [allow(), deny("consent_required")] });
  assertEquals((await credential.handler(request(body()))).status, 403);
  assertCounts(credential.calls, { token: 0, data: 0, analytics: 0 });

  const attempt = fixture({ decisions: [allow(), allow(true), deny("consent_required")] });
  assertEquals((await attempt.handler(request(body()))).status, 403);
  assertCounts(attempt.calls, { token: 0, data: 0, analytics: 0, analyticsDebits: 1 });

  const final = fixture({ decisions: [allow(), allow(true), allow(), deny("consent_required")] });
  assertEquals((await final.handler(request(body()))).status, 403);
  assertCounts(final.calls, { token: 0, data: 0, analytics: 1, analyticsDebits: 1 });
});

Deno.test("binding races before credentials and before a needed refresh produce no Google call", async () => {
  const beforeCredentials = fixture({ decisions: [allow(), deny("connection_changed")] });
  assertEquals((await beforeCredentials.handler(request(body()))).status, 409);
  assertCounts(beforeCredentials.calls, { token: 0, data: 0, analytics: 0 });

  const beforeRefresh = fixture({
    tokenDenials: [{ code: "connection_changed", binding: BINDING }],
    tokens: [fresh()],
  });
  assertEquals((await beforeRefresh.handler(request(body()))).status, 409);
  assertCounts(beforeRefresh.calls, { token: 0, data: 0, analytics: 0 });
});

Deno.test("provider missing_scope includes grant_not_effective only when all required grants were recorded", async () => {
  const f = fixture({ summaries: [{ ok: false, code: "missing_scope" }] });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 403);
  assertEquals((await json(response)).detail, "grant_not_effective");
});

Deno.test("window_stale, data rate limit and internal failures keep no-store and never look empty", async () => {
  const stale = fixture();
  const staleResponse = await stale.handler(request(body("summary", { window_end: "2026-11-15" })));
  assertEquals(staleResponse.status, 409);
  assertEquals((await json(staleResponse)).error, "window_stale");
  assertCounts(stale.calls, { token: 0, data: 0, analytics: 0 });

  const limited = fixture({ dataLimit: { ok: false, code: "rate_limited", retryAfterSeconds: 8 } });
  const limitedResponse = await limited.handler(request(body()));
  assertEquals(limitedResponse.status, 429);
  assertEquals(limitedResponse.headers.get("Cache-Control"), "no-store");
  assertCounts(limited.calls, { token: 0, data: 0, analytics: 0 });

  const upstream = fixture({ summaries: [{ ok: false, code: "upstream_unavailable" }] });
  const upstreamResponse = await upstream.handler(request(body()));
  assertEquals(upstreamResponse.status, 502);
  assertEquals((await json(upstreamResponse)).data, undefined);
});

Deno.test("success audit is initiated without being awaited before the response", async () => {
  let successCalled = false;
  const audit: YouTubeAnalyticsAudit = {
    refusal: () => Promise.resolve(),
    success: () => {
      successCalled = true;
      return new Promise<void>(() => {});
    },
  };
  const f = fixture({ audit });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      f.handler(request(body())),
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new Error("handler awaited success audit")), 50);
      }),
    ]);
    assertEquals(response.status, 200);
    assertEquals(successCalled, true);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
});

Deno.test("an unexpected admission exception never logs an unverified account ID", async () => {
  const f = fixture({ decideError: true });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 500);
  assertEquals((await json(response)).error, "internal_error");
  assertEquals(f.calls.auditRefusals[0].accountId, undefined);
});

Deno.test("success responses never contain an access or refresh token", async () => {
  const f = fixture({ tokens: [fresh("refreshed", "new-access")], tokenExchanges: [1] });
  const response = await f.handler(request(body()));
  const text = JSON.stringify(await json(response));
  assertEquals(text.includes("stored-access"), false);
  assertEquals(text.includes("new-access"), false);
  assertEquals(text.includes("stored-refresh"), false);
  assertEquals(response.headers.get("Cache-Control"), "no-store");
});

Deno.test("real refresh helper forced refresh after reused token exchanges a new token instead of reusing the 401 token", async () => {
  let storedToken = "token-b-from-other-worker";
  let exchanges = 0;
  const rpc: YouTubeAnalyticsRpcRunner = (fn) => {
    if (fn === "youtube_analytics_stage5_decide") {
      return Promise.resolve({
        data: {
          ok: true,
          reason: "ok",
          channel_id: BINDING.channelId,
          binding_generation: BINDING.bindingGeneration,
          binding_incarnation: BINDING.bindingIncarnation,
          connection_revision: BINDING.connectionRevision,
          provider: "native",
          needs_reauth: false,
          granted_scopes: [...YOUTUBE_ANALYTICS_REQUIRED_SCOPES],
          consent: { state: "accepted", version: 1 },
          credentials: {
            access_token: storedToken,
            refresh_token: "stored-refresh",
            token_expires_at: "2099-01-01T00:00:00.000Z",
          },
        },
        error: null,
      });
    }
    if (fn === "youtube_analytics_stage5_acquire_lease") {
      return Promise.resolve({
        data: { ok: true, lease_token: "0ee50001-0000-4000-8000-000000000051", expires_at: "2026-11-20T12:01:00.000Z" },
        error: null,
      });
    }
    if (fn === "youtube_analytics_stage5_store_token") {
      storedToken = "token-c-freshly-minted";
      return Promise.resolve({ data: { ok: true }, error: null });
    }
    return Promise.resolve({ data: true, error: null });
  };
  const seenTokens: string[] = [];
  const f = fixture({
    decisions: [
      allow(false),
      {
        ok: true,
        binding: BINDING,
        credentials: {
          accessToken: "token-a-expired-snapshot",
          refreshToken: "stored-refresh",
          tokenExpiresAt: "2020-01-01T00:00:00.000Z",
        },
      },
      allow(false),
      allow(false),
      allow(false),
    ],
  });
  const ports: YouTubeAnalyticsPorts = {
    auth: { authenticate: () => Promise.resolve({ userId: USER_ID }) },
    clock: { now: () => NOW },
    ids: { requestId: () => REQUEST_ID },
    decide: () => Promise.resolve({
      ok: true,
      binding: BINDING,
      credentials: {
        accessToken: "token-a-expired-snapshot",
        refreshToken: "stored-refresh",
        tokenExpiresAt: "2020-01-01T00:00:00.000Z",
      },
    }),
    limits: {
      admission: () => Promise.resolve(OK_LIMIT),
      data: () => Promise.resolve(OK_LIMIT),
      debit: () => Promise.resolve(OK_LIMIT),
    },
    tokens: {
      bind(binding) {
        const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding });
        return {
          get lastDenial() {
            return store.lastDenial;
          },
          get: (snapshot, force) => refreshYouTubeAccountToken({
            accountId: binding.accountId,
            snapshot,
            force,
            healthNeutral: true,
            recordTransientFailure: false,
            store,
            nowMs: () => NOW.getTime(),
            exchange: () => {
              exchanges += 1;
              return Promise.resolve({
                ok: true,
                accessToken: "token-c-freshly-minted",
                expiresIn: 3600,
                refreshToken: "stored-refresh",
                scope: YOUTUBE_ANALYTICS_REQUIRED_SCOPES.join(" "),
              });
            },
          }),
        };
      },
    },
    reader: {
      readSummary: (accessToken) => {
        seenTokens.push(accessToken);
        if (seenTokens.length === 1) {
          return Promise.resolve({ ok: false, code: "unauthorized" });
        }
        return Promise.resolve({ ok: true, value: { metrics: [], has_data: true } });
      },
      readDaily: () => Promise.resolve({ ok: false, code: "upstream_unavailable" }),
      readTopVideos: () => Promise.resolve({ ok: false, code: "upstream_unavailable" }),
      lookupVideoOwnership: () => Promise.resolve({ ok: true, value: { owned: true } }),
      lookupVideoTitles: () => Promise.resolve({ ok: true, value: { titles: {}, details: {} } }),
    },
    consent: {
      record: () => Promise.resolve({
        ok: true,
        recorded: true,
        connectionRevision: REVISION,
        consent: { state: "accepted", version: 1 },
      }),
    },
    audit: { refusal: () => Promise.resolve(), success: () => Promise.resolve() },
  };
  void f;
  const handler = createYouTubeAnalyticsHandler(ports);
  const response = await handler(request(body()));
  assertEquals(response.status, 200);
  assertEquals(exchanges, 1);
  assertEquals(seenTokens, ["token-b-from-other-worker", "token-c-freshly-minted"]);
});

Deno.test("no_refresh_token maps to reconnect_required (409) instead of upstream_unavailable", async () => {
  const f = fixture({
    tokens: [{
      ok: false,
      status: "retryable_refusal",
      retryable: false,
      reason: "no_refresh_token",
      accessToken: null,
      expiresAt: null,
      needsReauth: false,
    }],
  });
  const response = await f.handler(request(body()));
  assertEquals(response.status, 409);
  assertEquals((await json(response)).error, "reconnect_required");
});
