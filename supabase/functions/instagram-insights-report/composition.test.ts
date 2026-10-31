import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const OWNER_ID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";
const OTHER_OWNER_ID = "6d12e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";
const ACCOUNT_ID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
const OTHER_ACCOUNT_ID = "b1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
const SERVICE_KEY = "report-composition-test-service-key";
const URL_BASE = "http://127.0.0.1:9";

Deno.env.set("SUPABASE_URL", URL_BASE);
Deno.env.set("SUPABASE_ANON_KEY", "report-composition-test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);

const { handler } = await import("./index.ts");

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function userToken(): Promise<string> {
  const encode = (payload: unknown) => base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: OWNER_ID,
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("report-composition-test-signing-key"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

function reportRequest(token: string, body: Record<string, unknown>): Request {
  return new Request(`${URL_BASE}/functions/v1/instagram-insights-report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ period_days: 30, social_account_id: ACCOUNT_ID, ...body }),
  });
}

// Regression for the production service-role 401: only the Auth/PostgREST HTTP
// boundary is replaced. Authentication, ownership queries and assembly are real.
Deno.test("report composition preserves authenticated identity and account ownership", async (test) => {
  const jwt = await userToken();
  const accounts = [
    { id: ACCOUNT_ID, user_id: OWNER_ID, platform: "instagram", is_active: true },
    { id: OTHER_ACCOUNT_ID, user_id: OTHER_OWNER_ID, platform: "instagram", is_active: true },
  ];
  const originalFetch = globalThis.fetch;
  let databaseReads = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== URL_BASE) throw new Error("Unexpected external request in report composition test");
    if (url.pathname === "/auth/v1/user") {
      assertEquals(request.headers.get("Authorization"), `Bearer ${jwt}`);
      return Response.json({ id: OWNER_ID, role: "authenticated", aud: "authenticated" });
    }
    if (url.pathname === "/rest/v1/social_accounts") {
      databaseReads++;
      const matches = accounts.filter((account) =>
        Object.entries(account).every(([column, value]) => {
          const filter = url.searchParams.get(column);
          return filter === null || filter === `eq.${value}`;
        })
      );
      return Response.json(matches);
    }
    if (url.pathname === "/rest/v1/rpc/read_instagram_collection_job_status") return Response.json(null);
    if ([
      "/rest/v1/ig_media_insight_snapshots",
      "/rest/v1/ig_account_insight_daily",
      "/rest/v1/ig_account_profile_observations",
    ].includes(url.pathname)) {
      databaseReads++;
      return Response.json([]);
    }
    throw new Error(`Unexpected report HTTP boundary: ${url.pathname}`);
  };

  try {
    await test.step("service role can load the specified owner's account", async () => {
      const response = await handler(reportRequest(SERVICE_KEY, { user_id: OWNER_ID }));
      assertEquals(response.status, 200);
      const report = await response.json();
      assertEquals(report.scope.ownerId, OWNER_ID);
      assertEquals(report.scope.socialAccountId, ACCOUNT_ID);
    });

    await test.step("service role gets the same non-enumerating 404 for a foreign account", async () => {
      const response = await handler(reportRequest(SERVICE_KEY, {
        user_id: OWNER_ID, social_account_id: OTHER_ACCOUNT_ID,
      }));
      assertEquals(response.status, 404);
      assertEquals((await response.json()).error.code, "ACCOUNT_NOT_FOUND");
    });

    await test.step("user JWT identity wins over a different body user_id", async () => {
      const response = await handler(reportRequest(jwt, { user_id: OTHER_OWNER_ID }));
      assertEquals(response.status, 200);
      assertEquals((await response.json()).scope.ownerId, OWNER_ID);
    });

    for (const body of [{}, { user_id: "not-a-uuid" }]) {
      await test.step(`service role rejects ${"user_id" in body ? "invalid" : "missing"} user_id before reads`, async () => {
        databaseReads = 0;
        const response = await handler(reportRequest(SERVICE_KEY, body));
        assertEquals(response.status, 401);
        assertEquals((await response.json()).error.code, "UNAUTHORIZED");
        assertEquals(databaseReads, 0);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
