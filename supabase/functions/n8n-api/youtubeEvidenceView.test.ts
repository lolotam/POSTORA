import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  hasDisallowedYoutubeCaptionInput,
  sanitizePostForPublicRead,
  stripYoutubeCaptionFromMetadata,
  youtubeEvidenceOf,
} from "./youtubeEvidenceView.ts";
import { handleCreatePost, handleGetPostById, handleGetPosts } from "./index.ts";

Deno.test("settled evidence is allowlisted with honest unknown where unobserved", () => {
  const view = youtubeEvidenceOf({
    youtube_video_id: "AbcD1234eFg",
    access_token: "must-not-leak",
    youtube_publish_evidence: {
      requested_privacy: "private",
      effective_privacy: "unknown",
      thumbnail: { state: "applied", reason: null },
      first_comment: { state: "unknown", reason: "answer_lost" },
      provider_body: { mustNotLeak: true },
    },
  }, "youtube");
  assertEquals(view, {
    requested_privacy: "private",
    effective_privacy: "unknown",
    thumbnail: { state: "applied", reason: null },
    first_comment: { state: "unknown", reason: "answer_lost" },
    playlist: { state: "not_requested", reason: null },
    caption: { state: "not_requested", reason: null },
  });
  assertEquals(JSON.stringify(view).includes("must-not-leak"), false);
});

Deno.test("each destination is viewed independently and a disconnected one stays without evidence", () => {
  const destinations = [
    { platform: "youtube", response_data: { youtube_publish_evidence: {
      requested_privacy: "unlisted", effective_privacy: "unlisted",
      thumbnail: { state: "failed", reason: "refused" },
      first_comment: { state: "not_requested", reason: null },
    } } },
    { platform: "youtube", response_data: { youtube_video_id: "only-a-receipt" } },
    { platform: "instagram", response_data: { youtube_publish_evidence: { requested_privacy: "public" } } },
  ];
  const views = destinations.map((row) => youtubeEvidenceOf(row.response_data, row.platform));
  assertEquals(views[0]?.first_comment, { state: "not_requested", reason: null });
  assertEquals(views[0]?.thumbnail, { state: "failed", reason: "refused" });
  assertEquals(views[0]?.caption, { state: "not_requested", reason: null });
  assertEquals(views[1], undefined);
  assertEquals(views[2], undefined);
});

Deno.test("malformed states fall back to unknown instead of claiming success", () => {
  const view = youtubeEvidenceOf({
    youtube_publish_evidence: {
      requested_privacy: "public",
      effective_privacy: "malicious",
      thumbnail: { state: "applied", reason: "unexpected-reason" },
      first_comment: { state: "applied" },
    },
  }, "youtube");
  assertEquals(view?.effective_privacy, "unknown");
  assertEquals(view?.thumbnail, { state: "applied", reason: null });
  assertEquals(view?.first_comment, { state: "applied", reason: null });
  assertEquals(view?.playlist, { state: "not_requested", reason: null });
  assertEquals(view?.caption, { state: "not_requested", reason: null });
});

Deno.test("playlist evidence allows not_owned and quota_budget reasons and defaults absent key to not_requested", () => {
  const withPlaylist = youtubeEvidenceOf({
    youtube_publish_evidence: {
      requested_privacy: "private",
      effective_privacy: "private",
      thumbnail: { state: "not_requested", reason: null },
      first_comment: { state: "not_requested", reason: null },
      playlist: { state: "skipped", reason: "quota_budget" },
    },
  }, "youtube");
  assertEquals(withPlaylist?.playlist, { state: "skipped", reason: "quota_budget" });

  const notOwned = youtubeEvidenceOf({
    youtube_publish_evidence: {
      requested_privacy: "private",
      effective_privacy: "private",
      thumbnail: { state: "not_requested", reason: null },
      first_comment: { state: "not_requested", reason: null },
      playlist: { state: "failed", reason: "not_owned" },
    },
  }, "youtube");
  assertEquals(notOwned?.playlist, { state: "failed", reason: "not_owned" });
});

Deno.test("caption evidence allowlists state, reasons, language, format, byte_length and never leaks content", () => {
  const captionReasons = [
    { state: "skipped", reason: "invalid_caption" },
    { state: "skipped", reason: "missing_scope" },
    { state: "skipped", reason: "rate_limited" },
    { state: "skipped", reason: "quota_budget" },
    { state: "skipped", reason: "no_time" },
    { state: "skipped", reason: "authority_lost" },
    { state: "failed", reason: "conflict" },
    { state: "failed", reason: "refused" },
    { state: "unknown", reason: "answer_lost" },
  ];

  for (const expected of captionReasons) {
    const view = youtubeEvidenceOf({
      youtube_publish_evidence: {
        requested_privacy: "private",
        effective_privacy: "private",
        thumbnail: { state: "not_requested", reason: null },
        first_comment: { state: "not_requested", reason: null },
        playlist: { state: "not_requested", reason: null },
        caption: {
          ...expected,
          language: "ar",
          format: "srt",
          byte_length: 1024,
          content: "SECRET_CAPTION_TEXT_MUST_NEVER_LEAK",
        },
      },
    }, "youtube");

    assertEquals(view?.caption, {
      ...expected,
      language: "ar",
      format: "srt",
      byte_length: 1024,
    });
    assertEquals(JSON.stringify(view).includes("SECRET_CAPTION_TEXT_MUST_NEVER_LEAK"), false);
  }

  // Invalid language/format/byte_length and unknown reason are dropped while valid state remains
  const malformedCaptionMeta = youtubeEvidenceOf({
    youtube_publish_evidence: {
      requested_privacy: "private",
      effective_privacy: "private",
      thumbnail: { state: "not_requested", reason: null },
      first_comment: { state: "not_requested", reason: null },
      playlist: { state: "not_requested", reason: null },
      caption: {
        state: "applied",
        reason: "unlisted_reason",
        language: "bad_language_tag!",
        format: "ass",
        byte_length: 999_999_999,
        content: "SECRET_CAPTION_TEXT_MUST_NEVER_LEAK",
      },
    },
  }, "youtube");

  assertEquals(malformedCaptionMeta?.caption, {
    state: "applied",
    reason: null,
  });
  assertEquals(
    JSON.stringify(malformedCaptionMeta).includes("SECRET_CAPTION_TEXT_MUST_NEVER_LEAK"),
    false,
  );
});

Deno.test("hasDisallowedYoutubeCaptionInput and handleCreatePost reject youtube_caption on create", async () => {
  assertEquals(hasDisallowedYoutubeCaptionInput(null), false);
  assertEquals(hasDisallowedYoutubeCaptionInput({ platforms: ["youtube"] }), false);
  assertEquals(hasDisallowedYoutubeCaptionInput({ platforms: ["youtube"], youtube_caption: null }), true);
  assertEquals(hasDisallowedYoutubeCaptionInput({ platforms: ["youtube"], metadata: { youtube_caption: null } }), true);
  assertEquals(
    hasDisallowedYoutubeCaptionInput({
      platforms: ["youtube"],
      youtube_caption: { language: "en", name: "English", format: "srt", content: "1\n00:00:01,000 --> 00:00:02,000\nHi" },
    }),
    true,
  );
  assertEquals(
    hasDisallowedYoutubeCaptionInput({
      platforms: ["youtube"],
      metadata: {
        youtube_caption: { language: "en", name: "English", format: "vtt", content: "WEBVTT\n\n00:01.000 --> 00:02.000\nHi" },
      },
    }),
    true,
  );

  const insertedTables: string[] = [];
  const stubSupabase = {
    from: (table: string) => ({
      insert: (_row: Record<string, unknown>) => {
        insertedTables.push(table);
        return Promise.resolve({ error: null });
      },
    }),
  };

  const req = new Request("https://api.postora.cloud/functions/v1/n8n-api/api/v1/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  const response = await handleCreatePost(
    req,
    stubSupabase,
    "0ee00001-0000-4000-8000-000000000001",
    {
      platforms: ["youtube"],
      caption: "Video title",
      youtube_caption: {
        language: "en",
        name: "English",
        format: "srt",
        content: "1\n00:00:01,000 --> 00:00:02,000\nShould be rejected",
      },
    },
    "UTC",
  );

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body, {
    error: "youtube_caption is not supported via the public API",
    code: "youtube_caption_not_supported",
  });
  // Only system_logs refusal audit was written; posts table was never touched.
  assertEquals(insertedTables, ["system_logs"]);
});

Deno.test("stripYoutubeCaptionFromMetadata, sanitizePostForPublicRead, handleGetPosts and handleGetPostById strip youtube_caption.content on read", async () => {
  const secretMarker = "SECRET_CAPTION_FILE_TEXT_DO_NOT_RETURN";
  const rawMetadata: {
    youtube_title: string;
    youtube_caption: {
      language: string;
      name: string;
      format: "srt" | "vtt";
      content?: string;
    };
  } = {
    youtube_title: "My video",
    youtube_caption: {
      language: "en",
      name: "English",
      format: "vtt",
      content: secretMarker,
    },
  };

  const strippedMeta = stripYoutubeCaptionFromMetadata(rawMetadata);
  assertEquals(strippedMeta, {
    youtube_title: "My video",
    youtube_caption: {
      language: "en",
      name: "English",
      format: "vtt",
    },
  });
  assertEquals(JSON.stringify(strippedMeta).includes(secretMarker), false);

  const rawPost = {
    id: "post-1",
    caption: "Hello",
    platforms: ["youtube"],
    status: "scheduled",
    scheduled_at: "2026-12-01T12:00:00Z",
    posted_at: null,
    created_at: "2026-11-27T12:00:00Z",
    source: "web",
    metadata: rawMetadata,
    platform_posts: [
      {
        id: "pp-1",
        platform: "youtube",
        status: "success",
        platform_post_id: "vid123",
        platform_post_url: "https://youtube.com/watch?v=vid123",
        error_message: null,
        posted_at: "2026-11-27T12:01:00Z",
        social_account_id: "acc-1",
        response_data: {
          youtube_publish_evidence: {
            requested_privacy: "private",
            effective_privacy: "private",
            thumbnail: { state: "not_requested", reason: null },
            first_comment: { state: "not_requested", reason: null },
            playlist: { state: "not_requested", reason: null },
            caption: {
              state: "applied",
              reason: null,
              language: "en",
              format: "vtt",
              byte_length: 42,
              content: secretMarker,
            },
          },
        },
      },
    ],
  };

  const sanitizedPost = sanitizePostForPublicRead(rawPost);
  assertEquals(JSON.stringify(sanitizedPost).includes(secretMarker), false);
  assertEquals(sanitizedPost.metadata.youtube_caption, {
    language: "en",
    name: "English",
    format: "vtt",
  });

  // Verify handleGetPostById never leaks caption content
  const stubGetByIdSupabase = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col1: string, _val1: unknown) => ({
          eq: (_col2: string, _val2: unknown) => ({
            maybeSingle: () => Promise.resolve({ data: rawPost, error: null }),
          }),
        }),
      }),
    }),
  };

  const getByIdReq = new Request("https://api.postora.cloud/functions/v1/n8n-api/api/v1/post/post-1", {
    method: "GET",
  });
  const getByIdRes = await handleGetPostById(
    getByIdReq,
    stubGetByIdSupabase,
    "0ee00001-0000-4000-8000-000000000001",
    "post-1",
  );
  assertEquals(getByIdRes.status, 200);
  const getByIdText = await getByIdRes.text();
  assertEquals(getByIdText.includes(secretMarker), false);
  const getByIdJson = JSON.parse(getByIdText);
  assertEquals(getByIdJson.post.platform_results[0].youtube_publish_evidence.caption, {
    state: "applied",
    reason: null,
    language: "en",
    format: "vtt",
    byte_length: 42,
  });

  // Verify handleGetPosts strips content from any post row carrying metadata
  const stubGetPostsSupabase = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: unknown) => ({
          order: (_orderCol: string, _opts: unknown) => ({
            range: (_from: number, _to: number) => Promise.resolve({ data: [rawPost], error: null }),
          }),
        }),
      }),
    }),
  };
  const getPostsUrl = new URL("https://api.postora.cloud/functions/v1/n8n-api/api/v1/posts");
  const getPostsReq = new Request(getPostsUrl.toString(), { method: "GET" });
  const getPostsRes = await handleGetPosts(
    getPostsReq,
    stubGetPostsSupabase,
    "0ee00001-0000-4000-8000-000000000001",
    getPostsUrl,
  );
  assertEquals(getPostsRes.status, 200);
  const getPostsText = await getPostsRes.text();
  assertEquals(getPostsText.includes(secretMarker), false);
  const getPostsJson = JSON.parse(getPostsText);
  assertEquals(getPostsJson.posts[0].metadata.youtube_caption, {
    language: "en",
    name: "English",
    format: "vtt",
  });
});
