import { assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";

const API_URL = "http://127.0.0.1:9";
const SERVICE_KEY = "threads-selection-test-service-key";
const OWNER_ID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";
const OTHER_OWNER_ID = "6d12e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";
const ACCOUNT_ID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
const FOREIGN_ID = "b1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
const INACTIVE_ID = "c1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
const MISSING_ID = "d1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
const WRONG_PLATFORM_ID = "e1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";

Deno.env.set("SUPABASE_URL", API_URL);
Deno.env.set("SUPABASE_ANON_KEY", "threads-selection-test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
const { handler } = await import("./index.ts");

function request(body: Record<string, unknown>, token = SERVICE_KEY): Request {
  return new Request(`${API_URL}/functions/v1/threads-insights`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: OWNER_ID, ...body }),
  });
}

async function userToken(): Promise<string> {
  const encode = (payload: unknown) => btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: OWNER_ID, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("threads-selection-signing-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

// The actual Auth helper, Supabase query and registered composition run unchanged;
// only HTTP to Auth/PostgREST/Meta is replaced. A fallback account is deliberately present.
Deno.test("Threads selection never substitutes an account after refusal or failed storage", async (test) => {
  const originalFetch = globalThis.fetch;
  let failAccountRead = false;
  let noAccounts = false;
  let providerCalls = 0;
  let accountReads = 0;
  let scenario = "normal";
  let profileRequests = 0;
  let recognizedServerFailure: { code: number; error_subcode: number } | null = null;
  const audits: Record<string, unknown>[] = [];
  const jwt = await userToken();
  const accounts = [
    { id: "f1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d", user_id: OWNER_ID, platform: "threads", is_active: true, access_token: "synthetic-owner-token", platform_user_id: "thread-older", platform_username: "older", connected_at: "2026-10-01T00:00:00Z" },
    { id: ACCOUNT_ID, user_id: OWNER_ID, platform: "threads", is_active: true, access_token: "synthetic-owner-token", platform_user_id: "thread-owner", platform_username: "owner", connected_at: "2026-11-01T00:00:00Z" },
    { id: FOREIGN_ID, user_id: OTHER_OWNER_ID, platform: "threads", is_active: true, access_token: "synthetic-foreign-token" },
    { id: INACTIVE_ID, user_id: OWNER_ID, platform: "threads", is_active: false, access_token: "synthetic-inactive-token" },
    { id: WRONG_PLATFORM_ID, user_id: OWNER_ID, platform: "facebook", is_active: true, access_token: "synthetic-facebook-token" },
  ];
  globalThis.fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    const url = new URL(outgoing.url);
    if (url.origin === API_URL) {
      if (url.pathname === "/auth/v1/user") {
        assertEquals(outgoing.headers.get("Authorization"), `Bearer ${jwt}`);
        return Response.json({ id: OWNER_ID, role: "authenticated", aud: "authenticated" });
      }
      if (url.pathname === "/rest/v1/social_accounts") {
        accountReads++;
        if (failAccountRead) return Response.json({ code: "57014", message: "private database detail" }, { status: 500 });
        const selected = noAccounts ? [] : accounts.filter((account) => Object.entries(account).every(([column, value]) => {
          const filter = url.searchParams.get(column);
          return filter === null || filter === `eq.${value}`;
        }));
        if (url.searchParams.get("order")?.startsWith("connected_at.desc")) {
          selected.sort((left, right) => (right.connected_at ?? "").localeCompare(left.connected_at ?? ""));
        }
        return Response.json(selected.slice(0, 1));
      }
      if (url.pathname === "/rest/v1/system_logs") {
        audits.push(await outgoing.json());
        return new Response(null, { status: 201 });
      }
      if (["/rest/v1/profiles", "/rest/v1/user_subscriptions", "/rest/v1/user_roles"].includes(url.pathname)) return Response.json(null);
    }
    if (url.origin === "https://graph.threads.net") {
      providerCalls++;
      if (url.pathname.endsWith("/me")) return Response.json({ id: scenario === "identity_mismatch" ? "different-owner" : "thread-owner", username: "owner" });
      if (url.pathname.endsWith("/threads_insights")) {
        profileRequests++;
        if (recognizedServerFailure) return Response.json({ error: { ...recognizedServerFailure, message: "synthetic-owner-token" } }, { status: 503 });
        if (scenario.startsWith("throttle_")) {
          if (profileRequests === 1 && scenario === "throttle_failure") return Response.json({ error: { code: 2 } }, { status: 503 });
          if (profileRequests > 1) return Response.json({ error: { code: 4 } }, { status: 429, headers: { "Retry-After": profileRequests === 2 ? "180" : "15" } });
        }
        if (scenario === "invalid_current" && profileRequests === 1) return new Response("private malformed response");
        if (scenario === "failed_previous" && profileRequests === 2) return Response.json({ error: { code: 2, message: "private-provider-detail" } }, { status: 503 });
      }
      if (scenario === "invalid_post_time" && url.pathname.endsWith("/threads")) return Response.json({ data: [{ id: "post1", timestamp: "2026-02-30T12:00:00Z" }] });
      if (scenario === "failed_post") {
        if (url.pathname.endsWith("/threads")) return Response.json({ data: [
          { id: "post1", text: "first", timestamp: new Date().toISOString() },
          { id: "post2", text: "second", timestamp: new Date().toISOString() },
        ] });
        if (url.pathname.includes("/post1/")) return Response.json({ data: [{ name: "views", total_value: { value: 5 } }] });
        if (url.pathname.includes("/post2/")) return Response.json({ error: { code: 10, message: "synthetic-owner-token" } }, { status: 403 });
      }
      return Response.json({ data: [] });
    }
    throw new Error(`Unexpected boundary: ${url.origin}${url.pathname}`);
  };
  try {
    for (const accountId of [MISSING_ID, FOREIGN_ID, INACTIVE_ID, WRONG_PLATFORM_ID]) {
      await test.step(`explicit unavailable account ${accountId} is non-enumerating`, async () => {
        providerCalls = 0;
        accountReads = 0;
        const response = await handler(request({ accountId }));
        assertEquals(response.status, 404);
        assertEquals(await response.json(), { ok: false, reason: "account_not_found", message: "Threads account not found." });
        assertEquals(providerCalls, 0);
        assertEquals(accountReads, 1);
        assertEquals(audits.at(-1)?.metadata && (audits.at(-1)!.metadata as Record<string, unknown>).event, "account_not_found");
      });
    }
    for (const body of [{ accountId: ACCOUNT_ID }, {}]) {
      await test.step(`failed account read ${JSON.stringify(body)} stays a storage failure`, async () => {
        failAccountRead = true;
        providerCalls = 0;
        accountReads = 0;
        const response = await handler(request(body));
        failAccountRead = false;
        assertEquals(response.status, 503);
        assertEquals((await response.json()).reason, "storage_error");
        assertEquals(providerCalls, 0);
        assertEquals(accountReads, 1);
        assertFalse(JSON.stringify(audits.at(-1)).includes("private database detail"));
      });
    }
    for (const rawBody of ["{", "null", "[]"]) {
      await test.step(`malformed selector body ${rawBody} is rejected`, async () => {
        accountReads = 0;
        providerCalls = 0;
        const response = await handler(new Request(`${API_URL}/functions/v1/threads-insights`, {
          method: "POST", headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }, body: rawBody,
        }));
        assertEquals(response.status, 400);
        assertEquals(accountReads, 0);
        assertEquals(providerCalls, 0);
      });
    }
    await test.step("user JWT identity wins over another body owner", async () => {
      const owned = await handler(request({ user_id: OTHER_OWNER_ID, accountId: ACCOUNT_ID }, jwt));
      assertEquals((await owned.json()).ok, true);
      providerCalls = 0;
      const foreign = await handler(request({ user_id: OTHER_OWNER_ID, accountId: FOREIGN_ID }, jwt));
      assertEquals(foreign.status, 404);
      assertEquals(providerCalls, 0);
    });
    for (const accountId of ["", "not-a-uuid", null, 5]) {
      await test.step(`invalid explicit selector ${JSON.stringify(accountId)} is not omitted`, async () => {
        accountReads = 0;
        providerCalls = 0;
        const response = await handler(request({ accountId }));
        assertEquals(response.status, 400);
        assertEquals((await response.json()).reason, "invalid_request");
        assertEquals(accountReads, 0);
        assertEquals(providerCalls, 0);
      });
    }
    for (const body of [{ accountID: ACCOUNT_ID }, { account_id: ACCOUNT_ID }, { user_id: undefined }]) {
      await test.step(`unknown selector or missing service identity ${JSON.stringify(body)} is refused`, async () => {
        accountReads = 0;
        providerCalls = 0;
        const response = await handler(request(body));
        assertEquals(response.status, "user_id" in body ? 401 : 400);
        assertEquals(accountReads, 0);
        assertEquals(providerCalls, 0);
      });
    }
    await test.step("an owned selection retains the legacy success shape", async () => {
      const response = await handler(request({ accountId: ACCOUNT_ID, periodDays: 14 }));
      const payload = await response.json();
      assertEquals(response.status, 200);
      assertEquals(payload.ok, true);
      assertEquals(payload.periodDays, 14);
      assertEquals(payload.threadsUserId, "thread-owner");
      assertEquals(payload.posts, []);
      assertFalse(JSON.stringify(audits).includes("synthetic-owner-token"));
    });
    await test.step("an omitted selector retains latest-account compatibility", async () => {
      const response = await handler(request({}));
      const payload = await response.json();
      assertEquals(payload.ok, true);
      assertEquals(payload.username, "owner");
    });
    await test.step("an omitted selector with no account retains the connection prompt", async () => {
      noAccounts = true;
      providerCalls = 0;
      const response = await handler(request({}));
      assertEquals(response.status, 200);
      assertEquals((await response.json()).reason, "no_account");
      assertEquals(providerCalls, 0);
    });
    noAccounts = false;
    for (const [code, subcode, reason, needsReauth, needsPermission] of [
      [190, 463, "expired_token", true, false], [190, 0, "invalid_token", true, false],
      [10, 0, "missing_scope", false, true], [200, 0, "missing_scope", false, true],
    ] as const) {
      await test.step(`legacy response preserves reconnect/permission guidance for 503/${code}/${subcode}`, async () => {
        recognizedServerFailure = { code, error_subcode: subcode };
        try {
          const response = await handler(request({ accountId: ACCOUNT_ID }));
          const payload = await response.json();
          assertEquals(response.status, 200);
          assertEquals(payload.ok, false);
          assertEquals(payload.reason, reason);
          assertEquals(payload.needsReauth, needsReauth);
          assertEquals(payload.needsPermission, needsPermission);
          assertFalse(JSON.stringify(payload).includes("synthetic-owner-token"));
        } finally { recognizedServerFailure = null; }
      });
    }
    for (const mode of ["identity_mismatch", "invalid_current", "failed_previous", "failed_post", "invalid_post_time", "throttle_failure", "throttle_success"]) {
      await test.step(`real provider composition handles ${mode} without replacing identity or exposing raw failures`, async () => {
        scenario = mode;
        profileRequests = 0;
        providerCalls = 0;
        const response = await handler(request({ accountId: ACCOUNT_ID }));
        const payload = await response.json();
        if (mode === "identity_mismatch") {
          assertEquals(payload.ok, false);
          assertEquals(payload.reason, "wrong_account");
          assertEquals(providerCalls, 1);
        } else if (mode === "invalid_current") {
          assertEquals(payload.ok, false);
          assertEquals(payload.needsReauth, false);
        } else if (mode === "throttle_failure") {
          assertEquals(payload.ok, false);
          assertEquals(payload.reason, "transient");
        } else {
          assertEquals(payload.ok, true);
          assertEquals(payload.partial, true);
          if (mode === "failed_post") {
            assertEquals(payload.posts.map((post: { id: string }) => post.id), ["post1", "post2"]);
            assertEquals(payload.posts[0].metrics.views, 5);
          }
        }
        if (mode.startsWith("throttle_")) {
          const delay = Date.parse(payload.retryAt) - Date.now();
          assertEquals(delay > 170_000 && delay <= 180_000, true);
          assertEquals(providerCalls, 4);
        }
        if (mode === "invalid_post_time") assertEquals(payload.posts, []);
        assertFalse(JSON.stringify(payload).includes("private"));
        assertFalse(JSON.stringify(payload).includes("synthetic-owner-token"));
        assertFalse(JSON.stringify(audits).includes("synthetic-owner-token"));
        scenario = "normal";
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
