// The production route (`index.ts`), not the handler in isolation: a Stage 4
// handler that is built but never wired, or a refusal the route answers
// before the audit path, passes every handler-level test and fails here.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const USER = "11111111-1111-4111-8111-111111111111";

type ServeFn = (req: Request, inject?: { supabase?: unknown; fetcher?: typeof fetch }) => Promise<Response>;

async function loadRoute(): Promise<ServeFn> {
  Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "route-test-service-key-never-used-by-a-caller");
  // index.ts registers itself with Deno.serve on import; capture instead of listening.
  const nativeServe = Deno.serve;
  Deno.serve = (() => ({ finished: Promise.resolve(), shutdown: () => Promise.resolve() })) as unknown as typeof Deno.serve;
  try {
    const mod = await import("../index.ts") as { serveCommentManager: ServeFn };
    return mod.serveCommentManager;
  } finally {
    Deno.serve = nativeServe;
  }
}

function fakeSupabase() {
  const auditRows: Array<Record<string, unknown>> = [];
  const supabase = {
    auth: {
      getUser: (token: string) => Promise.resolve(
        token === "good-token"
          ? { data: { user: { id: USER } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
      ),
    },
    from(table: string) {
      if (table === "system_logs") {
        return { insert: (row: Record<string, unknown>) => { auditRows.push(row); return Promise.resolve({ error: null }); } };
      }
      if (table === "social_accounts") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return builder;
      }
      throw new Error(`route test: unexpected table ${table}`);
    },
    rpc: (fn: string) => Promise.resolve(
      fn === "check_rate_limit" ? { data: { allowed: true }, error: null } : { data: null, error: { message: `unexpected rpc ${fn}` } },
    ),
  };
  return { supabase, auditRows };
}

function post(body: unknown, token?: string): Request {
  return new Request("http://localhost/functions/v1/comment-manager", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

Deno.test("an unauthenticated Stage 4 call is refused AND audited at the real route, with no identifiers", async () => {
  const serve = await loadRoute();
  const { supabase, auditRows } = fakeSupabase();
  const body = { action: "youtube_reply", social_account_id: "77777777-7777-4777-8777-777777777777", target_handle: "h", text: "secret text", operation_id: crypto.randomUUID() };

  for (const request of [post(body), post(body, "bad-token")]) {
    const res = await serve(request, { supabase });
    assertEquals(res.status, 401);
    assertEquals((await res.json()).reason, "unauthorized");
  }
  await settle();
  assertEquals(auditRows.length, 2, "both refusals reached the audit path");
  for (const row of auditRows) {
    assertEquals(row.user_id, null, "an unidentified caller carries no user id");
    const metadata = row.metadata as Record<string, unknown>;
    assertEquals(Object.keys(metadata).sort(), ["action", "provider_class", "reason", "request_id"]);
    assertEquals(JSON.stringify(row).includes("secret text"), false);
    assertEquals(JSON.stringify(row).includes("77777777"), false, "an unverified account id is never logged");
  }
});

Deno.test("an unauthenticated LEGACY call keeps its exact legacy 401 and is not audited as Stage 4", async () => {
  const serve = await loadRoute();
  const { supabase, auditRows } = fakeSupabase();
  const res = await serve(post({ action: "get_youtube_comments", social_account_id: "x" }, "bad-token"), { supabase });
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "Unauthorized" });
  const noHeader = await serve(post({ action: "get_youtube_comments" }), { supabase });
  assertEquals(noHeader.status, 401);
  assertEquals(await noHeader.json(), { error: "No authorization header" });
  await settle();
  assertEquals(auditRows.length, 0);
});

Deno.test("an authenticated Stage 4 call reaches the handler through the route (wiring)", async () => {
  const serve = await loadRoute();
  const { supabase, auditRows } = fakeSupabase();
  const res = await serve(
    post({ action: "youtube_stage4_capabilities", social_account_id: "77777777-7777-4777-8777-777777777777" }, "good-token"),
    { supabase },
  );
  // The handler answered (not the legacy switch): its refusal shape, identified user, audited.
  assertEquals(res.status, 404);
  assertEquals((await res.json()).reason, "not_found");
  await settle();
  assertEquals(auditRows.length, 1);
  assertEquals(auditRows[0].user_id, USER);
  assertEquals((auditRows[0].metadata as Record<string, unknown>).account_id, undefined, "the unverified account id is not logged");
});

Deno.test("an unparseable body at the route is an audited invalid_request, not a legacy error", async () => {
  const serve = await loadRoute();
  const { supabase, auditRows } = fakeSupabase();
  const res = await serve(post("{not json", "good-token"), { supabase });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).reason, "invalid_request");
  await settle();
  assertEquals(auditRows.length, 1);
  assertEquals(auditRows[0].user_id, USER);
});
