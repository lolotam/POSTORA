import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { createInstagramStoryPorts, storyJson, validStoryMedia } from "./instagramStoryDeps.ts";
import { runInstagramStory } from "./instagramStory.ts";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const media = { id: uid(5), user_id: uid(1), file_path: "https://media.invalid/story.jpg", storage_bucket: "openinary",
  mime_type: "image/jpeg", file_size: 1024, scan_state: "available", metadata: { width: 1080, height: 1920 } };

Deno.test("Story media refuses missing dimensions/duration, oversized and non-Story formats", () => {
  assertEquals(validStoryMedia(media), true);
  for (const changed of [{ metadata: null }, { scan_state: "rejected" }, { mime_type: "image/png" },
    { file_size: 9 * 1024 * 1024 }, { metadata: { width: 0, height: 1920 } },
    { mime_type: "video/mp4", metadata: { width: 1080, height: 1920 } }]) {
    assertEquals(validStoryMedia({ ...media, ...changed }), false);
  }
  const video = { ...media, mime_type: "video/mp4", metadata: { width: 1080, height: 1920, duration: 60, fps: 30, video_codec: "h264", audio_codec: "aac" } };
  assertEquals(validStoryMedia(video), true);
  assertEquals(validStoryMedia({ ...video, metadata: { ...video.metadata, duration: 61 } }), false);
});

Deno.test("Story transport deadline covers a response body that never finishes", async () => {
  const fetcher = (() => Promise.resolve({ ok: true, json: () => new Promise(() => {}) } as unknown as Response)) as typeof fetch;
  await assertRejects(() => storyJson("https://fixture.invalid", {}, 10, fetcher), Error, "story_deadline");
});

for (const loginKind of ["direct", "page_linked"]) {
  Deno.test(`registered Story adapter preserves the container across ${loginKind} create and publish claims`, async () => {
    const state: Record<string, unknown> = { id: uid(7), postId: uid(2), accountId: uid(3), resultId: uid(4), generation: 1,
      consentVersion: "version", giveUpAt: 100_000, phase: "queued", containerId: null, mediaId: null,
      mediaFileId: uid(5), authorized: true, primarySucceeded: true };
    const published: string[] = [];
    const host = loginKind === "direct" ? "graph.instagram.com" : "graph.facebook.com";
    const fetcher: typeof fetch = async (input, init) => {
      const req = new Request(input, init); const url = new URL(req.url);
      if (url.hostname === host) {
        if (req.method === "GET" && url.searchParams.get("fields") === "account_type") return Response.json({ account_type: "BUSINESS" });
        if (req.method === "GET" && url.searchParams.get("fields") === "status_code") return Response.json({ status_code: "FINISHED" });
        const body = await req.json();
        if (url.pathname.endsWith("/media")) { assertEquals(body.media_type, "STORIES"); return Response.json({ id: "3911" }); }
        if (url.pathname.endsWith("/media_publish")) { published.push(body.creation_id); return Response.json({ id: "3912" }); }
        throw new Error("unexpected provider operation");
      }
      assertEquals(url.origin, "https://storage.invalid");
      const path = url.pathname.replace("/rest/v1/", "");
      if (path.startsWith("rpc/")) {
        const args = await req.json();
        if (path === "rpc/read_instagram_story_job") return Response.json(state);
        if (path === "rpc/read_instagram_account_capability") return Response.json({
          social_account_id: uid(3), capability_present: true, login_kind: loginKind, permission_read_state: "ok",
          scopes_authoritative: true, granted_scopes: [loginKind === "direct" ? "instagram_business_content_publish" : "instagram_content_publish"],
          scopes_read_at: "2026-11-08T00:00:00Z", credential_generation: 0, has_protected_credential: false,
        });
        if (path === "rpc/checkpoint_instagram_story") {
          state.phase=args.p_phase; state.containerId=args.p_container_id; state.mediaId=args.p_media_id; return Response.json(true);
        }
        if (path === "rpc/settle_instagram_story") { assertEquals(args.p_published, true); return Response.json(true); }
        throw new Error(`unexpected RPC ${path}`);
      }
      if (path === "social_accounts" || path === "media_files") assertEquals(url.searchParams.get("user_id"), `eq.${uid(1)}`);
      if (path === "social_accounts") return Response.json({ id: uid(3), platform_user_id: "3910", access_token: "synthetic-never-used" });
      if (path === "media_files") return Response.json(media);
      if (path === "media_file_providers") return Response.json([]);
      throw new Error(`unexpected storage boundary ${path}`);
    };
    const admin = createClient("https://storage.invalid", "synthetic-fixture", { global: { fetch: fetcher }, auth: { persistSession: false } });
    const job = { id: uid(6), user_id: uid(1), kind: "instagram_story", claim_token: uid(8), attempts: 1, payload: { storyJobId: uid(7), phase: "forged" } };
    assertEquals((await runInstagramStory(job, createInstagramStoryPorts(admin, fetcher, () => 1000), 40_000)).kind, "continue");
    assertEquals(state.containerId, "3911");
    assertEquals((await runInstagramStory(job, createInstagramStoryPorts(admin, fetcher, () => 1000), 40_000)).kind, "done");
    assertEquals(published, ["3911"]);
    assertEquals(state.mediaId, "3912");
  });
}
