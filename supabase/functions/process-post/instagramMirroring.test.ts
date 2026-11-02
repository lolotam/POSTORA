import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ORIGIN = "https://publishing-fixture.invalid";
const OWNER = "e1000000-0000-4000-8000-000000000001";
const ACCOUNT = "e2000000-0000-4000-8000-000000000001";
const POST = "e3000000-0000-4000-8000-000000000001";
const SERVICE = "fixture-service";
type Handler = (request: Request) => Response | Promise<Response>;
type Row = { id: string; post_id: string; social_account_id: string; platform: string; status: string;
  platform_post_id: string | null; platform_post_url: string | null; response_data: Record<string, unknown> };

// These regressions drive the registered publisher, not an imitation process-post reply.
// Only the provider and persistence HTTP boundaries are synthetic; no network is allowed.
Deno.test("Instagram mirrors keep durable receipts and public collaborator warnings", async (test) => {
  const previousFetch = globalThis.fetch;
  const previousServe = Deno.serve;
  const environment = new Map(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "PUBLIC_API_ORIGIN"].map((key) => [key, Deno.env.get(key)]));
  Deno.env.set("SUPABASE_URL", ORIGIN);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
  Deno.env.set("SUPABASE_ANON_KEY", "fixture-anon");
  Deno.env.set("PUBLIC_API_ORIGIN", ORIGIN);
  let handler: Handler | undefined;
  let mode = "image";
  let direct = false;
  let failStory = false;
  let failReceipt = false;
  let rejectCollaborator = false;
  let storyPublishes = 0;
  let feedPublishes = 0;
  let nextContainer = 0;
  const unexpected: string[] = [];
  let rows: Row[] = [];
  let logs: Record<string, unknown>[] = [];
  let post = makePost();
  const containers = new Map<string, Record<string, unknown>>();
  function makePost() {
    const count = mode === "carousel" ? 2 : 1;
    return { id: POST, user_id: OWNER, caption: "Same content", status: "pending", platforms: ["instagram"],
      created_at: new Date().toISOString(), media_file_ids: Array.from({ length: count }, (_, index) => `media-${index}`),
      metadata: { instagram_post_type: mode === "reel" ? "reel" : "feed", instagram_share_to_story: true,
        instagram_collaborator: "doctor_one", selected_account_ids: [ACCOUNT] } };
  }
  function reset(nextMode: string, businessLogin = false) {
    mode = nextMode; direct = businessLogin; failStory = false; failReceipt = false; rejectCollaborator = false;
    storyPublishes = 0; feedPublishes = 0; rows = []; logs = []; containers.clear(); post = makePost();
  }
  function receipt(body: Record<string, unknown>, story: boolean) {
    assertEquals(body.p_post_id, POST);
    assertEquals(body.p_social_account_id, ACCOUNT);
    const mediaId = String(story ? body.p_story_id : body.p_provider_post_id);
    const existing = rows.find((row) => row.platform_post_id === mediaId);
    if (existing) return Response.json({ platform_post_id: existing.id, recorded: false });
    const row: Row = { id: `row-${rows.length}`, post_id: POST, social_account_id: ACCOUNT, platform: "instagram",
      status: story ? "success" : String(body.p_status), platform_post_id: mediaId,
      platform_post_url: String(story ? body.p_story_url : body.p_provider_post_url),
      response_data: { ...(body.p_response_data as Record<string, unknown>), ...(story ? { ig_post_subtype: "story" } : {}) } };
    rows.push(row);
    return Response.json({ platform_post_id: row.id, recorded: true });
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (["graph.facebook.com", "graph.instagram.com"].includes(url.hostname)) {
      const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
      if (url.pathname.endsWith("/media") && request.method === "POST") {
        if (body.media_type === "STORIES" && failStory) return Response.json({ error: { code: 100, message: "fixture Story refusal" } });
        if (body.collaborators && rejectCollaborator) return Response.json({ error: { code: 210, message: "not visible" } });
        const id = `container-${++nextContainer}`;
        containers.set(id, body);
        return Response.json({ id });
      }
      if (url.pathname.endsWith("/media_publish")) {
        const container = containers.get(String(body.creation_id));
        assert(container, "Only a created fixture container may publish");
        const story = container.media_type === "STORIES";
        if (story) storyPublishes++; else feedPublishes++;
        return Response.json({ id: `${story ? "story" : "feed"}-${story ? storyPublishes : feedPublishes}` });
      }
      if (url.searchParams.get("fields")?.includes("status_code")) return Response.json({ status_code: "FINISHED" });
      if (url.searchParams.get("fields")?.includes("permalink")) return Response.json({ permalink: "https://www.instagram.com/p/fixture/", shortcode: "fixture" });
      unexpected.push(`Unexpected provider boundary ${request.method} ${url.pathname}`);
      throw new Error(unexpected.at(-1));
    }
    assertEquals(url.origin, ORIGIN, "Production and all unregistered network origins are refused");
    const table = url.pathname.replace("/rest/v1/", "");
    if (table === "posts") {
      if (request.method === "PATCH") {
        Object.assign(post, await request.json());
        return Response.json([{ id: POST }]);
      }
      return Response.json(url.searchParams.get("select")?.includes("platform_posts") ? { ...post, platform_posts: rows } : post);
    }
    if (table === "media_files") return Response.json(post.media_file_ids.map((id) => ({ id, file_path: `https://media-fixture.invalid/${id}.${mode === "reel" ? "mp4" : "jpg"}`,
      file_type: mode === "reel" ? "video" : "image", storage_bucket: "openinary", mime_type: mode === "reel" ? "video/mp4" : "image/jpeg" })));
    if (table === "media_file_providers") return Response.json([]);
    if (table === "app_settings") return Response.json(null);
    if (table === "social_accounts") {
      assertEquals(url.searchParams.get("user_id"), `eq.${OWNER}`);
      return Response.json([{ id: ACCOUNT, user_id: OWNER, platform: "instagram", platform_user_id: "992001", platform_username: "fixture",
        access_token: "fixture-provider", is_active: true, auth_provider: "native", account_metadata: direct ? { account_type: "business_login" } : {} }]);
    }
    if (table === "rpc/record_published_story") {
      const body = await request.json();
      if (failReceipt) return Response.json({ message: "fixture receipt unavailable", code: "XX000" }, { status: 500 });
      return receipt(body, true);
    }
    if (table === "rpc/partner_settle_platform_post") return receipt(await request.json(), false);
    if (table === "platform_posts") {
      if (request.method === "PATCH") return Response.json([]);
      assertEquals(url.searchParams.get("post_id"), `eq.${POST}`);
      if (url.searchParams.get("select")?.includes("story_subtype:")) return Response.json(rows.map((row) => ({ status: row.status,
        story_subtype: row.response_data.ig_post_subtype ?? null, story_on_reel: null, carried_story: row.response_data.unrecorded_story ?? null })));
      return Response.json(rows);
    }
    if (table === "system_logs") { logs.push(await request.json()); return new Response(null, { status: 201 }); }
    if (table === "profiles") return Response.json({ id: OWNER, preferred_timezone: "UTC" });
    if (["user_rate_limits", "user_subscriptions", "tier_rate_limits", "rate_limit_settings"].includes(table)) return Response.json([]);
    if (table === "api_logs") return request.method === "HEAD" ? new Response(null, { headers: { "content-range": "*/0" } }) : new Response(null, { status: 201 });
    unexpected.push(`Unexpected persistence boundary ${request.method} ${url.pathname}`);
    throw new Error(unexpected.at(-1));
  };
  try {
    Deno.serve = ((registered: Handler) => { handler = registered; return { finished: Promise.resolve(), shutdown: () => Promise.resolve() }; }) as typeof Deno.serve;
    await import("./index.ts");
    Deno.serve = previousServe;
    assert(handler);
    const publish = async () => {
      const response = await handler!(new Request(`${ORIGIN}/functions/v1/process-post`, { method: "POST", headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` }, body: JSON.stringify({ post_id: POST }) }));
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json();
    };
    for (const variant of ["image", "reel", "carousel"]) await test.step(`${variant} mirror is recorded and a completed-post retry never publishes it twice`, async () => {
      reset(variant);
      await publish();
      assertEquals(rows.filter((row) => row.response_data.ig_post_subtype === "story").map((row) => row.platform_post_id), ["story-1"]);
      assertEquals(post.status, "completed");
      await publish();
      assertEquals({ storyPublishes, feedPublishes }, { storyPublishes: 1, feedPublishes: 1 });
    });
    await test.step("a refused mirror can recover on retry without republishing the completed feed", async () => {
      reset("image"); failStory = true;
      await publish();
      assertEquals(feedPublishes, 1); assertEquals(storyPublishes, 0);
      failStory = false;
      await publish();
      assertEquals({ storyPublishes, feedPublishes }, { storyPublishes: 1, feedPublishes: 1 });
      assertEquals(rows.some((row) => row.response_data.ig_post_subtype === "story"), true);
    });
    await test.step("an unrecordable live mirror keeps its carry and warning so retry does not duplicate it", async () => {
      reset("image"); failReceipt = true;
      await publish();
      const feed = rows.find((row) => row.platform_post_id === "fixture");
      assert(feed);
      assertEquals(feed.response_data.unrecorded_story, { id: "story-1", url: "https://www.instagram.com/stories/fixture/" });
      assertEquals(feed.response_data.warnings, ["The Instagram Story was published but could not be recorded."]);
      assert(logs.some((row) => JSON.stringify(row).includes("story-1")), "Unrecorded external success must leave an operational log");
      failReceipt = false;
      await publish();
      assertEquals({ storyPublishes, feedPublishes }, { storyPublishes: 1, feedPublishes: 1 });
    });
    await test.step("Business Login collaborator refusal survives storage and the public get-post response", async () => {
      reset("image", true); rejectCollaborator = true;
      await publish();
      const { handleRequest } = await import("../n8n-api/index.ts");
      const response = await handleRequest(new Request(`${ORIGIN}/n8n-api/api/v1/post/${POST}`, { headers: { "x-api-key": "postora-fixture" } }));
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json();
      const feed = body.post.platform_results.find((row: { post_id: string }) => row.post_id === "feed-1");
      assert(feed);
      assertEquals(feed.warnings, ["Collaborator @doctor_one skipped."]);
    });
    assertEquals(unexpected, [], "No fixture boundary may fail invisibly inside a production catch");
  } finally {
    globalThis.fetch = previousFetch;
    Deno.serve = previousServe;
    for (const [key, previous] of environment) { if (previous === undefined) Deno.env.delete(key); else Deno.env.set(key, previous); }
  }
});
