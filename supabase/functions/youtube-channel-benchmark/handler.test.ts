import { assertEquals } from "jsr:@std/assert@1";
import { createYouTubeBenchmarkReadClient } from "./benchmarkReadClient.ts";
import { YOUTUBE_SCOPE } from "../youtube-resources/contracts.ts";
import {
  createYouTubeBenchmarkHandler,
  parseStrictBenchmarkBudgetDecision,
  type YouTubeBenchmarkAccount,
  type YouTubeBenchmarkPorts,
  type YouTubeBenchmarkRefusal,
} from "./handler.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const BOUND_BEARER = "bound-fixture-123";
const REFRESHED_BEARER = "refreshed-fixture-456";
const FIXED_NOW = new Date("2026-11-27T12:00:00.000Z");

function baseAccount(overrides: Partial<YouTubeBenchmarkAccount> = {}): YouTubeBenchmarkAccount {
  return {
    id: ACCOUNT_ID,
    userId: USER_ID,
    channelId: "UC_callerChannel000000000",
    channelTitle: "Caller Channel",
    authProvider: "native",
    needsReauth: false,
    accessToken: BOUND_BEARER,
    refreshToken: "refresh-fixture-123",
    tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly] },
    ...overrides,
  };
}

function makePorts(overrides: Partial<YouTubeBenchmarkPorts> = {}): {
  ports: YouTubeBenchmarkPorts;
  refusals: YouTubeBenchmarkRefusal[];
} {
  const refusals: YouTubeBenchmarkRefusal[] = [];
  const ports: YouTubeBenchmarkPorts = {
    auth: { authenticate: () => Promise.resolve({ userId: USER_ID }) },
    accounts: { load: () => Promise.resolve(baseAccount()) },
    tokens: {
      get: () => Promise.resolve({ ok: true, accessToken: BOUND_BEARER, minted: false }),
    },
    rateLimits: {
      checkUser: () => Promise.resolve({ ok: true, allowed: true }),
    },
    budget: {
      debit: () => Promise.resolve({ allowed: true }),
    },
    read: {
      lookupChannel: ({ input }) =>
        Promise.resolve({
          kind: "channel",
          unitsSpent: 1,
          channel: {
            input: input.toLowerCase(),
            status: "not_found",
            channel_id: null,
            title: null,
            thumbnail_url: null,
            subscriber_count: null,
            subscriber_count_hidden: false,
            view_count: null,
            video_count: null,
            recent_videos: [],
          },
        }),
    },
    audit: {
      logRefusal: (entry) => {
        refusals.push(entry);
        return Promise.resolve();
      },
    },
    clock: { now: () => FIXED_NOW },
    ids: { requestId: () => "req-fixed-1" },
    ...overrides,
  };
  return { ports, refusals };
}

function postReq(body: unknown): Request {
  return new Request("https://api.postora.cloud/functions/v1/youtube-channel-benchmark", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://postora.cloud",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test("handler rejects non-POST, unauthenticated, invalid, and duplicate channel inputs with no-store and audit log", async () => {
  const { ports, refusals } = makePorts();
  const handler = createYouTubeBenchmarkHandler(ports);

  const getRes = await handler(
    new Request("https://api.postora.cloud/functions/v1/youtube-channel-benchmark", { method: "GET" }),
  );
  assertEquals(getRes.status, 400);
  assertEquals(getRes.headers.get("Cache-Control"), "no-store");
  assertEquals((await getRes.json()).error, "invalid_request");

  const dupRes = await handler(postReq({
    account_id: ACCOUNT_ID,
    channels: ["@GoogleDevelopers", "@googledevelopers"],
  }));
  assertEquals(dupRes.status, 400);
  assertEquals((await dupRes.json()).error, "invalid_request");

  const tooManyRes = await handler(postReq({
    account_id: ACCOUNT_ID,
    channels: ["@one1", "@two2", "@three3", "@four4"],
  }));
  assertEquals(tooManyRes.status, 400);

  const { ports: unauthPorts, refusals: unauthRefusals } = makePorts({
    auth: { authenticate: () => Promise.reject(new Error("no jwt")) },
  });
  const unauthRes = await createYouTubeBenchmarkHandler(unauthPorts)(
    postReq({ account_id: ACCOUNT_ID, channels: ["@GoogleDevelopers"] }),
  );
  assertEquals(unauthRes.status, 401);
  assertEquals(unauthRes.headers.get("Cache-Control"), "no-store");
  assertEquals((await unauthRes.json()).error, "unauthenticated");
  assertEquals(unauthRefusals.length, 1);
  assertEquals(refusals.length, 3);
});

Deno.test("handler returns 404 for foreign or missing account and 500 on account load error", async () => {
  const { ports: foreignPorts } = makePorts({
    accounts: {
      load: () => Promise.resolve(baseAccount({ userId: "99999999-9999-4999-8999-999999999999" })),
    },
  });
  const foreignRes = await createYouTubeBenchmarkHandler(foreignPorts)(
    postReq({ account_id: ACCOUNT_ID, channels: ["@GoogleDevelopers"] }),
  );
  assertEquals(foreignRes.status, 404);
  assertEquals((await foreignRes.json()).error, "not_found");

  const { ports: errPorts } = makePorts({
    accounts: { load: () => Promise.reject(new Error("db down")) },
  });
  const errRes = await createYouTubeBenchmarkHandler(errPorts)(
    postReq({ account_id: ACCOUNT_ID, channels: ["@GoogleDevelopers"] }),
  );
  assertEquals(errRes.status, 500);
  assertEquals((await errRes.json()).error, "internal_error");
});

Deno.test("handler enforces capability, rate limit, and budget isolation across channels", async () => {
  const { ports: composioPorts } = makePorts({
    accounts: { load: () => Promise.resolve(baseAccount({ authProvider: "composio" })) },
  });
  const composioRes = await createYouTubeBenchmarkHandler(composioPorts)(
    postReq({ account_id: ACCOUNT_ID, channels: ["@GoogleDevelopers"] }),
  );
  assertEquals(composioRes.status, 409);
  assertEquals((await composioRes.json()).error, "provider_unsupported");

  const { ports: scopePorts } = makePorts({
    accounts: {
      load: () => Promise.resolve(baseAccount({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.upload] } })),
    },
  });
  const scopeRes = await createYouTubeBenchmarkHandler(scopePorts)(
    postReq({ account_id: ACCOUNT_ID, channels: ["@GoogleDevelopers"] }),
  );
  assertEquals(scopeRes.status, 403);
  assertEquals((await scopeRes.json()).error, "missing_scope");

  const { ports: ratePorts } = makePorts({
    rateLimits: {
      checkUser: () => Promise.resolve({ ok: true, allowed: false, retryAfterSeconds: 42 }),
    },
  });
  const rateRes = await createYouTubeBenchmarkHandler(ratePorts)(
    postReq({ account_id: ACCOUNT_ID, channels: ["@GoogleDevelopers"] }),
  );
  assertEquals(rateRes.status, 429);
  assertEquals(await rateRes.json(), {
    error: "rate_limited",
    request_id: "req-fixed-1",
    retry_after_seconds: 42,
  });
});

Deno.test("handler performs single forced refresh on 401 and fails whole request as reconnect_required if still 401", async () => {
  let tokenCalls = 0;
  const readClient = createYouTubeBenchmarkReadClient({
    fetchImpl: (input, init) => {
      const auth = new Headers(init?.headers).get("Authorization");
      const url = String(input);
      if (auth === `Bearer ${BOUND_BEARER}`) {
        return Promise.resolve(new Response("{}", { status: 401 }));
      }
      if (url.includes("forHandle=%40FirstChannel")) {
        return Promise.resolve(new Response(JSON.stringify({
          kind: "youtube#channelListResponse",
          items: [],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        error: { errors: [{ reason: "quotaExceeded" }] },
      }), { status: 403 }));
    },
  });

  const { ports } = makePorts({
    tokens: {
      get: (_account, { force }) => {
        tokenCalls += 1;
        return Promise.resolve({
          ok: true,
          accessToken: force ? REFRESHED_BEARER : BOUND_BEARER,
          minted: force,
        });
      },
    },
    read: readClient,
  });

  const res = await createYouTubeBenchmarkHandler(ports)(
    postReq({ account_id: ACCOUNT_ID, channels: ["@FirstChannel", "@SecondChannel"] }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  assertEquals(tokenCalls, 2);
  const body = await res.json();
  assertEquals(body.data.channels[0].status, "not_found");
  assertEquals(body.data.channels[1].status, "unavailable");
  assertEquals(body.data.channels[1].error, "quota_exceeded");

  // Second case: refreshed token is also rejected with 401 -> whole request fails as reconnect_required.
  const { ports: rejectedPorts } = makePorts({
    tokens: {
      get: (_account, { force }) =>
        Promise.resolve({
          ok: true,
          accessToken: force ? REFRESHED_BEARER : BOUND_BEARER,
          minted: force,
        }),
    },
    read: createYouTubeBenchmarkReadClient({
      fetchImpl: () => Promise.resolve(new Response("{}", { status: 401 })),
    }),
  });
  const rejectedRes = await createYouTubeBenchmarkHandler(rejectedPorts)(
    postReq({ account_id: ACCOUNT_ID, channels: ["@FirstChannel", "@SecondChannel"] }),
  );
  assertEquals(rejectedRes.status, 409);
  assertEquals((await rejectedRes.json()).error, "reconnect_required");
});

Deno.test("parseStrictBenchmarkBudgetDecision fails closed on malformed or over-ceiling payloads", () => {
  assertEquals(parseStrictBenchmarkBudgetDecision({ allowed: true, count: 3, retry_after: 0 }, 1), {
    allowed: true,
    count: 3,
    retryAfterSeconds: 0,
  });
  assertEquals(parseStrictBenchmarkBudgetDecision({ allowed: false, count: 300, retry_after: 60 }, 1), {
    allowed: false,
    count: 300,
    retryAfterSeconds: 60,
  });
  assertEquals(parseStrictBenchmarkBudgetDecision({ allowed: true, count: 301, retry_after: 0 }, 1), null);
  assertEquals(parseStrictBenchmarkBudgetDecision({ allowed: true, count: 0, retry_after: 0 }, 1), null);
  assertEquals(parseStrictBenchmarkBudgetDecision(null, 1), null);
});
