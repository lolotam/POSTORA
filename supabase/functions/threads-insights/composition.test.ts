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
  const audits: Record<string, unknown>[] = [];
  const jwt = await userToken();
  const accounts = [
    { id: ACCOUNT_ID, user_id: OWNER_ID, platform: "threads", is_active: true, access_token: "synthetic-owner-token", platform_user_id: "thread-owner", platform_username: "owner" },
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
      if (url.pathname.endsWith("/me")) return Response.json({ id: "thread-owner", username: "owner" });
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
      assertEquals((await response.json()).ok, true);
    });
    await test.step("an omitted selector with no account retains the connection prompt", async () => {
      noAccounts = true;
      providerCalls = 0;
      const response = await handler(request({}));
      assertEquals(response.status, 200);
      assertEquals((await response.json()).reason, "no_account");
      assertEquals(providerCalls, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
