import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ORIGIN = "https://publishing-fixture.invalid";
const OWNER = "e1000000-0000-4000-8000-000000000001";
const ACCOUNT = "e2000000-0000-4000-8000-000000000001";
const POST = "e3000000-0000-4000-8000-000000000001";
const MEDIA = "e4000000-0000-4000-8000-000000000001";
const API_KEY = "postora-fixture";
type StoredPost = { id: string; metadata: Record<string, unknown>; user_id: string };
type Handler = (request: Request) => Response | Promise<Response>;

Deno.test("registered MCP and create API preserve Story sharing and collaborator options", async (test) => {
  const previousFetch = globalThis.fetch;
  const previousServe = Deno.serve;
  const previousEnvironment = new Map(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PUBLIC_API_ORIGIN"].map((key) => [key, Deno.env.get(key)]));
  Deno.env.set("SUPABASE_URL", ORIGIN);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fixture-service");
  Deno.env.set("PUBLIC_API_ORIGIN", ORIGIN);
  const inserted: StoredPost[] = [];
  let published = 0;
  let storyFailed = false;
  let api: Handler;
  let mcp: Handler | undefined;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assertEquals(url.origin, ORIGIN, "No provider or production request is allowed");
    if (url.pathname.startsWith("/functions/v1/n8n-api")) {
      // Kong strips the public functions prefix before the API router runs.
      url.pathname = url.pathname.replace("/functions/v1", "");
      return await api(new Request(url, request));
    }
    if (url.pathname === "/functions/v1/process-post") {
      assertEquals(await request.json(), { post_id: POST });
      assertEquals(inserted.at(-1)?.metadata.instagram_share_to_story, true);
      assertEquals(inserted.at(-1)?.metadata.instagram_collaborator, "doctor_one");
      published++;
      return Response.json({ success: true });
    }
    if (url.pathname === "/rest/v1/profiles") return Response.json({ id: OWNER, preferred_timezone: "UTC" });
    if (["user_rate_limits", "user_subscriptions", "tier_rate_limits", "rate_limit_settings"].some((table) => url.pathname === `/rest/v1/${table}`)) return Response.json([]);
    if (url.pathname === "/rest/v1/social_accounts") {
      assertEquals(url.searchParams.get("user_id"), `eq.${OWNER}`);
      return Response.json([{ id: ACCOUNT, platform: "instagram", platform_user_id: "992001", platform_username: "publishing_fixture", auth_provider: "native" }]);
    }
    if (url.pathname === "/rest/v1/rpc/can_create_post") return Response.json(true);
    if (url.pathname === "/rest/v1/api_logs" && request.method === "HEAD") return new Response(null, { headers: { "content-range": "*/0" } });
    if (["api_logs", "system_logs"].some((table) => url.pathname === `/rest/v1/${table}`) && request.method === "POST") return new Response(null, { status: 201 });
    if (url.pathname === "/rest/v1/posts" && request.method === "POST") {
      const post: StoredPost = { ...await request.json(), id: POST };
      assertEquals(post.user_id, OWNER);
      inserted.push(post);
      return Response.json(post, { status: 201 });
    }
    if (url.pathname === "/rest/v1/platform_posts") return Response.json([
      { id: "feed-row", platform: "instagram", status: "success", platform_post_id: "feed-id", platform_post_url: "https://www.instagram.com/p/fixture/",
        response_data: { warnings: storyFailed ? ["Also share to Story failed: fixture refusal"] : ["Collaborator invitation rejected: fixture refusal"] } },
      ...(storyFailed ? [] : [{ id: "story-row", platform: "instagram", status: "success", platform_post_id: "story-id", platform_post_url: "https://www.instagram.com/stories/fixture/story-id/" }]),
    ]);
    throw new Error(`Unexpected fixture boundary ${request.method} ${url.pathname}`);
  };
  try {
    ({ handleRequest: api } = await import("./index.ts"));
    Deno.serve = ((registered: Handler) => { mcp = registered; return { finished: Promise.resolve(), shutdown: () => Promise.resolve() }; }) as typeof Deno.serve;
    await import("../mcp/index.ts");
    Deno.serve = previousServe;
    assert(mcp, "The production MCP composition must register its real HTTP handler");
    const invoke = async (method: string, params?: unknown) => {
      const response = await mcp!(new Request(`${ORIGIN}/functions/v1/mcp`, { method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
      assertEquals(response.status, 200);
      return await response.json();
    };
    await test.step("tools/list advertises the optional mirror boolean and existing collaborator input", async () => {
      const listed = await invoke("tools/list");
      const tool = listed.result.tools.find((entry: { name: string }) => entry.name === "create_post");
      assert(tool);
      assertEquals(tool.inputSchema.properties.instagram_share_to_story?.type, "boolean");
      assert(tool.inputSchema.properties.instagram_collaborators);
    });
    const common = { caption: "One post and its Story", platforms: ["instagram"], account_ids: [ACCOUNT], media_file_ids: [MEDIA], scheduled_at: "2099-01-01T12:00:00Z" };
    for (const mirror of [true, false, undefined]) {
      await test.step(`MCP persists ${String(mirror)} and its primary collaborator`, async () => {
        const response = await invoke("tools/call", { name: "create_post", arguments: { ...common, instagram_collaborators: '@doctor_one, doctor_two',
          ...(mirror === undefined ? {} : { instagram_share_to_story: mirror }) } });
        assertEquals(response.result.isError, undefined, JSON.stringify(response));
        const stored = inserted.at(-1)!;
        assertEquals(stored.metadata.instagram_share_to_story, mirror);
        assertEquals(Object.hasOwn(stored.metadata, "instagram_share_to_story"), mirror !== undefined);
        assertEquals(stored.metadata.instagram_collaborator, "@doctor_one");
        assertEquals(JSON.parse(response.result.content[0].text).scheduled, true);
      });
    }
    for (const failed of [false, true]) {
      await test.step(`immediate create retains the post/Story outcome and warnings: storyFailed=${failed}`, async () => {
        storyFailed = failed;
        const before = inserted.length;
        const previousPublished = published;
        const response = await invoke("tools/call", { name: "create_post", arguments: { ...common, scheduled_at: undefined,
          instagram_share_to_story: true, instagram_collaborators: ["doctor_one"] } });
        assertEquals(response.result.isError, undefined, JSON.stringify(response));
        const receipt = JSON.parse(response.result.content[0].text);
        assertEquals(receipt.scheduled, false);
        assertEquals(inserted.length, before + 1);
        assertEquals(published, previousPublished + 1);
        assertEquals(receipt.platform_results.map((entry: { post_id: string }) => entry.post_id), failed ? ["feed-id"] : ["feed-id", "story-id"]);
        assertEquals(receipt.platform_results[0].warnings, [failed ? "Also share to Story failed: fixture refusal" : "Collaborator invitation rejected: fixture refusal"]);
      });
    }
    for (const format of ["urlencoded", "multipart", "fallback"]) for (const raw of ["true", "false", "1", "0", "invalid"]) {
      await test.step(`${format} create validates mirror=${raw}`, async () => {
        const fields = { ...common, platforms: '["instagram"]', account_ids: JSON.stringify([ACCOUNT]), media_file_ids: JSON.stringify([MEDIA]),
          instagram_share_to_story: raw, instagram_collaborators: '["doctor_one"]' };
        const body = format === "multipart" ? new FormData() : new URLSearchParams(fields);
        if (body instanceof FormData) for (const [key, value] of Object.entries(fields)) body.append(key, value);
        const before = inserted.length;
        const response = await fetch(new Request(`${ORIGIN}/functions/v1/n8n-api/api/v1/post`, { method: "POST",
          body: format === "fallback" ? body.toString() : body, headers: { "x-api-key": API_KEY, ...(format === "fallback" ? { "Content-Type": "application/unknown" } : {}) } }));
        assertEquals(response.status, raw === "invalid" ? 400 : 201, await response.clone().text());
        if (raw === "invalid") assertEquals(inserted.length, before);
        else {
          assertEquals(inserted.at(-1)!.metadata.instagram_share_to_story, raw === "true" || raw === "1");
          assertEquals(inserted.at(-1)!.metadata.instagram_collaborator, "doctor_one");
        }
      });
    }
    await test.step("a multipart file cannot silently omit the requested Story option", async () => {
      const body = new FormData();
      for (const [key, value] of Object.entries(common)) {
        body.append(key, Array.isArray(value) ? JSON.stringify(value) : value);
      }
      body.append("instagram_share_to_story", new File(["true"], "mirror.txt", { type: "text/plain" }));
      const before = inserted.length;
      const response = await fetch(`${ORIGIN}/functions/v1/n8n-api/api/v1/post`, {
        method: "POST", headers: { "x-api-key": API_KEY }, body,
      });
      assertEquals(response.status, 400);
      assertEquals(inserted.length, before);
    });
    await test.step("invalid MCP boolean cannot create a post", async () => {
      const before = inserted.length;
      const response = await invoke("tools/call", { name: "create_post", arguments: { ...common, instagram_share_to_story: "true" } });
      assert(response.error || response.result?.isError, JSON.stringify(response));
      assertEquals(inserted.length, before);
    });
    for (const invalid of [null, "true", 1, {}]) {
      await test.step(`invalid JSON mirror type ${JSON.stringify(invalid)} cannot create a post`, async () => {
        const before = inserted.length;
        const response = await fetch(`${ORIGIN}/functions/v1/n8n-api/api/v1/post`, { method: "POST",
          headers: { "x-api-key": API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ ...common, instagram_share_to_story: invalid }) });
        assertEquals(response.status, 400);
        assertEquals(inserted.length, before);
      });
    }
  } finally {
    globalThis.fetch = previousFetch;
    Deno.serve = previousServe;
    for (const [key, value] of previousEnvironment) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value); }
  }
});
