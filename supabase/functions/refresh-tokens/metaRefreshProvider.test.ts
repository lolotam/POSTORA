import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createOperationBudget } from "../_shared/metaOAuthProtectedBoundary.ts";
import {
  classifyProviderFailure,
  createMetaRefreshTransport,
  DIRECT_REFRESH_ENDPOINT,
  parseDirectRefreshSuccess,
  parseProfileEmailRead,
  type MetaRefreshTransportOptions,
} from "./metaRefreshProvider.ts";

const CAPTURED_TOKEN = "captured-direct-token-value";
const REQUEST_START = Date.parse("2026-10-28T12:13:38.574Z");

function budget(totalMs = 24_000) {
  return createOperationBudget(totalMs, () => REQUEST_START);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transportWith(
  fetcher: typeof fetch,
  options: Partial<MetaRefreshTransportOptions> = {},
) {
  return createMetaRefreshTransport({
    fetcher,
    now: () => REQUEST_START,
    supabaseUrl: "https://api.postora.invalid",
    serviceRoleKey: "service-role-key-value",
    ...options,
  });
}

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const originalError = console.error;
  const originalLog = console.log;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  console.log = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The success shape
// ---------------------------------------------------------------------------

Deno.test("a refreshed token keeps the lifetime the provider returned", () => {
  const parsed = parseDirectRefreshSuccess(
    { access_token: "fresh-token", token_type: "bearer", expires_in: 5_184_000 },
    REQUEST_START,
  );
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  assertEquals(parsed.accessToken, "fresh-token");
  assertEquals(parsed.tokenExpiresAt, "2026-12-27T12:13:38.574Z");
  assertEquals(parsed.refreshToken, null);
});

Deno.test("the expiry is anchored at the request start, not at the response", () => {
  const slowResponse = parseDirectRefreshSuccess(
    { access_token: "fresh-token", token_type: "bearer", expires_in: 3_600 },
    REQUEST_START,
  );
  assertEquals(slowResponse.ok, true);
  if (!slowResponse.ok) return;
  // The request started at REQUEST_START. A response that arrives ten
  // seconds later must not shorten the lifetime.
  assertEquals(slowResponse.tokenExpiresAt, "2026-10-28T13:13:38.574Z");
});

Deno.test("a malformed success is refused instead of defaulted", () => {
  const bodies: unknown[] = [
    null,
    "not-an-object",
    {},
    { access_token: "" },
    { access_token: 12345 },
    { access_token: "t".repeat(4097) },
    { access_token: "fresh-token" },
    { access_token: "fresh-token", token_type: "mac" },
    { access_token: "fresh-token", token_type: null },
    { access_token: "fresh-token", token_type: "bearer", expires_in: 0 },
    { access_token: "fresh-token", token_type: "bearer", expires_in: -60 },
    { access_token: "fresh-token", token_type: "bearer", expires_in: 1.5 },
    { access_token: "fresh-token", token_type: "bearer", expires_in: "3600" },
    { access_token: "fresh-token", token_type: "bearer", expires_in: 1e300 },
    { access_token: "fresh-token", token_type: "bearer", expires_in: 315_360_001 },
    { access_token: "fresh-token", token_type: "bearer", expires_in: 3_600, error: { code: 190 } },
  ];
  for (const body of bodies) {
    assertEquals(parseDirectRefreshSuccess(body, REQUEST_START).ok, false);
  }
});

Deno.test("an explicit refresh token is kept and a missing one is preserved", () => {
  const withToken = parseDirectRefreshSuccess(
    {
      access_token: "fresh-token",
      token_type: "bearer",
      expires_in: 3_600,
      refresh_token: "provider-refresh",
    },
    REQUEST_START,
  );
  assertEquals(withToken.ok, true);
  if (!withToken.ok) return;
  assertEquals(withToken.refreshToken, "provider-refresh");

  const withoutToken = parseDirectRefreshSuccess(
    { access_token: "fresh-token", token_type: "bearer", expires_in: 3_600 },
    REQUEST_START,
  );
  assertEquals(withoutToken.ok, true);
  if (!withoutToken.ok) return;
  assertEquals(withoutToken.refreshToken, null);
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

Deno.test("a structured permanent error outranks the http status", () => {
  assertEquals(
    classifyProviderFailure({
      status: 500,
      body: { error: { type: "OAuthException", code: 190, message: "expired" } },
    }).category,
    "provider_invalid_grant",
  );
  assertEquals(
    classifyProviderFailure({
      status: 400,
      body: { error: { type: "OAuthException", code: 190, error_subcode: 463 } },
    }).category,
    "provider_invalid_grant",
  );
  assertEquals(
    classifyProviderFailure({
      status: 500,
      body: { error: { type: "OAuthException", code: 190, error_subcode: 458 } },
    }).category,
    "provider_invalid_grant",
  );
});

Deno.test("a rate limit is transient even on a bad request", () => {
  assertEquals(
    classifyProviderFailure({
      status: 400,
      body: { error: { type: "OAuthException", code: 17, message: "too many calls" } },
    }).category,
    "provider_rate_limited",
  );
  assertEquals(
    classifyProviderFailure({ status: 429, body: {} }).category,
    "provider_rate_limited",
  );
  assertEquals(
    classifyProviderFailure({ status: 408, body: {} }).category,
    "provider_transient",
  );
  assertEquals(
    classifyProviderFailure({ status: 503, body: {} }).category,
    "provider_unavailable",
  );
});

Deno.test("a generic permission rejection counts instead of latching", () => {
  assertEquals(
    classifyProviderFailure({
      status: 400,
      body: { error: { type: "OAuthException", code: 200, message: "Permissions error" } },
    }).category,
    "provider_permission_denied",
  );
  assertEquals(
    classifyProviderFailure({
      status: 400,
      body: { error: { type: "OAuthException", code: 1, message: "unknown" } },
    }).category,
    "provider_error",
  );
});

Deno.test("a failure that cannot be attributed is not counted", () => {
  assertEquals(classifyProviderFailure({ status: 400, body: {} }).category, null);
  assertEquals(classifyProviderFailure({ status: 404, body: { data: [] } }).category, null);
  assertEquals(classifyProviderFailure({ status: 302, body: null }).category, null);
});

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

Deno.test("the transport calls the fixed endpoint with the captured token", async () => {
  const urls: string[] = [];
  const transport = transportWith(async (input) => {
    urls.push(typeof input === "string" ? input : (input as Request).url);
    return jsonResponse({
      access_token: "fresh-token",
      token_type: "bearer",
      expires_in: 3_600,
    });
  });

  const outcome = await transport.refreshDirectToken({
    capturedToken: CAPTURED_TOKEN,
    budget: budget(),
  });

  assertEquals(outcome.kind, "success");
  assertEquals(urls.length, 1);
  assertEquals(urls[0].startsWith(`${DIRECT_REFRESH_ENDPOINT}?grant_type=ig_refresh_token&access_token=`), true);
  assertEquals(urls[0].includes(encodeURIComponent(CAPTURED_TOKEN)), true);
});

Deno.test("the transport never logs the token, the url or the provider body", async () => {
  const transport = transportWith(async () =>
    jsonResponse({ error: { type: "OAuthException", code: 190, message: "token rejected" } }, 400)
  );
  const logs = await captureLogs(async () => {
    await transport.refreshDirectToken({
      capturedToken: CAPTURED_TOKEN,
      budget: budget(),
    });
  });
  assertEquals(logs.includes(CAPTURED_TOKEN), false);
  assertEquals(logs.includes("graph.instagram.com"), false);
  assertEquals(logs.includes("token rejected"), false);
});

Deno.test("a malformed successful response is a counted invalid response", async () => {
  const transport = transportWith(async () => jsonResponse({ access_token: "" }));
  const outcome = await transport.refreshDirectToken({
    capturedToken: CAPTURED_TOKEN,
    budget: budget(),
  });
  assertEquals(outcome.kind, "classified_failure");
  if (outcome.kind !== "classified_failure") return;
  assertEquals(outcome.category, "provider_response_invalid");
});

Deno.test("an unclassifiable failure is not attributed to the grant", async () => {
  const transport = transportWith(async () => jsonResponse({ unexpected: true }, 400));
  const outcome = await transport.refreshDirectToken({
    capturedToken: CAPTURED_TOKEN,
    budget: budget(),
  });
  assertEquals(outcome.kind, "unclassified_failure");
});

Deno.test("a timeout is transient", async () => {
  const transport = transportWith(async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  });
  const outcome = await transport.refreshDirectToken({
    capturedToken: CAPTURED_TOKEN,
    budget: budget(),
  });
  assertEquals(outcome.kind, "classified_failure");
  if (outcome.kind !== "classified_failure") return;
  assertEquals(outcome.category, "provider_transient");
});

Deno.test("an exhausted budget sends nothing", async () => {
  let called = 0;
  const transport = transportWith(async () => {
    called += 1;
    return jsonResponse({});
  });
  const outcome = await transport.refreshDirectToken({
    capturedToken: CAPTURED_TOKEN,
    budget: createOperationBudget(0, () => REQUEST_START),
  });
  assertEquals(called, 0);
  assertEquals(outcome.kind, "classified_failure");
  if (outcome.kind !== "classified_failure") return;
  assertEquals(outcome.category, "provider_transient");
});

// ---------------------------------------------------------------------------
// The alert
// ---------------------------------------------------------------------------

Deno.test("the profile email read is strict", () => {
  assertEquals(parseProfileEmailRead({ data: { email: "a@b.invalid" }, error: null }), {
    ok: true,
    email: "a@b.invalid",
  });
  assertEquals(parseProfileEmailRead({ data: null, error: null }), { ok: true, email: null });
  assertEquals(parseProfileEmailRead({ data: { email: null }, error: null }), {
    ok: true,
    email: null,
  });
  assertEquals(parseProfileEmailRead({ data: { email: "" }, error: null }), {
    ok: true,
    email: null,
  });
  assertEquals(parseProfileEmailRead({ data: { id: "x" }, error: null }).ok, false);
  assertEquals(parseProfileEmailRead({ data: { email: "a@b.invalid" } }).ok, false);
  assertEquals(parseProfileEmailRead({ data: { email: "a@b.invalid" }, error: undefined }).ok, false);
  assertEquals(
    parseProfileEmailRead({ data: { email: "a@b.invalid" }, error: { message: "x" } }).ok,
    false,
  );
  assertEquals(parseProfileEmailRead({ data: "row", error: null }).ok, false);
  assertEquals(parseProfileEmailRead(null).ok, false);
});

Deno.test("a confirmed alert is accepted and an unconfirmed one is not", async () => {
  const confirmed = transportWith(async () => jsonResponse({ success: true, userEmailsSent: 1 }), {
    readProfileEmail: async () => ({ data: { id: "owner-1", email: "owner@example.invalid" }, error: null }),
  });
  const accepted = await confirmed.sendFailureAlert({
    accountId: "account-1",
    platform: "instagram",
    username: "ig_direct_1",
    userId: "owner-1",
    errorCategory: "provider_invalid_grant",
    failureCount: 3,
    needsReauth: true,
    budget: budget(),
  });
  assertEquals(accepted.outcome, "accepted");

  // The alert endpoint has HTTP 200 routes without a success flag.
  const unconfirmed = transportWith(async () => jsonResponse({ message: "No admins to notify" }), {
    readProfileEmail: async () => ({ data: { id: "owner-1", email: "owner@example.invalid" }, error: null }),
  });
  const result = await unconfirmed.sendFailureAlert({
    accountId: "account-1",
    platform: "instagram",
    userId: "owner-1",
    errorCategory: "provider_invalid_grant",
    failureCount: 3,
    needsReauth: true,
    budget: budget(),
  });
  assertEquals(result.outcome, "unconfirmed");
});

Deno.test("a failed profile read skips the alert", async () => {
  let called = 0;
  const transport = transportWith(async () => {
    called += 1;
    return jsonResponse({ success: true });
  }, {
    readProfileEmail: async () => ({ data: null, error: { message: "read failed" } }),
  });
  const result = await transport.sendFailureAlert({
    accountId: "account-1",
    platform: "instagram",
    userId: "owner-1",
    errorCategory: "provider_invalid_grant",
    failureCount: 1,
    needsReauth: false,
    budget: budget(),
  });
  assertEquals(result.outcome, "not_attempted");
  assertEquals(called, 0);
});

Deno.test("the alert carries the stable category and never a provider message", async () => {
  let sentBody: unknown = null;
  const transport = transportWith(async (_input, init) => {
    sentBody = JSON.parse(String(init?.body ?? "{}"));
    return jsonResponse({ success: true });
  }, {
    readProfileEmail: async () => ({ data: { id: "owner-1", email: "owner@example.invalid" }, error: null }),
  });

  await transport.sendFailureAlert({
    accountId: "account-1",
    platform: "instagram",
    username: "ig_direct_1",
    userId: "owner-1",
    errorCategory: "provider_invalid_grant",
    failureCount: 3,
    needsReauth: true,
    budget: budget(),
  });

  const failures = (sentBody as { failures: Array<Record<string, unknown>> }).failures;
  assertEquals(failures.length, 1);
  assertEquals(failures[0].errorMessage, "provider_invalid_grant");
  assertEquals(failures[0].failureCount, 3);
  assertEquals(failures[0].needsReauth, true);
  assertEquals(failures[0].userEmail, "owner@example.invalid");
});

Deno.test("an unknown provider error object is not counted evidence", () => {
  const unknown = classifyProviderFailure({
    status: 400,
    body: { error: { type: "Unclassified", code: 777, message: "synthetic-secret" } },
  });
  assertEquals(unknown.category, null);
  assertEquals(JSON.stringify(unknown).includes("synthetic-secret"), false);

  const empty = classifyProviderFailure({
    status: 400,
    body: { error: {} },
  });
  assertEquals(empty.category, null);
});

Deno.test("dirty token material is malformed and an omitted refresh token is preserved", () => {
  for (const access of ["   ", " token ", "bad\u0000token", "bad\u007ftoken"]) {
    assertEquals(
      parseDirectRefreshSuccess(
        { access_token: access, token_type: "bearer", expires_in: 3600 },
        REQUEST_START,
      ).ok,
      false,
    );
  }
  assertEquals(
    parseDirectRefreshSuccess(
      {
        access_token: "fresh-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: { invalid: true },
      },
      REQUEST_START,
    ).ok,
    false,
  );
  assertEquals(
    parseDirectRefreshSuccess(
      {
        access_token: "fresh-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "",
      },
      REQUEST_START,
    ).ok,
    false,
  );
  const explicitNull = parseDirectRefreshSuccess(
    {
      access_token: "fresh-token",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: null,
    },
    REQUEST_START,
  );
  assertEquals(explicitNull.ok, true);
  if (!explicitNull.ok) return;
  assertEquals(explicitNull.refreshToken, null);
  assertEquals(explicitNull.accessToken, "fresh-token");
});

Deno.test("a token that expires before the body is refused without extending it", async () => {
  let now = REQUEST_START;
  const stillValid = createMetaRefreshTransport({
    now: () => now,
    fetcher: async () => {
      now += 200;
      return jsonResponse({ access_token: "valid-token", token_type: "bearer", expires_in: 1 });
    },
  });
  const fresh = await stillValid.refreshDirectToken({
    capturedToken: CAPTURED_TOKEN,
    budget: { take: () => 1000 },
  });
  assertEquals(fresh.kind, "success");
  if (fresh.kind !== "success") return;
  assertEquals(Date.parse(fresh.tokenExpiresAt) > now, true);

  now = REQUEST_START;
  const expired = createMetaRefreshTransport({
    now: () => now,
    fetcher: async () => {
      now += 2000;
      return jsonResponse({ access_token: "valid-token", token_type: "bearer", expires_in: 1 });
    },
  });
  const late = await expired.refreshDirectToken({
    capturedToken: CAPTURED_TOKEN,
    budget: { take: () => 1000 },
  });
  assertEquals(late.kind, "classified_failure");
  if (late.kind !== "classified_failure") return;
  assertEquals(late.category, "provider_response_invalid");
});

Deno.test("an exhausted alert budget never starts the profile read", async () => {
  let profileRead = false;
  const transport = createMetaRefreshTransport({
    supabaseUrl: "https://api.postora.invalid",
    serviceRoleKey: "service-role-key-value",
    readProfileEmail: () => {
      profileRead = true;
      return new Promise(() => {});
    },
  });
  const pending = transport.sendFailureAlert({
    accountId: "account-1",
    platform: "instagram",
    userId: "owner-1",
    errorCategory: "provider_invalid_grant",
    failureCount: 1,
    needsReauth: true,
    budget: {
      take: () => {
        throw new Error("exhausted");
      },
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = await Promise.race([
    pending.then(() => "settled"),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("pending"), 30);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  assertEquals(profileRead, false);
  assertEquals(observed, "settled");
  const result = await pending;
  assertEquals(result.outcome, "not_attempted");
  assertEquals(result.reason, "alert_budget_exhausted");
});

Deno.test("a profile read that outlives the remaining budget does not send", async () => {
  let profileStarted = false;
  let fetched = false;
  const now = 0;
  const transport = createMetaRefreshTransport({
    supabaseUrl: "https://api.postora.invalid",
    serviceRoleKey: "service-role-key-value",
    now: () => now,
    fetcher: async () => {
      fetched = true;
      return jsonResponse({ success: true });
    },
    readProfileEmail: () => {
      profileStarted = true;
      return new Promise(() => {});
    },
  });
  // Settling the wait does not cancel the database query. This port never
  // settles, which is how the test shows the caller stopped anyway.
  const result = await transport.sendFailureAlert({
    accountId: "account-1",
    platform: "instagram",
    userId: "owner-1",
    errorCategory: "provider_invalid_grant",
    failureCount: 1,
    needsReauth: true,
    budget: createOperationBudget(40, () => now),
  });
  assertEquals(profileStarted, true);
  assertEquals(fetched, false);
  assertEquals(result.outcome, "not_attempted");
  assertEquals(result.reason, "alert_profile_deadline");
});

Deno.test("a profile id that is not the owner does not send", async () => {
  let fetched = false;
  const transport = transportWith(async () => {
    fetched = true;
    return jsonResponse({ success: true });
  }, {
    readProfileEmail: async () => ({
      data: { id: "not-the-owner", email: "owner@example.invalid" },
      error: null,
    }),
  });
  const result = await transport.sendFailureAlert({
    accountId: "account-1",
    platform: "instagram",
    userId: "owner-1",
    errorCategory: "provider_invalid_grant",
    failureCount: 1,
    needsReauth: true,
    budget: budget(),
  });
  assertEquals(fetched, false);
  assertEquals(result.outcome, "not_attempted");
  assertEquals(result.reason, "alert_profile_read_failed");
});
