/**
 * The native publishers record a revoked Meta grant against the account they published with.
 *
 * The suite drives the registered route with a synthetic provider and a synthetic persistence
 * boundary: no network, no live environment, no customer. Meta answers with its structured
 * refusal, and the test watches the account write, the provider calls, the settled error and
 * the diagnostics.
 *
 * The account write is checked against the fixture's own row, so the production query's
 * predicates decide whether the row is changed: the account id, the owner, the platform, the
 * active state, the row version and the reconnect flag.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ContainerStillProcessing, type PublishTiming } from "./deferredPublish.ts";
import {
  createMetaPublishReauthObserver,
  META_PUBLISH_REAUTH_REASON,
  type MetaPublishReauthWriteRequest,
  type MetaPublishReauthWriter,
} from "./metaPublishReauth.ts";

const ORIGIN = "https://meta-reauth-fixture.invalid";
const OWNER = "e1000000-0000-4000-8000-000000000021";
const ACCOUNT = "e2000000-0000-4000-8000-000000000021";
const OTHER_ACCOUNT = "e2000000-0000-4000-8000-000000000022";
const POST = "e3000000-0000-4000-8000-000000000021";
const SERVICE = "fixture-service";
const CREDENTIAL_MARKER = "fixture-a";
const SIGNED_URL_MARKER = "FIXTURE-SIGNED-URL-MARKER";
const HEALTHY_TOKEN = "fixture-b";
const ROW_VERSION = "2026-11-21T10:00:00.123456+00:00";
const FUTURE_EXPIRY = "2999-01-01T00:00:00+00:00";

type Handler = (request: Request) => Response | Promise<Response>;
type FailurePoint =
  | "none"
  | "reel-start"
  | "reel-upload"
  | "reel-finish"
  | "create"
  | "primary"
  | "child"
  | "poll"
  | "poll-5xx"
  | "publish"
  | "content"
  | "permalink"
  | "transient";

interface AccountRow {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string;
  access_token: string;
  is_active: boolean;
  needs_reauth: boolean | null;
  updated_at: string;
  token_expires_at: string;
  auth_provider: string;
  account_metadata: Record<string, unknown>;
  last_refresh_error: string | null;
}

/** Meta's structured refusal, with the credential in its message. */
function revokedResponse(status = 400): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "OAuthException",
        code: 190,
        error_subcode: 458,
        message: `Error validating access token: ${CREDENTIAL_MARKER} (OAuth ${CREDENTIAL_MARKER}) https://media-fixture.invalid/upload?signature=${SIGNED_URL_MARKER}`,
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** A refusal that is not about the grant: the account keeps working. */
function contentResponse(): Response {
  return new Response(
    JSON.stringify({ error: { code: 100, message: `Media type unsupported ${CREDENTIAL_MARKER}` } }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

Deno.test("a revoked Meta grant is recorded once against the account the native publisher used", async (test) => {
  const previousFetch = globalThis.fetch;
  const previousServe = Deno.serve;
  const environment = new Map(
    ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "PUBLIC_API_ORIGIN"]
      .map((key) => [key, Deno.env.get(key)] as const),
  );
  Deno.env.set("SUPABASE_URL", ORIGIN);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
  Deno.env.set("SUPABASE_ANON_KEY", "fixture-anon");
  Deno.env.set("PUBLIC_API_ORIGIN", ORIGIN);

  let handler: Handler | undefined;
  let platform = "instagram";
  let direct = false;
  let failurePoint: FailurePoint = "none";
  let postType = "feed";
  let mediaKind: "image" | "video" = "image";
  let mediaCount = 1;
  let failingAccount = ACCOUNT;
  let providerCalls: string[] = [];
  let reconnectWrites: { query: string; body: Record<string, unknown> }[] = [];
  let settlements: Record<string, unknown>[] = [];
  let storyReceipts: Record<string, unknown>[] = [];
  let statusCalls = 0;
  let onRetry: (() => void) | undefined;
  let retriedWhileWritePending = false;
  let logs: string[] = [];
  let post = makePost();
  const unexpected: string[] = [];

  function makePost() {
    return {
      id: POST,
      user_id: OWNER,
      caption: "Revoked grant fixture",
      status: "pending",
      platforms: [platform],
      created_at: new Date().toISOString(),
      media_file_ids: Array.from({ length: mediaCount }, (_, index) => `media-${index}`),
      metadata: {
        selected_account_ids: [ACCOUNT],
        facebook_post_type: [postType],
        instagram_post_type: [postType],
      },
    };
  }

  function reset(next: {
    platform?: string;
    direct?: boolean;
    failurePoint?: FailurePoint;
    postType?: string;
    mediaKind?: "image" | "video";
    mediaCount?: number;
    failingAccount?: string;
  }) {
    platform = next.platform ?? platform;
    direct = next.direct ?? false;
    failurePoint = next.failurePoint ?? "none";
    postType = next.postType ?? postType;
    mediaKind = next.mediaKind ?? mediaKind;
    mediaCount = next.mediaCount ?? mediaCount;
    failingAccount = next.failingAccount ?? failingAccount;
    providerCalls = [];
    reconnectWrites = [];
    settlements = [];
    storyReceipts = [];
    statusCalls = 0;
    onRetry = undefined;
    retriedWhileWritePending = false;
    logs = [];
    post = makePost();
  }

  function accountRows(): AccountRow[] {
    const rows: AccountRow[] = [
      {
        id: ACCOUNT,
        user_id: OWNER,
        platform,
        platform_user_id: "fixture-user",
        platform_username: "fixture",
        access_token: failingAccount === ACCOUNT ? CREDENTIAL_MARKER : HEALTHY_TOKEN,
        is_active: true,
        needs_reauth: false,
        updated_at: ROW_VERSION,
        token_expires_at: FUTURE_EXPIRY,
        auth_provider: "native",
        account_metadata: direct ? { account_type: "business_login" } : {},
        last_refresh_error: null,
      },
    ];
    if (failingAccount === OTHER_ACCOUNT) {
      rows.push({
        ...rows[0],
        id: OTHER_ACCOUNT,
        access_token: CREDENTIAL_MARKER,
        platform_username: "fixture-other",
      });
    }
    return rows;
  }

  /** The production query's predicates decide whether the fixture's row changes. */
  function matchesEveryPredicate(query: URLSearchParams, row: AccountRow): boolean {
    const flagFilter = query.get("or") ?? "";
    return query.get("id") === `eq.${row.id}` &&
      query.get("user_id") === `eq.${row.user_id}` &&
      query.get("platform") === `eq.${row.platform}` &&
      query.get("is_active") === "eq.true" &&
      query.get("updated_at") === `eq.${row.updated_at}` &&
      flagFilter.includes("needs_reauth.is.null") &&
      flagFilter.includes("needs_reauth.eq.false");
  }

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.hostname === "media-fixture.invalid") {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": mediaKind === "video" ? "video/mp4" : "image/jpeg" },
      });
    }

    if (url.hostname === "graph.facebook.com" || url.hostname === "graph.instagram.com") {
      providerCalls.push(`${request.method} ${url.pathname}`);
      const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
      const authorization = request.headers.get("Authorization") ?? "";
      const token = typeof body.access_token === "string"
        ? body.access_token
        : url.searchParams.get("access_token") ?? (authorization.startsWith("OAuth ") ? authorization.slice(6) : "");

      if (url.pathname.endsWith("/video_reels") && request.method === "POST") {
        const phase = String(body.upload_phase);
        if (failurePoint === `reel-${phase}` && token === CREDENTIAL_MARKER) return revokedResponse();
        if (phase === "start") {
          return Response.json({ video_id: "video-1", upload_url: "https://graph.facebook.com/v18.0/fixture-upload" });
        }
        return Response.json({ video_id: "video-1" });
      }
      if (url.pathname.endsWith("/fixture-upload")) {
        if (failurePoint === "reel-upload" && token === CREDENTIAL_MARKER) return revokedResponse();
        return Response.json({ success: true });
      }
      if (url.pathname.endsWith("/media") && request.method === "POST") {
        if (body.is_carousel_item) {
          if (failurePoint === "child" && token === CREDENTIAL_MARKER) return revokedResponse();
          return Response.json({ id: "child-1" });
        }
        if (body.media_type === "CAROUSEL") {
          if (failurePoint === "create" && token === CREDENTIAL_MARKER) return revokedResponse();
          return Response.json({ id: "carousel-1" });
        }
        // The Story is published before the reel it mirrors, so it is not the refusal's target.
        if (body.media_type !== "STORIES" && failurePoint === "primary" && token === CREDENTIAL_MARKER) return revokedResponse();
        if (failurePoint === "create" && token === CREDENTIAL_MARKER) return revokedResponse();
        if (failurePoint === "content" && token === CREDENTIAL_MARKER) return contentResponse();
        return Response.json({ id: body.media_type === "STORIES" ? "story-container" : "container-1" });
      }
      if (request.method === "GET" && url.searchParams.get("fields")?.includes("status_code")) {
        if (failurePoint === "poll" && token === CREDENTIAL_MARKER) return revokedResponse();
        if (failurePoint === "poll-5xx" && statusCalls === 0) {
          statusCalls++;
          return revokedResponse(500);
        }
        if (onRetry) {
          retriedWhileWritePending = true;
          onRetry();
        }
        if (failurePoint === "transient" && token === CREDENTIAL_MARKER && statusCalls === 0) {
          statusCalls++;
          return new Response(JSON.stringify({ error: { code: 2, message: "An unexpected error has occurred" } }), { status: 400 });
        }
        statusCalls++;
        return Response.json({ status_code: "FINISHED" });
      }
      if (url.pathname.endsWith("/media_publish")) {
        if (failurePoint === "publish" && token === CREDENTIAL_MARKER) return revokedResponse();
        return Response.json({ id: "published-1" });
      }
      if (request.method === "GET" && url.searchParams.get("fields")?.includes("permalink")) {
        if (failurePoint === "permalink") return new Response("not json", { status: 502 });
        return Response.json({ permalink: "https://www.instagram.com/p/fixture/", shortcode: "fixture" });
      }
      if (url.pathname.endsWith("/comments")) return Response.json({ id: "comment-1" });
      return Response.json({ success: true });
    }

    assertEquals(url.origin, ORIGIN, "Only the fake persistence origin is allowed");
    const table = url.pathname.replace("/rest/v1/", "");
    if (table === "posts") {
      if (request.method === "PATCH") {
        Object.assign(post, await request.json());
        return Response.json([{ id: POST }]);
      }
      return Response.json(post);
    }
    if (table === "media_files") {
      return Response.json(post.media_file_ids.map((id) => ({
        id,
        user_id: OWNER,
        file_path: `https://media-fixture.invalid/${id}.${mediaKind === "video" ? "mp4" : "jpg"}?signature=${SIGNED_URL_MARKER}`,
        file_type: mediaKind,
        storage_bucket: "openinary",
        mime_type: mediaKind === "video" ? "video/mp4" : "image/jpeg",
      })));
    }
    if (table === "media_file_providers") return Response.json([]);
    if (table === "app_settings") {
      return Response.json(url.searchParams.get("key") === "eq.cdn_storage"
        ? { value: { read_preference: "openinary", openinary: { serverUrl: "https://media-fixture.invalid" } } }
        : null);
    }
    if (table === "social_accounts") {
      if (request.method === "PATCH") {
        const body = await request.json() as Record<string, unknown>;
        const matched = accountRows().filter((row) => matchesEveryPredicate(url.searchParams, row));
        reconnectWrites.push({ query: url.searchParams.toString(), body });
        if (failurePoint === "poll-5xx") {
          const retry = Promise.withResolvers<void>();
          onRetry = retry.resolve;
          request.signal.addEventListener("abort", () => retry.reject(new Error("Fixture write timed out")), { once: true });
          await retry.promise;
          onRetry = undefined;
        }
        return Response.json(matched.map((row) => ({ id: row.id })));
      }
      return Response.json(accountRows());
    }
    if (table === "rpc/partner_settle_platform_post") {
      settlements.push(await request.json());
      return Response.json({ platform_post_id: "settled-row", recorded: true });
    }
    if (table === "rpc/record_published_story") {
      storyReceipts.push(await request.json());
      return Response.json({ platform_post_id: "story-row", recorded: true });
    }
    if (table === "rpc/prepare_instagram_story") return Response.json(true);
    if (table === "platform_posts") {
      if (request.method === "PATCH") return Response.json([]);
      return Response.json([]);
    }
    if (table === "system_logs") return new Response(null, { status: 201 });
    if (table === "profiles") return Response.json({ id: OWNER, preferred_timezone: "UTC" });
    if (["user_rate_limits", "user_subscriptions", "tier_rate_limits", "rate_limit_settings"].includes(table)) return Response.json([]);
    if (table === "api_logs") return request.method === "HEAD" ? new Response(null, { headers: { "content-range": "*/0" } }) : new Response(null, { status: 201 });
    unexpected.push(`Unexpected persistence boundary ${request.method} ${url.pathname}`);
    throw new Error(unexpected.at(-1));
  };

  const previousLog = console.log;
  const previousWarn = console.warn;
  const previousError = console.error;
  const record = (...message: unknown[]) => { logs.push(message.map((part) => String(part)).join(" ")); };
  console.log = record;
  console.warn = record;
  console.error = record;

  try {
    Deno.serve = ((registered: Handler) => {
      handler = registered;
      return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
    }) as typeof Deno.serve;
    await import("./index.ts?meta-publish-reauth-routes");
    Deno.serve = previousServe;
    assert(handler);

    const publish = async () => {
      const response = await handler!(new Request(`${ORIGIN}/functions/v1/process-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
        body: JSON.stringify({ post_id: POST }),
      }));
      return { status: response.status, body: await response.text() };
    };

    /** The write the account needs, and nothing else. */
    const assertOneScopedWrite = () => {
      assertEquals(reconnectWrites.length, 1, "The account is written once");
      const write = reconnectWrites[0];
      assertEquals(write.body, { needs_reauth: true, last_refresh_error: META_PUBLISH_REAUTH_REASON });
      const query = new URLSearchParams(write.query);
      assertEquals(query.get("id"), `eq.${failingAccount}`);
      assertEquals(query.get("user_id"), `eq.${OWNER}`);
      assertEquals(query.get("platform"), `eq.${platform}`);
      assertEquals(query.get("is_active"), "eq.true");
      assertEquals(query.get("updated_at"), `eq.${ROW_VERSION}`);
      assertEquals(query.get("or"), "(needs_reauth.is.null,needs_reauth.eq.false)");
      assertEquals(write.query.includes(CREDENTIAL_MARKER), false, "The credential must not reach the write");
    };

    const assertNoWrite = () => {
      assertEquals(reconnectWrites.length, 0, "An account is only written on a revoked grant");
    };

    /**
     * The observation's own output: the warning it emits, the write it asks for and the
     * reason it stores. None of them may carry the credential or the signed media URL.
     */
    const assertCleanObservation = () => {
      const warnings = logs.filter((line) => line.includes("meta_publish_reauth_write_failed"));
      assertEquals(warnings.length, 0, "A write that succeeds warns about nothing");
      assertEquals(warnings.join("\n").includes(CREDENTIAL_MARKER), false, "The observation's warning must not carry the credential");
      assertEquals(warnings.join("\n").includes(SIGNED_URL_MARKER), false, "The observation's warning must not carry the signed URL");
      for (const write of reconnectWrites) {
        assertEquals(write.query.includes(CREDENTIAL_MARKER), false, "The credential must not reach the write");
        assertEquals(write.query.includes(SIGNED_URL_MARKER), false, "The signed URL must not reach the write");
        assertEquals(write.body.last_refresh_error, META_PUBLISH_REAUTH_REASON, "The stored reason is stable");
      }
    };

    /**
     * The publish boundaries answer with the provider's own text, which can echo the credential.
     * Their message is replaced by the structured fields before it reaches a log or a row.
     */
    const assertCleanReturnedError = (body: string) => {
      assertEquals(body.includes(CREDENTIAL_MARKER), false, "The returned error must not carry the credential");
      assertEquals(body.includes(SIGNED_URL_MARKER), false, "The returned error must not carry the signed URL");
      assertEquals(logs.join("\n").includes(CREDENTIAL_MARKER), false, "The diagnostics must not carry the credential");
      assertEquals(logs.join("\n").includes(SIGNED_URL_MARKER), false, "The diagnostics must not carry the signed URL");
      assertEquals(logs.join("\n").includes(`OAuth ${CREDENTIAL_MARKER}`), false, "The diagnostics must not carry the authorization header");
    };

    for (const phase of ["reel-start", "reel-upload", "reel-finish"] as const) {
      await test.step(`a Facebook Reel refusal at the ${phase.replace("reel-", "")} phase records the account once`, async () => {
        reset({ platform: "facebook", postType: "reel", mediaKind: "video", failurePoint: phase });
        const { body } = await publish();

        assertOneScopedWrite();
        assertCleanObservation();
        assertCleanReturnedError(body);
        assertEquals(settlements.length, 1);
        assertEquals(String(settlements[0].p_error_message).includes("Facebook Reel"), true, "The failing stage is kept");
        assertEquals(String(settlements[0].p_error_message).includes(CREDENTIAL_MARKER), false);
      });
    }

    await test.step("a Facebook Reel refusal stops the later phases", async () => {
      reset({ platform: "facebook", postType: "reel", mediaKind: "video", failurePoint: "reel-start" });
      await publish();

      assertEquals(providerCalls.filter((call) => call.includes("video_reels")).length, 1, "Only the first phase was called");
      assertEquals(providerCalls.some((call) => call.includes("fixture-upload")), false, "The upload never happened");
    });

    for (const [host, direct] of [["Page", false], ["Business Login", true]] as const) {
      for (const point of ["create", "child", "poll", "publish"] as const) {
        await test.step(`an Instagram ${host} refusal at the ${point} records the account once`, async () => {
          reset({
            platform: "instagram",
            direct,
            postType: "feed",
            mediaKind: "image",
            mediaCount: point === "child" ? 2 : 1,
            failurePoint: point as FailurePoint,
          });
          const { body } = await publish();

          assertOneScopedWrite();
          assertCleanObservation();
          assertCleanReturnedError(body);
          assertCleanReturnedError(JSON.stringify(settlements));
        });
      }
    }

    await test.step("a refusal that is not about the grant records nothing", async () => {
      reset({ platform: "instagram", postType: "feed", mediaKind: "image", failurePoint: "content" });
      const { body } = await publish();

      assertNoWrite();
      assert(body.includes("Media type unsupported"));
      assertCleanReturnedError(body);
    });

    await test.step("a transient status answer is retried and records nothing", async () => {
      reset({ platform: "instagram", postType: "feed", mediaKind: "image", failurePoint: "transient" });
      const { body } = await publish();

      assertNoWrite();
      assertEquals(statusCalls, 2, "The transient answer was asked once more");
      assertEquals(providerCalls.some((call) => call.includes("media_publish")), true, "The publish still happened");
      assertEquals(body.includes(CREDENTIAL_MARKER), false);
    });

    await test.step("a status retry can proceed while the reconnect write is pending", async () => {
      reset({ platform: "instagram", postType: "feed", mediaKind: "image", failurePoint: "poll-5xx" });
      await publish();

      assertOneScopedWrite();
      assertEquals(retriedWhileWritePending, true);
      assertEquals(statusCalls, 2);
      assertEquals(providerCalls.some((call) => call.includes("media_publish")), true);
    });

    await test.step("a published Story survives the failure of the publish it mirrored", async () => {
      reset({ platform: "instagram", postType: "story", mediaKind: "image", failurePoint: "primary" });
      post.metadata.instagram_post_type = ["story", "reel"];
      const { body } = await publish();

      assertOneScopedWrite();
      assertEquals(storyReceipts.length, 1, "The Story that was published is still recorded");
      assertEquals(providerCalls.some((call) => call.includes("media_publish")), true, "The Story was published");
      assertEquals(body.includes(CREDENTIAL_MARKER), false);
    });

    await test.step("a successful publish records nothing", async () => {
      reset({ platform: "instagram", postType: "feed", mediaKind: "image" });
      const { body } = await publish();

      assertNoWrite();
      assertEquals(providerCalls.some((call) => call.includes("media_publish")), true, "The publish still happened");
      assertEquals(body.includes(CREDENTIAL_MARKER), false);
    });

    await test.step("a best-effort failure after the publish records nothing", async () => {
      reset({ platform: "instagram", postType: "feed", mediaKind: "image", failurePoint: "permalink" });
      const { body } = await publish();

      assertNoWrite();
      assertEquals(providerCalls.some((call) => call.includes("media_publish")), true, "The publish still happened");
      assertEquals(body.includes(CREDENTIAL_MARKER), false);
    });

    await test.step("only the account that was refused is recorded", async () => {
      reset({ platform: "instagram", postType: "feed", mediaKind: "image", failingAccount: OTHER_ACCOUNT, failurePoint: "create" });
      post.metadata.selected_account_ids = [ACCOUNT, OTHER_ACCOUNT];
      const { body } = await publish();

      assertEquals(reconnectWrites.length, 1, "The refused account is written once");
      assertEquals(new URLSearchParams(reconnectWrites[0].query).get("id"), `eq.${OTHER_ACCOUNT}`);
      assertEquals(body.includes(CREDENTIAL_MARKER), false);
    });

    assertEquals(unexpected, [], "No fixture boundary may fail invisibly inside a production catch");
  } finally {
    globalThis.fetch = previousFetch;
    Deno.serve = previousServe;
    console.log = previousLog;
    console.warn = previousWarn;
    console.error = previousError;
    for (const [key, previous] of environment) {
      if (previous === undefined) Deno.env.delete(key);
      else Deno.env.set(key, previous);
    }
  }
});

Deno.test("a resumed container is finished with fresh credentials and an unanswered publish stays uncertain", async (test) => {
  const previousFetch = globalThis.fetch;
  const previousServe = Deno.serve;
  const previousLog = console.log;
  const previousWarn = console.warn;
  const previousError = console.error;
  const logs: string[] = [];
  const record = (...message: unknown[]) => { logs.push(message.map((part) => String(part)).join(" ")); };
  console.log = record;
  console.warn = record;
  console.error = record;

  let providerCalls: string[] = [];
  let writes: MetaPublishReauthWriteRequest[] = [];
  let publishAnswer: "refused" | "unanswered" = "refused";
  let statusAnswer: "finished" | "refused" | "stalled" = "finished";
  let statusCalls = 0;
  let bodyAborted = false;

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    providerCalls.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith("/media") && request.method === "POST") return Response.json({ id: "container-1" });
    if (request.method === "GET" && url.searchParams.get("fields")?.includes("status_code")) {
      statusCalls++;
      // The readiness poll asks first; the one-shot check after an unanswered publish asks
      // again, and that answer is the one that reports the revoked grant.
      if (statusCalls > 1 && statusAnswer === "refused") return revokedResponse();
      if (statusCalls > 1 && statusAnswer === "stalled") {
        return new Response(new ReadableStream({
          start(controller) {
            request.signal.addEventListener("abort", () => {
              bodyAborted = true;
              controller.error(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          },
        }), { status: 502 });
      }
      return Response.json({ status_code: "FINISHED" });
    }
    if (url.pathname.endsWith("/media_publish")) {
      if (publishAnswer === "unanswered") throw new TypeError("fixture network failure");
      return revokedResponse();
    }
    return Response.json({ success: true });
  };

  const write: MetaPublishReauthWriter = async (request) => {
    writes.push(request);
    return { matched: 1, error: null };
  };
  // The observer is bound to one attempt, so every attempt gets its own.
  const observeFor = () => createMetaPublishReauthObserver({
    snapshot: {
      accountId: ACCOUNT,
      postOwnerId: OWNER,
      platform: "instagram",
      updatedAt: ROW_VERSION,
      accessToken: CREDENTIAL_MARKER,
    },
    requestToken: CREDENTIAL_MARKER,
    write,
  });
  const account = {
    id: ACCOUNT,
    platform: "instagram",
    platform_user_id: "fixture-user",
    platform_username: "fixture",
    access_token: CREDENTIAL_MARKER,
    refresh_token: null,
    account_metadata: {},
    updated_at: ROW_VERSION,
  };
  const post = {
    id: POST,
    user_id: OWNER,
    caption: "Unanswered publish",
    platforms: ["instagram"],
    media_file_ids: ["media-a"],
    metadata: { instagram_post_type: ["reel"] as ("feed" | "story" | "reel")[] },
  };
  const mediaUrls = ["https://media-fixture.invalid/media-a.mp4"];
  const mediaFiles = [{
    id: "media-a",
    user_id: OWNER,
    file_path: "https://media-fixture.invalid/media-a.mp4",
    file_type: "video",
    storage_bucket: "openinary",
    mime_type: "video/mp4",
  }];

  try {
    Deno.serve = ((registered: Handler) => {
      return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
    }) as typeof Deno.serve;
    const { postToInstagram } = await import("./index.ts?meta-publish-reauth-resume");
    Deno.serve = previousServe;

    await test.step("a resumed reel finishes the saved container and records the revoked grant", async () => {
      providerCalls = [];
      writes = [];
      statusCalls = 0;
      publishAnswer = "refused";
      statusAnswer = "finished";
      const timing: PublishTiming = {
        resume: {
          platformPostId: "platform-post-1",
          deferral: {
            kind: "ig_reel",
            container_id: "saved-container",
            media_type: "VIDEO",
            attempts: 1,
            first_deferred_at: new Date().toISOString(),
            give_up_at: new Date(Date.now() + 1_800_000).toISOString(),
            next_check_at: new Date(Date.now() + 60_000).toISOString(),
          },
        },
        deadlineMs: 0,
        startedAtMs: Date.now(),
      };

      const failure = await postToInstagram(account, post, mediaUrls, mediaFiles, timing, undefined, undefined, undefined, observeFor())
        .then(() => null, (error: unknown) => error);

      assert(failure instanceof Error, "The refused publish fails the resumed run");
      assertEquals(providerCalls.some((call) => call.endsWith("/media")), false, "A resumed run creates no container");
      assertEquals(providerCalls.some((call) => call.includes("saved-container")), true, "The saved container is the one that is published");
      assertEquals(writes.length, 1, "The revoked grant is recorded once");
      assertEquals(writes[0].updatedAt, ROW_VERSION, "The write is fenced with the row version of this attempt");
      assertEquals(writes[0].accountId, ACCOUNT);
    });

    await test.step("an unanswered publish keeps the container and the uncertainty", async () => {
      providerCalls = [];
      writes = [];
      statusCalls = 0;
      publishAnswer = "unanswered";
      statusAnswer = "refused";
      const timing: PublishTiming = { resume: null, deadlineMs: Number.POSITIVE_INFINITY, startedAtMs: Date.now() };

      const failure = await postToInstagram(account, post, mediaUrls, mediaFiles, timing, undefined, undefined, undefined, observeFor())
        .then(() => null, (error: unknown) => error);

      assert(failure instanceof ContainerStillProcessing, "An unanswered publish stays uncertain");
      assertEquals(failure.containerId, "container-1", "The container this run created is kept");
      assertEquals(providerCalls.filter((call) => call.endsWith("/media")).length, 1, "No second container is created");
      assertEquals(writes.length, 1, "The revoked grant is recorded once");
      assertEquals(logs.join("\n").includes(CREDENTIAL_MARKER), false, "The diagnostics must not carry the credential");
    });

    await test.step("a hanging error body cannot stall ambiguous publish recovery", async () => {
      providerCalls = [];
      writes = [];
      statusCalls = 0;
      publishAnswer = "unanswered";
      statusAnswer = "stalled";
      const timing: PublishTiming = { resume: null, deadlineMs: Number.POSITIVE_INFINITY, startedAtMs: Date.now() };

      const failure = await postToInstagram(account, post, mediaUrls, mediaFiles, timing, undefined, undefined, undefined, observeFor())
        .then(() => null, (error: unknown) => error);

      assert(failure instanceof ContainerStillProcessing);
      assertEquals(failure.containerId, "container-1");
      assertEquals(bodyAborted, true);
      assertEquals(writes.length, 0);
      assertEquals(providerCalls.filter((call) => call.endsWith("/media_publish")).length, 1);
    });
  } finally {
    globalThis.fetch = previousFetch;
    Deno.serve = previousServe;
    console.log = previousLog;
    console.warn = previousWarn;
    console.error = previousError;
  }
});
