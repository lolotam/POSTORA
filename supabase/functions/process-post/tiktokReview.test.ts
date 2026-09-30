import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  prepareTikTokReviewPublish,
  tiktokReviewSubmissionId,
} from "./tiktokReview.ts";
import { buildTikTokPostInfo } from "../_shared/tiktokPostInfo.ts";

function createFakeAdmin(handlers: {
  submission?: { data: unknown; error: unknown };
  media?: { data: unknown; error: unknown };
}) {
  const client = {
    from: (table: string) => {
      const currentTable = table;
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => {
          if (currentTable === "tiktok_review_submissions") {
            return Promise.resolve(
              handlers.submission ?? {
                data: { snapshot: { media_duration_sec: 45 } },
                error: null,
              },
            );
          }
          if (currentTable === "media_files") {
            return Promise.resolve(
              handlers.media ?? {
                data: { metadata: { duration: 45 } },
                error: null,
              },
            );
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
  return client as unknown as SupabaseClient;
}

const validCreatorResponse = {
  data: {
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
    max_video_post_duration_sec: 600,
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: false,
  },
  error: { code: "ok" },
};

const defaultPost = {
  id: "post-uuid-1",
  user_id: "user-uuid-1",
  caption: "Reviewed TikTok caption",
  media_file_ids: ["media-uuid-1"],
  metadata: {
    tiktok_review_submission_id: "sub-uuid-1",
    tiktok_privacy_level: "PUBLIC_TO_EVERYONE",
    tiktok_allow_comment: true,
    tiktok_allow_duet: false,
    tiktok_allow_stitch: false,
    tiktok_disclose_content: false,
    tiktok_your_brand: false,
    tiktok_branded_content: false,
    tiktok_ai_generated: false,
  },
};

Deno.test("tiktokReviewSubmissionId helper returns string or null appropriately", () => {
  assertEquals(tiktokReviewSubmissionId(null), null);
  assertEquals(tiktokReviewSubmissionId(undefined), null);
  assertEquals(tiktokReviewSubmissionId([]), null);
  assertEquals(tiktokReviewSubmissionId({}), null);
  assertEquals(
    tiktokReviewSubmissionId({ tiktok_review_submission_id: "" }),
    null,
  );
  assertEquals(
    tiktokReviewSubmissionId({ tiktok_review_submission_id: 12345 }),
    null,
  );
  assertEquals(
    tiktokReviewSubmissionId({ tiktok_review_submission_id: "sub-987" }),
    "sub-987",
  );
});

Deno.test("creator_info network failure rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:CREATOR_INFO_UNAVAILABLE", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("Network connection lost"));
  try {
    const admin = createFakeAdmin({});
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:CREATOR_INFO_UNAVAILABLE",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("creator_info posting-blocked code rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:POSTING_BLOCKED", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { code: "spam_risk_too_many_posts" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  try {
    const admin = createFakeAdmin({});
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:POSTING_BLOCKED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("creator_info access_token_invalid rejects with TikTok session expired reconnect message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { code: "access_token_invalid" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  try {
    const admin = createFakeAdmin({});
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-expired",
          submissionId: "sub-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TikTok session expired. Please reconnect your TikTok account.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("privacy no longer offered by creator rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:PRIVACY_NOT_OFFERED without altering settings", async () => {
  const originalFetch = globalThis.fetch;
  // Creator only offers SELF_ONLY
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            privacy_level_options: ["SELF_ONLY"],
            max_video_post_duration_sec: 600,
          },
          error: { code: "ok" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  try {
    const admin = createFakeAdmin({});
    // Post has PUBLIC_TO_EVERYONE
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:PRIVACY_NOT_OFFERED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("missing submission row rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_NOT_FOUND", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(validCreatorResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  try {
    const admin = createFakeAdmin({
      submission: { data: null, error: null },
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-1",
          submissionId: "missing-sub",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_NOT_FOUND",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("media_files duration overrides snapshot duration", async () => {
  const originalFetch = globalThis.fetch;
  // Max duration is 50 seconds
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            privacy_level_options: ["PUBLIC_TO_EVERYONE"],
            max_video_post_duration_sec: 50,
          },
          error: { code: "ok" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  try {
    // Snapshot duration is 40s (which would pass <= 50)
    // But media_files.metadata.duration is 55s (which exceeds 50)
    const admin = createFakeAdmin({
      submission: {
        data: { snapshot: { media_duration_sec: 40 } },
        error: null,
      },
      media: {
        data: { metadata: { duration: 55 } },
        error: null,
      },
    });

    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:DURATION_EXCEEDED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("valid input returns postInfo matching buildTikTokPostInfo with explicit false booleans", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(validCreatorResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  try {
    const admin = createFakeAdmin({});
    const result = await prepareTikTokReviewPublish({
      admin,
      accessToken: "token-valid",
      submissionId: "sub-uuid-1",
      post: defaultPost,
    });

    const expected = buildTikTokPostInfo(defaultPost.caption, {
      privacy: "PUBLIC_TO_EVERYONE",
      allowComment: true,
      allowDuet: false,
      allowStitch: false,
      disclose: false,
      yourBrand: false,
      brandedContent: false,
      aiGenerated: false,
    });

    assertEquals(result.postInfo, expected);
    assertEquals(result.postInfo.disable_comment, false);
    assertEquals(result.postInfo.disable_duet, true);
    assertEquals(result.postInfo.disable_stitch, true);
    assertEquals(result.postInfo.brand_organic_toggle, false);
    assertEquals(result.postInfo.brand_content_toggle, false);
    assertEquals(result.postInfo.is_aigc, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
