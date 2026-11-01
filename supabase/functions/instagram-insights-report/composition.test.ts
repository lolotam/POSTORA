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
      "/rest/v1/instagram_collection_jobs",
      "/rest/v1/instagram_collection_job_checkpoints",
    ].includes(url.pathname)) {
      databaseReads++;
      return Response.json([], { headers: { "Content-Range": "*/0" } });
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

    for (const cursor of [
      { published_at: "2026-10-26T12:00:00Z", media_id: "media-1" },
      { publishedAt: "not-a-date", mediaId: "media-1" },
      "null",
    ]) {
      await test.step(`malformed cursor ${JSON.stringify(cursor)} is rejected before database reads`, async () => {
        databaseReads = 0;
        const response = await handler(reportRequest(SERVICE_KEY, { user_id: OWNER_ID, cursor }));
        assertEquals(response.status, 400);
        assertEquals((await response.json()).error.code, "INVALID_CURSOR");
        assertEquals(databaseReads, 0);
      });
    }

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

Deno.test("service-role report reads narrow owner status and retains previous-day success", async () => {
  const originalFetch = globalThis.fetch;
  const jobId = "8e040000-0000-4000-8000-000000000001";
  const previousSuccess = "2026-10-28T12:00:00Z";
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== URL_BASE) throw new Error("Unexpected external report request");
    if (url.pathname === "/rest/v1/social_accounts") {
      return Response.json([{ id: ACCOUNT_ID, user_id: OWNER_ID, platform: "instagram", is_active: true }]);
    }
    assertEquals(url.searchParams.get("user_id"), `eq.${OWNER_ID}`);
    if (url.pathname === "/rest/v1/instagram_collection_jobs") {
      assertEquals(url.searchParams.get("social_account_id"), `eq.${ACCOUNT_ID}`);
      assertEquals(url.searchParams.get("target_id"), `eq.${ACCOUNT_ID}`);
      assertEquals(url.searchParams.get("target_kind"), "eq.owner");
      assertEquals(/lease|token|context/.test(url.searchParams.get("select") ?? ""), false);
      const successQuery = url.searchParams.get("order")?.startsWith("last_success_at");
      return Response.json([{
        id: jobId, job_generation: 2, status: "queued", captured_on: "2026-10-29",
        last_attempt_at: "2026-10-29T12:00:00Z", last_success_at: successQuery ? previousSuccess : null,
        last_partial_at: null, retry_at: null, last_reason_code: null,
      }]);
    }
    if (url.pathname === "/rest/v1/instagram_collection_job_checkpoints") {
      assertEquals(url.searchParams.get("job_id"), `eq.${jobId}`);
      assertEquals(url.searchParams.get("job_generation"), "eq.2");
      return Response.json([{ inventory_truncated: false, inventory_partial: false, inventory_window_covered: false }]);
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) throw new Error("Report must not call an authenticated-only RPC with service role");
    return Response.json([], { headers: { "Content-Range": "*/0" } });
  };
  try {
    const response = await handler(reportRequest(SERVICE_KEY, { user_id: OWNER_ID }));
    assertEquals(response.status, 200);
    const report = await response.json();
    assertEquals(Date.parse(report.freshness.lastSuccessAt), Date.parse(previousSuccess));
    assertEquals(report.freshness.lastAttemptAt, "2026-10-29T12:00:00.000Z");
    assertEquals(JSON.stringify(report).includes("lease_token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("report composition pages the full stored inventory without treating database caps as end-of-list", async (test) => {
  const originalFetch = globalThis.fetch;
  const timestamp = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const snapshots = Array.from({ length: 522 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    user_id: OWNER_ID, social_account_id: ACCOUNT_ID, ig_media_id: `media-${Math.floor(index / 2)}`,
    published_at: timestamp, captured_at: timestamp, captured_on: timestamp.slice(0, 10),
    capture_timezone: "UTC", media_product_type: "REELS", media_type: "VIDEO", status: "ok", views: 10,
  }));
  let mode: "ok" | "overflow" | "database_error" | "status_error" | "repeated_page" = "ok";
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== URL_BASE) throw new Error("Unexpected external report request");
    if (url.pathname === "/rest/v1/social_accounts") {
      return Response.json([{ id: ACCOUNT_ID, user_id: OWNER_ID, platform: "instagram", is_active: true }]);
    }
    assertEquals(url.searchParams.get("user_id"), `eq.${OWNER_ID}`);
    if (url.pathname === "/rest/v1/instagram_collection_jobs") {
      assertEquals(url.searchParams.get("target_kind"), "eq.owner");
      assertEquals(url.searchParams.get("target_id"), `eq.${ACCOUNT_ID}`);
      return mode === "status_error"
        ? Response.json({ message: "status unavailable" }, { status: 500 }) : Response.json([]);
    }
    assertEquals(url.searchParams.get("social_account_id"), `eq.${ACCOUNT_ID}`);
    if (url.pathname === "/rest/v1/ig_media_insight_snapshots") {
      if (mode === "database_error") return Response.json({ message: "read failed" }, { status: 500 });
      const afterId = url.searchParams.get("id")?.slice(3) ?? "";
      const matching = snapshots.filter((row) => row.id > afterId);
      const page = (mode === "repeated_page" ? snapshots : matching).slice(0, 37);
      // Model a PostgREST max-rows setting smaller than the requested page size.
      return Response.json(page, {
        headers: { "Content-Range": `0-${page.length - 1}/${mode === "overflow" ? 20_001 : matching.length}` },
      });
    }
    return Response.json([], { headers: { "Content-Range": "*/0" } });
  };
  try {
    await test.step("all 261 distinct media remain reachable after duplicate captures and database pagination", async () => {
      const ids = new Set<string>();
      let cursor: unknown = null;
      for (let page = 0; page < 3; page++) {
        const response = await handler(reportRequest(SERVICE_KEY, { user_id: OWNER_ID, limit: 100, cursor }));
        assertEquals(response.status, 200);
        const report = await response.json();
        for (const media of report.media.page.items) ids.add(media.mediaId);
        cursor = report.media.page.nextCursor;
        assertEquals(report.media.page.hasMore, page < 2);
      }
      assertEquals(ids.size, 261);
      assertEquals(cursor, null);
    });
    for (const failure of ["overflow", "repeated_page", "database_error", "status_error"] as const) {
      await test.step(`${failure} never returns a successful empty or truncated report`, async () => {
        mode = failure;
        const response = await handler(reportRequest(SERVICE_KEY, { user_id: OWNER_ID }));
        assertEquals(response.status, failure === "overflow" || failure === "repeated_page" ? 503 : 500);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
