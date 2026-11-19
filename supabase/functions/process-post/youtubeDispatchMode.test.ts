/**
 * The dispatch modes of process-post, against the REAL registered handler.
 *
 * process-post does one thing per request, and the request says which thing:
 * publish a post, finish a notification, or carry a YouTube upload on. The
 * modes are EXCLUSIVE. A request that carries the identity of one mode while
 * claiming to be another is a routing mistake, and the handler has to refuse
 * it before it reads, claims or sends anything.
 *
 * The identity of a mode is the lease that proves the request is the one the
 * worker was given:
 *
 *   * the notification mode carries an attempt, a candidate and a claim;
 *   * the upload continuation carries an attempt, a session and a claim token;
 *   * the publication mode carries no identity at all.
 *
 * So the attempt alone does not say which mode a request is. A request that
 * carries an attempt and no mode is refused, and a request that carries the
 * upload continuation AND a notification claim is refused.
 *
 * Every refusal here is checked three ways: the response says no, a
 * diagnostic is persisted, and NOTHING was read, claimed or sent. A refusal
 * that still touched the database would not be a refusal.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resumePayload } from "../reconcile-deferred-publishes/run.ts";

const ORIGIN = "https://youtube-dispatch-fixture.invalid";
const SERVICE = "fixture-service";
const POST = "33000000-0000-4000-8000-000000000001";
const SESSION = "66000000-0000-4000-8000-000000000001";
const LEASE = "77000000-0000-4000-8000-000000000001";
const CANDIDATE = "88000000-0000-4000-8000-000000000001";
const CLAIM = "99000000-0000-4000-8000-000000000001";
const ROW = "aa000000-0000-4000-8000-000000000001";
const ATTEMPT = "2026-11-18T00:00:00.000Z";
const USER = "11000000-0000-4000-8000-000000000001";

/**
 * A token an ordinary client would present.
 *
 * It has to be a well formed JWT: the handler asks the auth server to
 * confirm it, and a string that is not a token is refused before the dispatch
 * gate is ever reached.
 */
function userToken(): string {
  const encode = (value: Record<string, unknown>) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ sub: USER, role: "authenticated", exp: 4102444800 }),
    // The signature is not checked here: the auth server confirms the token.
    // Its length still has to be a valid base64url length.
    "fixturesignature",
  ].join(".");
}

const USER_TOKEN = userToken();

type Handler = (request: Request) => Response | Promise<Response>;

/** One call the handler made to the outside world. */
interface Call {
  method: string;
  path: string;
  search: string;
}

Deno.test("the dispatch modes of process-post are exclusive", async (test) => {
  const previousFetch = globalThis.fetch;
  const previousServe = Deno.serve;
  const environment = new Map(
    ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"]
      .map((key) => [key, Deno.env.get(key)] as const),
  );
  Deno.env.set("SUPABASE_URL", ORIGIN);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
  Deno.env.set("SUPABASE_ANON_KEY", "fixture-anon");

  let handler: Handler | undefined;
  let calls: Call[] = [];
  let logs: Record<string, unknown>[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname, search: url.search });

    // The only write a refusal is allowed to make.
    if (url.pathname === "/rest/v1/system_logs") {
      const body = await request.text();
      logs.push(body ? JSON.parse(body) as Record<string, unknown> : {});
      return new Response(null, { status: 201 });
    }
    // The post read is what "the mode started" looks like.
    if (url.pathname === "/rest/v1/posts") {
      return new Response(null, { status: 404 });
    }
    // The JWT the ordinary client presents.
    if (url.pathname.startsWith("/auth/v1/")) {
      return Response.json({ id: USER, sub: USER, role: "authenticated" });
    }
    return Response.json({});
  }) as typeof fetch;

  try {
    Deno.serve = ((registered: Handler) => {
      handler = registered;
      return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
    }) as typeof Deno.serve;
    await import("./index.ts?youtube-dispatch-mode");
    Deno.serve = previousServe;
    assert(handler !== undefined);

    async function dispatch(body: Record<string, unknown>, token = SERVICE): Promise<Response> {
      calls = [];
      logs = [];
      return await handler!(new Request(`${ORIGIN}/functions/v1/process-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }));
    }

    /**
     * The calls the handler made apart from its own diagnostics.
     *
     * A refusal makes none of them: it reads nothing, claims nothing and
     * sends nothing.
     */
    function workCalls(): Call[] {
      return calls.filter((call) => call.path !== "/rest/v1/system_logs" && !call.path.startsWith("/auth/v1/"));
    }

    /** The diagnostics the DISPATCH GATE wrote. */
    function gateRefusals(): Array<Record<string, unknown>> {
      return logs
        .map((entry) => (entry.metadata as Record<string, unknown> | undefined) ?? {})
        .filter((entry) => entry.event === "dispatch_mode_refused" || entry.event === "notification_route_refused");
    }

    function refusalReason(): unknown {
      return gateRefusals()[0]?.reason;
    }

    await test.step("the upload continuation of the reconciler is dispatched", async () => {
      // The payload the reconciler builds for a YouTube continuation.
      const payload = resumePayload({
        kind: "youtube_upload_continuation",
        post_id: POST,
        attempt_started_at: ATTEMPT,
        candidate_id: SESSION,
        claim_id: LEASE,
      });
      assertEquals(payload.resume_youtube_upload_session_id, SESSION);
      assertEquals(payload.resume_youtube_upload_lease_token, LEASE);
      // The session URI is a credential and never travels in the body.
      assertEquals(JSON.stringify(payload).includes("upload_id"), false);

      await dispatch({ ...payload });
      // The mode started: the continuation read the post it belongs to. It
      // reads the columns it needs, not the whole row.
      const postRead = workCalls().find((call) => call.path === "/rest/v1/posts");
      assert(postRead !== undefined);
      assert(postRead.search.includes("processing_started_at"));
      assertEquals(gateRefusals().length, 0);
    });

    await test.step("the notification recovery of the reconciler is dispatched", async () => {
      const payload = resumePayload({
        kind: "notification_only",
        post_id: POST,
        attempt_started_at: ATTEMPT,
        candidate_id: CANDIDATE,
        claim_id: CLAIM,
      });
      assertEquals(payload.notification_only, true);
      assertEquals(payload.candidate_id, CANDIDATE);
      assertEquals(payload.notification_claim_id, CLAIM);

      await dispatch({ ...payload });
      // The mode started: the notification parent was read, and NO upload
      // session was claimed.
      const postRead = workCalls().find((call) => call.path === "/rest/v1/posts");
      assert(postRead !== undefined);
      assert(postRead.search.includes("select=*"));
      assertEquals(
        workCalls().some((call) => call.path.includes("claim_youtube_upload_session")),
        false,
      );
      assertEquals(gateRefusals().length, 0);
    });

    await test.step("the legacy publication is dispatched", async () => {
      await dispatch({ post_id: POST });
      // The mode started: the whole post was read, and NO upload session was
      // claimed.
      const postRead = workCalls().find((call) => call.path === "/rest/v1/posts");
      assert(postRead !== undefined);
      assert(postRead.search.includes("select=*"));
      assertEquals(
        workCalls().some((call) => call.path.includes("claim_youtube_upload_session")),
        false,
      );
      assertEquals(gateRefusals().length, 0);
    });

    await test.step("an attempt without a mode is refused", async () => {
      const response = await dispatch({ post_id: POST, attempt_started_at: ATTEMPT });
      assertEquals(response.status, 400);
      // Nothing was read: the refusal came before the post.
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "identity_without_mode");
    });

    await test.step("an upload continuation without its claim token is refused", async () => {
      const response = await dispatch({
        post_id: POST,
        resume_youtube_upload_session_id: SESSION,
        attempt_started_at: ATTEMPT,
      });
      assertEquals(response.status, 400);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "youtube_identity_incomplete");
    });

    await test.step("an upload continuation without its session is refused", async () => {
      const response = await dispatch({
        post_id: POST,
        resume_youtube_upload_lease_token: LEASE,
        attempt_started_at: ATTEMPT,
      });
      assertEquals(response.status, 400);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "youtube_identity_incomplete");
    });

    await test.step("an upload continuation combined with a notification claim is refused", async () => {
      const response = await dispatch({
        post_id: POST,
        resume_youtube_upload_session_id: SESSION,
        resume_youtube_upload_lease_token: LEASE,
        attempt_started_at: ATTEMPT,
        candidate_id: CANDIDATE,
        notification_claim_id: CLAIM,
      });
      assertEquals(response.status, 400);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "youtube_combined_mode");
    });

    await test.step("an upload continuation combined with a resume is refused", async () => {
      const response = await dispatch({
        post_id: POST,
        resume_youtube_upload_session_id: SESSION,
        resume_youtube_upload_lease_token: LEASE,
        attempt_started_at: ATTEMPT,
        resume_platform_post_id: ROW,
      });
      assertEquals(response.status, 400);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "youtube_combined_mode");
    });

    await test.step("an upload continuation combined with a platform override is refused", async () => {
      const response = await dispatch({
        post_id: POST,
        resume_youtube_upload_session_id: SESSION,
        resume_youtube_upload_lease_token: LEASE,
        attempt_started_at: ATTEMPT,
        platforms: ["youtube"],
      });
      assertEquals(response.status, 400);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "youtube_combined_mode");
    });

    await test.step("an upload continuation combined with an account override is refused", async () => {
      const response = await dispatch({
        post_id: POST,
        resume_youtube_upload_session_id: SESSION,
        resume_youtube_upload_lease_token: LEASE,
        attempt_started_at: ATTEMPT,
        account_ids: [SESSION],
      });
      assertEquals(response.status, 400);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "youtube_combined_mode");
    });

    await test.step("a notification mode without its claim is refused", async () => {
      const response = await dispatch({
        post_id: POST,
        notification_only: true,
        attempt_started_at: ATTEMPT,
      });
      assertEquals(response.status, 400);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "invalid_identity");
    });

    await test.step("a notification mode combined with an upload continuation is refused", async () => {
      const response = await dispatch({
        post_id: POST,
        notification_only: true,
        attempt_started_at: ATTEMPT,
        candidate_id: CANDIDATE,
        notification_claim_id: CLAIM,
        resume_youtube_upload_session_id: SESSION,
        resume_youtube_upload_lease_token: LEASE,
      });
      assertEquals(response.status, 400);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "invalid_identity_or_combined_mode");
    });

    await test.step("a notification mode combined with a publication override is refused", async () => {
      const response = await dispatch({
        post_id: POST,
        notification_only: true,
        attempt_started_at: ATTEMPT,
        candidate_id: CANDIDATE,
        notification_claim_id: CLAIM,
        platforms: ["youtube"],
      });
      assertEquals(response.status, 400);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "invalid_identity_or_combined_mode");
    });

    await test.step("an ordinary client cannot ask for the upload continuation", async () => {
      const response = await dispatch({
        post_id: POST,
        resume_youtube_upload_session_id: SESSION,
        resume_youtube_upload_lease_token: LEASE,
        attempt_started_at: ATTEMPT,
      }, USER_TOKEN);
      assertEquals(response.status, 403);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "service_role_required");
    });

    await test.step("an ordinary client cannot ask for the notification recovery", async () => {
      const response = await dispatch({
        post_id: POST,
        notification_only: true,
        attempt_started_at: ATTEMPT,
        candidate_id: CANDIDATE,
        notification_claim_id: CLAIM,
      }, USER_TOKEN);
      assertEquals(response.status, 403);
      assertEquals(workCalls().length, 0);
      assertEquals(gateRefusals().length, 1);
      assertEquals(refusalReason(), "service_role_required");
    });
  } finally {
    globalThis.fetch = previousFetch;
    Deno.serve = previousServe;
    for (const [key, value] of environment) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
