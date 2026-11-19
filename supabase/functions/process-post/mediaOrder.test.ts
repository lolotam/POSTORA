import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ORIGIN = "https://media-order-fixture.invalid";
const OWNER = "e1000000-0000-4000-8000-000000000011";
const ACCOUNT = "e2000000-0000-4000-8000-000000000011";
const POST = "e3000000-0000-4000-8000-000000000011";
const DEFERRED = "e4000000-0000-4000-8000-000000000011";
const OTHER_ACCOUNT = "e2000000-0000-4000-8000-000000000012";
const SERVICE = "fixture-service";
const MEDIA_IDS = ["media-a", "media-b", "media-c"];
type Handler = (request: Request) => Response | Promise<Response>;
type Platform = "facebook" | "instagram" | "threads";

Deno.test("shuffled media rows and reversed child completion preserve provider attachment order", async (test) => {
  const previousFetch = globalThis.fetch;
  const previousServe = Deno.serve;
  const environment = new Map(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"].map((key) => [key, Deno.env.get(key)]));
  Deno.env.set("SUPABASE_URL", ORIGIN);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
  Deno.env.set("SUPABASE_ANON_KEY", "fixture-anon");
  let handler: Handler | undefined;
  let platform: Platform = "facebook";
  let mediaError = false;
  let missingMedia = false;
  let signingFailure: "error" | "empty" | null = null;
  let deferredRow: Record<string, unknown> | null = null;
  let postWrites = 0;
  let settlementFailure: "all" | "second" | null = null;
  let accountIds = [ACCOUNT];
  let priorSuccess = false;
  const settledRows: Array<Record<string, unknown>> = [];
  const preparationLogs: Array<Record<string, unknown>> = [];
  let providerCalls = 0;
  let attachedOrder: string[] = [];
  const unexpected: string[] = [];
  let post = makePost();

  function makePost() {
    return {
      id: POST,
      user_id: OWNER,
      caption: "Ordered media",
      status: "pending",
      platforms: [platform],
      created_at: new Date().toISOString(),
      media_file_ids: [...MEDIA_IDS],
      metadata: { selected_account_ids: [ACCOUNT], instagram_post_type: "feed" },
    };
  }

  function reset(nextPlatform: Platform) {
    platform = nextPlatform;
    mediaError = false;
    missingMedia = false;
    signingFailure = null;
    deferredRow = null;
    postWrites = 0;
    settlementFailure = null;
    accountIds = [ACCOUNT];
    priorSuccess = false;
    settledRows.length = 0;
    preparationLogs.length = 0;
    providerCalls = 0;
    attachedOrder = [];
    post = makePost();
  }

  function mediaIdFromUrl(value: unknown) {
    return String(value).match(/media-[abc]/)?.[0] ?? "unknown";
  }

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (["graph.facebook.com", "graph.threads.net"].includes(url.hostname)) {
      providerCalls++;
      if (platform === "facebook") {
        const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
        if (url.pathname.endsWith("/photos")) {
          return Response.json({ id: `photo-${mediaIdFromUrl(body.url)}` });
        }
        if (url.pathname.endsWith("/feed")) {
          attachedOrder = (body.attached_media as Array<{ media_fbid: string }>).map((item) => item.media_fbid);
          return Response.json({ id: "facebook-post" });
        }
        return Response.json({});
      }

      if (platform === "instagram") {
        if (request.method === "GET" && url.searchParams.get("fields")?.includes("status_code")) {
          return Response.json({ status_code: "FINISHED" });
        }
        if (request.method === "GET" && url.searchParams.get("fields")?.includes("permalink")) {
          return Response.json({ permalink: "https://www.instagram.com/p/ordered/", shortcode: "ordered" });
        }
        const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
        if (url.pathname.endsWith("/media")) {
          if (body.media_type === "CAROUSEL") {
            attachedOrder = String(body.children).split(",");
            return Response.json({ id: "instagram-parent" });
          }
          const mediaId = mediaIdFromUrl(body.image_url);
          const childId = `child-${mediaId}`;
          const delay = mediaId === "media-a" ? 30 : mediaId === "media-b" ? 20 : 0;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return Response.json({ id: childId });
        }
        if (url.pathname.endsWith("/media_publish")) return Response.json({ id: "instagram-published" });
        return Response.json({});
      }

      if (request.method === "GET" && url.searchParams.get("fields")?.includes("status")) {
        return Response.json({ status: "FINISHED" });
      }
      if (request.method === "GET" && url.searchParams.get("fields")?.includes("permalink")) {
        return Response.json({ id: "threads-published", permalink: "https://www.threads.net/@fixture/post/ordered" });
      }
      if (url.pathname.endsWith("/threads")) {
        if (url.searchParams.get("media_type") === "CAROUSEL" && !url.searchParams.has("is_carousel_item")) {
          attachedOrder = String(url.searchParams.get("children")).split(",");
          return Response.json({ id: "threads-parent" });
        }
        const mediaId = mediaIdFromUrl(url.searchParams.get("image_url"));
        const delay = mediaId === "media-a" ? 30 : mediaId === "media-b" ? 20 : 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return Response.json({ id: `child-${mediaId}` });
      }
      if (url.pathname.endsWith("/threads_publish")) return Response.json({ id: "threads-published" });
      return Response.json({});
    }

    assertEquals(url.origin, ORIGIN, "Only the fake persistence origin is allowed");
    if (url.pathname.startsWith("/storage/v1/object/sign/")) {
      return signingFailure === "error"
        ? Response.json({ message: "fixture signing failure" }, { status: 503 })
        : Response.json(null);
    }
    const table = url.pathname.replace("/rest/v1/", "");
    if (table === "system_logs" && request.method === "POST") {
      preparationLogs.push(await request.json());
      return Response.json({});
    }
    if (table === "posts") {
      if (request.method === "PATCH") {
        postWrites++;
        Object.assign(post, await request.json());
        return Response.json([{ id: POST }]);
      }
      return Response.json(post);
    }
    if (table === "media_files") {
      if (mediaError) return Response.json({ message: "fixture media read failed" }, { status: 500 });
      const rows = missingMedia ? [{ id: "media-c" }] : [
        { id: "media-c" },
        { id: "media-a" },
        { id: "media-b" },
        { id: "media-unrelated" },
      ];
      return Response.json(rows.map(({ id }) => ({
        id,
        user_id: OWNER,
        // A storage object sits under the owner's own prefix; a CDN object
        // carries the delivery URL.
        file_path: signingFailure ? `${OWNER}/${id}.jpg` : `https://media-fixture.invalid/${id}.jpg`,
        file_type: "image",
        storage_bucket: signingFailure ? "media" : "openinary",
        mime_type: "image/jpeg",
      })));
    }
    if (table === "media_file_providers") return Response.json([]);
    if (table === "app_settings") {
      // The CDN that serves the fixture media has to be a configured origin: a
      // host the deployment did not name is never read from.
      return Response.json(url.searchParams.get("key") === "eq.cdn_storage"
        ? { value: { read_preference: "openinary", openinary: { serverUrl: "https://media-fixture.invalid" } } }
        : null);
    }
    if (table === "social_accounts") {
      assertEquals(url.searchParams.get("user_id"), `eq.${OWNER}`);
      assertEquals(url.searchParams.get("id"), `in.(${accountIds.join(",")})`);
      return Response.json(accountIds.map(id => ({
        id,
        user_id: OWNER,
        platform,
        platform_user_id: "fixture-user",
        platform_username: "fixture",
        access_token: "fixture-provider-token",
        is_active: true,
        auth_provider: "native",
        account_metadata: {},
      })));
    }
    if (table === "rpc/partner_settle_platform_post") {
      const payload = await request.json();
      if (settlementFailure === "all" || (settlementFailure === "second" && payload.p_social_account_id === OTHER_ACCOUNT)) {
        return Response.json({ message: "fixture settlement failure" }, { status: 500 });
      }
      settledRows.push(payload);
      post.status = priorSuccess || settledRows.some(row => row.p_status === "success") ? "completed" : "failed";
      return Response.json({ platform_post_id: "result-row", recorded: true });
    }
    if (table === "platform_posts") {
      if (deferredRow) {
        assertEquals(request.method, "GET", "Media preparation must not settle the deferred row");
        return Response.json(deferredRow);
      }
      return Response.json([]);
    }
    if (table === "system_logs") return new Response(null, { status: 201 });
    if (table === "profiles") return Response.json({ id: OWNER, preferred_timezone: "UTC" });
    if (["user_rate_limits", "user_subscriptions", "tier_rate_limits", "rate_limit_settings"].includes(table)) return Response.json([]);
    if (table === "api_logs") return request.method === "HEAD" ? new Response(null, { headers: { "content-range": "*/0" } }) : new Response(null, { status: 201 });
    unexpected.push(`Unexpected persistence boundary ${request.method} ${url.pathname}`);
    throw new Error(unexpected.at(-1));
  };

  try {
    Deno.serve = ((registered: Handler) => {
      handler = registered;
      return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
    }) as typeof Deno.serve;
    await import("./index.ts?media-order-handler-test");
    Deno.serve = previousServe;
    assert(handler);
    const publish = (resume = false) => handler!(new Request(`${ORIGIN}/functions/v1/process-post`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
      body: JSON.stringify({ post_id: POST, ...(resume ? { resume_platform_post_id: DEFERRED } : {}) }),
    }));

    await test.step("Facebook attached_media follows canonical IDs", async () => {
      reset("facebook");
      const response = await publish();
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(attachedOrder, ["photo-media-a", "photo-media-b", "photo-media-c"]);
    });

    for (const nextPlatform of ["instagram", "threads"] as const) {
      await test.step(`${nextPlatform} children follow canonical IDs when the last child finishes first`, async () => {
        reset(nextPlatform);
        const response = await publish();
        assertEquals(response.status, 200, await response.clone().text());
        assertEquals(attachedOrder, ["child-media-a", "child-media-b", "child-media-c"]);
      });
    }

    await test.step("a missing media row refuses every provider call", async () => {
      reset("facebook");
      missingMedia = true;
      const response = await publish();
      assertEquals(response.status, 422);
      assertEquals(providerCalls, 0);
      assertEquals(post.status, "failed");
      assertEquals(settledRows.map(row => [row.p_social_account_id, row.p_status]), [[ACCOUNT, "failed"]]);
    });

    await test.step("a media read failure refuses every provider call", async () => {
      reset("facebook");
      mediaError = true;
      const response = await publish();
      assertEquals(response.status, 503);
      assertEquals(providerCalls, 0);
      assertEquals(post.status, "failed");
      assertEquals(preparationLogs.length, 1);
      assertEquals(settledRows.map(row => [row.p_post_id, row.p_social_account_id, row.p_platform, row.p_status]), [
        [POST, ACCOUNT, "facebook", "failed"],
      ]);
    });
    for (const failure of ["error", "empty"] as const) {
      await test.step(`a signing ${failure} fails the post without calling providers`, async () => {
        reset("facebook");
        signingFailure = failure;
        const response = await publish();
        assertEquals(response.status, 503);
        assertEquals(post.status, "failed");
        assertEquals(providerCalls, 0);
        assertEquals(preparationLogs.length, 1);
        assertEquals(settledRows.map(row => [row.p_social_account_id, row.p_status]), [[ACCOUNT, "failed"]]);
      });
    }
    for (const failure of ["read", "error", "empty"] as const) {
      await test.step(`a resumed ${failure} preparation failure preserves deferred settlement`, async () => {
        reset("instagram");
        post.status = "processing";
        deferredRow = {
          id: DEFERRED, social_account_id: ACCOUNT, platform: "instagram", status: "pending",
          response_data: { deferred: {
            kind: "ig_reel", container_id: "existing-container", attempts: 1,
            first_deferred_at: new Date(Date.now() - 60000).toISOString(),
            give_up_at: new Date(Date.now() + 600000).toISOString(),
            next_check_at: new Date().toISOString(),
          } },
        };
        const previousRow = JSON.stringify(deferredRow);
        if (failure === "read") mediaError = true;
        else signingFailure = failure;
        const response = await publish(true);
        assertEquals(response.status, 503);
        assertEquals(post.status, "processing");
        assertEquals(postWrites, 0);
        assertEquals(settledRows.length, 0);
        assertEquals(JSON.stringify(deferredRow), previousRow);
        assertEquals(providerCalls, 0);
        assertEquals(preparationLogs.length, 1);
      });
    }
    await test.step("a failed retry-target write does not finalize an unrecoverable parent", async () => {
      reset("facebook");
      mediaError = true;
      settlementFailure = "all";
      const response = await publish();
      assertEquals(response.status, 500);
      assertEquals(post.status, "processing");
      assertEquals(settledRows.length, 0);
      assertEquals(providerCalls, 0);
      assertEquals(preparationLogs.length, 1);
    });
    await test.step("partial retry-target recording remains eligible for stale recovery", async () => {
      reset("facebook");
      accountIds = [ACCOUNT, OTHER_ACCOUNT];
      post.metadata.selected_account_ids = [...accountIds];
      settlementFailure = "second";
      mediaError = true;
      const response = await publish();
      assertEquals(response.status, 500);
      assertEquals(post.status, "processing");
      assertEquals(settledRows.map(row => row.p_social_account_id), [ACCOUNT]);
      assertEquals(providerCalls, 0);
    });
    await test.step("recording a failed retry preserves the settlement seam's prior-success rollup", async () => {
      reset("facebook");
      priorSuccess = true;
      mediaError = true;
      const response = await publish();
      assertEquals(response.status, 503);
      assertEquals(post.status, "completed");
      assertEquals(settledRows.map(row => [row.p_social_account_id, row.p_status]), [[ACCOUNT, "failed"]]);
      assertEquals(providerCalls, 0);
    });
    assertEquals(unexpected, []);
  } finally {
    globalThis.fetch = previousFetch;
    Deno.serve = previousServe;
    for (const [key, previous] of environment) {
      if (previous === undefined) Deno.env.delete(key);
      else Deno.env.set(key, previous);
    }
  }
});
