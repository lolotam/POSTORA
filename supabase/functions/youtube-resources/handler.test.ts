import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createYouTubeResourcesHandler,
  type YouTubeResourceAccount,
  type YouTubeResourceRefusal,
  type YouTubeResourcesPorts,
} from "./handler.ts";
import { YOUTUBE_SCOPE } from "./contracts.ts";

const ENDPOINT = "https://api.postora.cloud/functions/v1/youtube-resources";
const USER_ID = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const FOREIGN_ACCOUNT_ID = "0ee20002-0000-4000-8000-000000000022";
const REQUEST_ID = "0ee90001-0000-4000-8000-000000000091";
const CHANNEL_ID = "UCfixturechannel000000001";

function request(body: unknown, method = "POST"): Request {
  return new Request(ENDPOINT, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function rawRequest(body: string): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function fixture(overrides: {
  authenticated?: boolean;
  authUserId?: unknown;
  account?: Partial<YouTubeResourceAccount>;
  loadError?: boolean;
  slowLog?: boolean;
} = {}) {
  const accessToken = crypto.randomUUID() + crypto.randomUUID();
  const refreshToken = crypto.randomUUID() + crypto.randomUUID();
  const calls = { auth: 0, load: 0 };
  const logs: YouTubeResourceRefusal[] = [];
  let minted = 0;
  const account: YouTubeResourceAccount = {
    id: ACCOUNT_ID,
    userId: USER_ID,
    channelId: CHANNEL_ID,
    channelTitle: "Fixture channel",
    authProvider: null,
    needsReauth: false,
    accessToken,
    refreshToken,
    tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    accountMetadata: {
      granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload, YOUTUBE_SCOPE.force_ssl],
    },
    ...overrides.account,
  };
  const ports: YouTubeResourcesPorts = {
    auth: {
      authenticate: () => {
        calls.auth++;
        if (overrides.authenticated === false) return Promise.reject(new Error("unauthorized"));
        if ("authUserId" in overrides) {
          return Promise.resolve({ userId: overrides.authUserId as string });
        }
        return Promise.resolve({ userId: USER_ID });
      },
    },
    accounts: {
      load: ({ accountId, userId }) => {
        calls.load++;
        if (overrides.loadError) return Promise.reject(new Error("account_read_failed"));
        return Promise.resolve(accountId === ACCOUNT_ID && userId === USER_ID ? account : null);
      },
    },
    clock: { now: () => new Date("2026-11-20T10:00:00.000Z") },
    ids: {
      requestId: () => {
        minted++;
        return minted === 1 ? REQUEST_ID : `${REQUEST_ID}-${minted}`;
      },
    },
    log: {
      refusal: (entry) => {
        if (overrides.slowLog) {
          return new Promise<void>((resolve) =>
            setTimeout(() => {
              logs.push(entry);
              resolve();
            }, 0)
          );
        }
        logs.push(entry);
        return Promise.resolve();
      },
    },
  };
  return { handler: createYouTubeResourcesHandler(ports), calls, logs, accessToken, refreshToken };
}

Deno.test("a request without a valid user is refused before any account read", async () => {
  const { handler, calls, logs } = fixture({ authenticated: false });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "unauthorized", request_id: REQUEST_ID });
  assertEquals(calls.load, 0);
  assertEquals(logs, []);
});

Deno.test("an authenticate result without a user id is refused as unauthorized before any account read", async () => {
  const { handler, calls, logs } = fixture({ authUserId: undefined as unknown as string });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "unauthorized", request_id: REQUEST_ID });
  assertEquals(calls.load, 0);
  assertEquals(logs, []);
});

Deno.test("an authenticate result with a non-UUID user id is refused as unauthorized before any account read", async () => {
  const { handler, calls, logs } = fixture({ authUserId: "not-a-uuid" });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "unauthorized", request_id: REQUEST_ID });
  assertEquals(calls.load, 0);
  assertEquals(logs, []);
});

Deno.test("a body that names a user is refused by the strict schema", async () => {
  const { handler, calls } = fixture();
  const response = await handler(
    request({ operation: "capabilities", account_id: ACCOUNT_ID, user_id: USER_ID }),
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "invalid_request");
  assertEquals(calls.load, 0);
});

Deno.test("another owner's account and an unknown account get the same answer", async () => {
  const { handler } = fixture();
  const foreign = await handler(request({ operation: "capabilities", account_id: FOREIGN_ACCOUNT_ID }));
  const unknown = await handler(
    request({ operation: "capabilities", account_id: "0ee20009-0000-4000-8000-000000000029" }),
  );
  assertEquals(foreign.status, 404);
  assertEquals(unknown.status, 404);
  const { request_id: foreignId, ...foreignRest } = await foreign.json();
  const { request_id: unknownId, ...unknownRest } = await unknown.json();
  assertEquals(foreignId !== unknownId, true);
  assertEquals(foreignRest, unknownRest);
  assertEquals(foreignRest, { error: "not_found" });
});

Deno.test("capabilities answers from the database and never returns a credential", async () => {
  const { handler, accessToken, refreshToken } = fixture();
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 200);
  const text = await response.text();
  assertEquals(text.includes(accessToken), false);
  assertEquals(text.includes(refreshToken), false);
  const body = JSON.parse(text);
  assertEquals(body.schema_version, 1);
  assertEquals(body.request_id, REQUEST_ID);
  assertEquals(body.freshness, { fetched_at: "2026-11-20T10:00:00.000Z", source: "database" });
  assertEquals(body.data.account_id, ACCOUNT_ID);
  assertEquals(body.data.capabilities.browse, { state: "available" });
});

Deno.test("a failed account read is an internal error, not a not_found", async () => {
  const { handler, logs } = fixture({ loadError: true });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 500);
  assertEquals((await response.json()).error, "internal_error");
  assertEquals(logs.map((entry) => entry.code), ["internal_error"]);
});

Deno.test("only POST is served", async () => {
  const { handler, calls } = fixture();
  const response = await handler(request(null, "GET"));
  assertEquals(response.status, 405);
  assertEquals(calls.auth, 0);
});

Deno.test("a method refusal writes no log row", async () => {
  const { handler, logs } = fixture();
  const response = await handler(request(null, "GET"));
  assertEquals(response.status, 405);
  assertEquals(logs, []);
});

Deno.test("a refusal row lands before the response promise resolves", async () => {
  const { handler, logs } = fixture({ slowLog: true });
  const response = await handler(request({ operation: "capabilities", account_id: FOREIGN_ACCOUNT_ID }));
  assertEquals(response.status, 404);
  // The log port resolves on a later macrotask; seeing the row here proves the
  // handler awaited the write instead of firing and forgetting.
  assertEquals(logs.map((entry) => entry.code), ["not_found"]);
});

Deno.test("a not_found refusal writes exactly one row with the code and the request id", async () => {
  const { handler, logs } = fixture();
  const response = await handler(request({ operation: "capabilities", account_id: FOREIGN_ACCOUNT_ID }));
  assertEquals(response.status, 404);
  assertEquals(logs, [{
    operation: "capabilities",
    code: "not_found",
    userId: USER_ID,
    accountId: FOREIGN_ACCOUNT_ID,
    requestId: REQUEST_ID,
  }]);
});

Deno.test("malformed JSON is an invalid_request and is logged", async () => {
  const { handler, logs } = fixture();
  const response = await handler(rawRequest("{not json"));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "invalid_request");
  assertEquals(logs.map((entry) => entry.code), ["invalid_request"]);
});

Deno.test("a preflight is answered with 204 and the restricted CORS headers", async () => {
  const { handler, calls } = fixture();
  const response = await handler(new Request(ENDPOINT, { method: "OPTIONS" }));
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("access-control-allow-origin"), "https://postora.cloud");
  assertEquals(response.headers.get("vary"), "Origin");
  assertEquals(calls.auth, 0);
  assertEquals(calls.load, 0);
});

Deno.test("a composio row answers with browse unsupported and upload unknown", async () => {
  const { handler } = fixture({
    account: {
      authProvider: "composio",
      accessToken: null,
      refreshToken: null,
      accountMetadata: {},
    },
  });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data.provider, "composio");
  assertEquals(body.data.connection, "ok");
  assertEquals(body.data.capabilities.browse, { state: "unavailable", reason: "provider_unsupported" });
  assertEquals(body.data.capabilities.upload, { state: "unknown" });
});
