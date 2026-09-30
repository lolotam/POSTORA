import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  prepareTikTokReviewPublish,
  recordReviewPublishId,
  tiktokReviewSubmissionId,
} from "./tiktokReview.ts";

type AdminCall = {
  table: string;
  action: string;
  args?: unknown[];
  filters?: Record<string, unknown>;
};

function assertZeroSubmissionUpdates(calls: AdminCall[]) {
  const updateCalls = calls.filter(
    (c) => c.table === "tiktok_review_submissions" && c.action === "update",
  );
  assertEquals(updateCalls.length, 0, "Expected zero updates on tiktok_review_submissions");
}

function assertSnapshotFilters(calls: AdminCall[], expectedPostId: string, expectedUserId: string) {
  const snapshotCalls = calls.filter(
    (c) => c.table === "tiktok_review_submissions" && c.action === "eq",
  );
  const postEq = snapshotCalls.find((c) => c.args?.[0] === "post_id");
  const userEq = snapshotCalls.find((c) => c.args?.[0] === "user_id");
  assert(postEq, "Expected eq('post_id') filter on tiktok_review_submissions");
  assertEquals(postEq.args?.[1], expectedPostId);
  assert(userEq, "Expected eq('user_id') filter on tiktok_review_submissions");
  assertEquals(userEq.args?.[1], expectedUserId);
}

function assertMediaFilters(calls: AdminCall[], expectedUserId: string) {
  const mediaCalls = calls.filter(
    (c) => c.table === "media_files" && c.action === "eq",
  );
  const userEq = mediaCalls.find((c) => c.args?.[0] === "user_id");
  assert(userEq, "Expected eq('user_id') filter on media_files");
  assertEquals(userEq.args?.[1], expectedUserId);
}

async function withCreatorResponse<T>(
  response: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    if (response instanceof Error) {
      return Promise.reject(response);
    }
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const defaultSnapshot = {
  caption: "Reviewed TikTok caption",
  media_file_id: "media-uuid-1",
  media_duration_sec: 45,
  settings: {
    privacy: "PUBLIC_TO_EVERYONE",
    allowComment: true,
    allowDuet: false,
    allowStitch: false,
    disclose: false,
    yourBrand: false,
    brandedContent: false,
    aiGenerated: false,
  },
};

const defaultConsent = { social_account_id: "acct-uuid-1", mode: "now", scheduled_at: null };

const defaultPost = {
  id: "post-uuid-1",
  user_id: "user-uuid-1",
  caption: "Reviewed TikTok caption",
  media_file_ids: ["media-uuid-1"],
  scheduled_at: null as string | null,
  metadata: {
    tiktok_review_submission_id: "sub-uuid-1",
    tiktok_privacy_level: "SELF_ONLY", // Ignored: snapshot settings win
    tiktok_allow_comment: false,
  },
};

function createFakeAdmin(options: {
  submission?: { data: unknown; error: unknown };
  media?: { data: unknown; error: unknown };
  claim?: { data: unknown; error: unknown };
  recordPublishId?: { data?: unknown; error?: unknown };
} = {}) {
  const calls: AdminCall[] = [];
  const client = {
    from: (table: string) => {
      const currentTable = table;
      const filters: Record<string, unknown> = {};
      let updatePayload: unknown = null;

      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: (cols?: string) => {
          calls.push({ table: currentTable, action: "select", args: [cols], filters });
          return builder;
        },
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          calls.push({ table: currentTable, action: "eq", args: [col, val], filters });
          return builder;
        },
        in: (col: string, vals: unknown) => {
          filters[`in:${col}`] = vals;
          calls.push({ table: currentTable, action: "in", args: [col, vals], filters });
          return builder;
        },
        is: (col: string, val: unknown) => {
          filters[`is:${col}`] = val;
          calls.push({ table: currentTable, action: "is", args: [col, val], filters });
          return builder;
        },
        update: (values: unknown) => {
          updatePayload = values;
          calls.push({ table: currentTable, action: "update", args: [values], filters });
          return builder;
        },
        maybeSingle: () => {
          calls.push({ table: currentTable, action: "maybeSingle", filters });
          if (currentTable === "tiktok_review_submissions") {
            return Promise.resolve(
              options.submission ?? {
                data: { ...defaultConsent, snapshot: defaultSnapshot },
                error: null,
              },
            );
          }
          if (currentTable === "media_files") {
            return Promise.resolve(
              options.media ?? {
                data: { metadata: { duration: 45 } },
                error: null,
              },
            );
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (val: unknown) => void, reject: (err: unknown) => void) => {
          let result: unknown;
          if (currentTable === "tiktok_review_submissions" && updatePayload) {
            const payload = updatePayload as Record<string, unknown>;
            if ("provider_publish_id" in payload) {
              result = options.recordPublishId !== undefined
                ? { data: options.recordPublishId.data ?? null, error: options.recordPublishId.error ?? null }
                : { data: [{ id: "sub-123" }], error: null };
            } else {
              result = options.claim ?? { data: [{ id: "sub-uuid-1" }], error: null };
            }
          } else {
            result = { data: null, error: null };
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
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
  await withCreatorResponse(new Error("Network connection lost"), async () => {
    const { client: admin, calls } = createFakeAdmin({});
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          accountId: "acct-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:CREATOR_INFO_UNAVAILABLE",
    );
    assertZeroSubmissionUpdates(calls);
  });
});

Deno.test("creator_info posting-blocked code rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:POSTING_BLOCKED", async () => {
  await withCreatorResponse(
    { error: { code: "spam_risk_too_many_posts" } },
    async () => {
      const { client: admin, calls } = createFakeAdmin({});
      await assertRejects(
        () =>
          prepareTikTokReviewPublish({
            admin,
            accessToken: "token-1",
            submissionId: "sub-uuid-1",
            accountId: "acct-uuid-1",
            post: defaultPost,
          }),
        Error,
        "TIKTOK_REVIEW_NEEDS_ATTENTION:POSTING_BLOCKED",
      );
      assertZeroSubmissionUpdates(calls);
    },
  );
});

Deno.test("creator_info access_token_invalid and scope_not_authorized both reject with reconnect message", async () => {
  const invalidCodes = ["access_token_invalid", "scope_not_authorized"];
  for (const code of invalidCodes) {
    await withCreatorResponse({ error: { code } }, async () => {
      const { client: admin, calls } = createFakeAdmin({});
      await assertRejects(
        () =>
          prepareTikTokReviewPublish({
            admin,
            accessToken: "token-bad",
            submissionId: "sub-uuid-1",
            accountId: "acct-uuid-1",
            post: defaultPost,
          }),
        Error,
        "TikTok session expired. Please reconnect your TikTok account.",
      );
      assertZeroSubmissionUpdates(calls);
    });
  }
});

Deno.test("submission read error rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_READ_FAILED", async () => {
  await withCreatorResponse(validCreatorResponse, async () => {
    const { client: admin, calls } = createFakeAdmin({
      submission: { data: null, error: { message: "db query timeout" } },
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          accountId: "acct-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_READ_FAILED",
    );
    assertZeroSubmissionUpdates(calls);
    assertSnapshotFilters(calls, defaultPost.id, defaultPost.user_id);
  });
});

Deno.test("missing submission row rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_NOT_FOUND", async () => {
  await withCreatorResponse(validCreatorResponse, async () => {
    const { client: admin, calls } = createFakeAdmin({
      submission: { data: null, error: null },
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-1",
          submissionId: "missing-sub",
          accountId: "acct-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_NOT_FOUND",
    );
    assertZeroSubmissionUpdates(calls);
    assertSnapshotFilters(calls, defaultPost.id, defaultPost.user_id);
  });
});

Deno.test("prepareTikTokReviewPublish: SNAPSHOT_MISMATCH when post.caption or post.media_file_ids[0] differs from snapshot", async () => {
  await withCreatorResponse(validCreatorResponse, async () => {
    // 1. Post caption modified after review
    const { client: adminDiffCaption, calls: callsDiffCaption } = createFakeAdmin({
      submission: {
        data: { ...defaultConsent, snapshot: { ...defaultSnapshot, caption: "Original approved caption" } },
        error: null,
      },
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin: adminDiffCaption,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          accountId: "acct-uuid-1",
          post: { ...defaultPost, caption: "Modified unapproved caption" },
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:SNAPSHOT_MISMATCH",
    );
    assertZeroSubmissionUpdates(callsDiffCaption);
    assertSnapshotFilters(callsDiffCaption, defaultPost.id, defaultPost.user_id);

    // 2. Post media file modified after review
    const { client: adminDiffMedia, calls: callsDiffMedia } = createFakeAdmin({
      submission: {
        data: { ...defaultConsent, snapshot: { ...defaultSnapshot, media_file_id: "media-uuid-1" } },
        error: null,
      },
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin: adminDiffMedia,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          accountId: "acct-uuid-1",
          post: { ...defaultPost, media_file_ids: ["media-uuid-DIFFERENT"] },
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:SNAPSHOT_MISMATCH",
    );
    assertZeroSubmissionUpdates(callsDiffMedia);
    assertSnapshotFilters(callsDiffMedia, defaultPost.id, defaultPost.user_id);

    // 3. Snapshot caption is not a string
    const { client: adminNonStringCaption, calls: callsNonStringCaption } = createFakeAdmin({
      submission: {
        data: { ...defaultConsent, snapshot: { ...defaultSnapshot, caption: 12345 } },
        error: null,
      },
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin: adminNonStringCaption,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          accountId: "acct-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:SNAPSHOT_MISMATCH",
    );
    assertZeroSubmissionUpdates(callsNonStringCaption);
    assertSnapshotFilters(callsNonStringCaption, defaultPost.id, defaultPost.user_id);

    // 4. Post has no media but snapshot expected media
    const { client: adminNullMedia, calls: callsNullMedia } = createFakeAdmin({
      submission: {
        data: { ...defaultConsent, snapshot: { ...defaultSnapshot, media_file_id: "media-uuid-1" } },
        error: null,
      },
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin: adminNullMedia,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          accountId: "acct-uuid-1",
          post: { ...defaultPost, media_file_ids: null },
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:SNAPSHOT_MISMATCH",
    );
    assertZeroSubmissionUpdates(callsNullMedia);
    assertSnapshotFilters(callsNullMedia, defaultPost.id, defaultPost.user_id);
  });
});

Deno.test("privacy required when snapshot settings are missing or invalid", async () => {
  await withCreatorResponse(validCreatorResponse, async () => {
    const { client: admin, calls } = createFakeAdmin({
      submission: {
        data: { ...defaultConsent, snapshot: { ...defaultSnapshot, settings: null } },
        error: null,
      },
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          accountId: "acct-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:PRIVACY_REQUIRED",
    );
    assertZeroSubmissionUpdates(calls);
    assertSnapshotFilters(calls, defaultPost.id, defaultPost.user_id);
  });
});

Deno.test("media_files read error rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:MEDIA_READ_FAILED", async () => {
  await withCreatorResponse(validCreatorResponse, async () => {
    const { client: admin, calls } = createFakeAdmin({
      media: { data: null, error: { message: "db media query error" } },
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-1",
          submissionId: "sub-uuid-1",
          accountId: "acct-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:MEDIA_READ_FAILED",
    );
    assertZeroSubmissionUpdates(calls);
    assertSnapshotFilters(calls, defaultPost.id, defaultPost.user_id);
    assertMediaFilters(calls, defaultPost.user_id);
  });
});

Deno.test("privacy no longer offered by creator rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:PRIVACY_NOT_OFFERED without altering settings", async () => {
  await withCreatorResponse(
    {
      data: {
        privacy_level_options: ["SELF_ONLY"],
        max_video_post_duration_sec: 600,
      },
      error: { code: "ok" },
    },
    async () => {
      const { client: admin, calls } = createFakeAdmin({});
      await assertRejects(
        () =>
          prepareTikTokReviewPublish({
            admin,
            accessToken: "token-1",
            submissionId: "sub-uuid-1",
            accountId: "acct-uuid-1",
            post: defaultPost,
          }),
        Error,
        "TIKTOK_REVIEW_NEEDS_ATTENTION:PRIVACY_NOT_OFFERED",
      );
      assertZeroSubmissionUpdates(calls);
      assertSnapshotFilters(calls, defaultPost.id, defaultPost.user_id);
      assertMediaFilters(calls, defaultPost.user_id);
    },
  );
});

Deno.test("media_files duration overrides snapshot duration", async () => {
  await withCreatorResponse(
    {
      data: {
        privacy_level_options: ["PUBLIC_TO_EVERYONE"],
        max_video_post_duration_sec: 50,
      },
      error: { code: "ok" },
    },
    async () => {
      const { client: admin, calls } = createFakeAdmin({
        submission: {
          data: { ...defaultConsent, snapshot: { ...defaultSnapshot, media_duration_sec: 40 } },
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
            accountId: "acct-uuid-1",
            post: defaultPost,
          }),
        Error,
        "TIKTOK_REVIEW_NEEDS_ATTENTION:DURATION_EXCEEDED",
      );
      assertZeroSubmissionUpdates(calls);
      assertSnapshotFilters(calls, defaultPost.id, defaultPost.user_id);
      assertMediaFilters(calls, defaultPost.user_id);
    },
  );
});

Deno.test("atomic claim update is sent with filters id/post_id/user_id, dispatch_state in [dispatching, scheduled], provider_publish_id is null", async () => {
  await withCreatorResponse(validCreatorResponse, async () => {
    const { client: admin, calls } = createFakeAdmin({});
    await prepareTikTokReviewPublish({
      admin,
      accessToken: "token-valid",
      submissionId: "sub-uuid-1",
      accountId: "acct-uuid-1",
      post: defaultPost,
    });

    const updateCall = calls.find(
      (c) => c.table === "tiktok_review_submissions" && c.action === "update",
    );
    assert(updateCall, "Expected update call on tiktok_review_submissions");
    assertEquals(updateCall.args?.[0], { dispatch_state: "publishing" });
    assertEquals(updateCall.filters?.["id"], "sub-uuid-1");
    assertEquals(updateCall.filters?.["post_id"], defaultPost.id);
    assertEquals(updateCall.filters?.["user_id"], defaultPost.user_id);
    assertEquals(updateCall.filters?.["in:dispatch_state"], ["dispatching", "scheduled"]);
    assertEquals(updateCall.filters?.["is:provider_publish_id"], null);
  });
});

Deno.test("zero claimed rows rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:ALREADY_DISPATCHED and NO postInfo returned", async () => {
  await withCreatorResponse(validCreatorResponse, async () => {
    const { client: admin } = createFakeAdmin({
      claim: { data: [], error: null }, // 0 rows claimed
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-valid",
          submissionId: "sub-uuid-1",
          accountId: "acct-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:ALREADY_DISPATCHED",
    );
  });
});

Deno.test("claim error rejects with TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_READ_FAILED", async () => {
  await withCreatorResponse(validCreatorResponse, async () => {
    const { client: admin } = createFakeAdmin({
      claim: { data: null, error: { message: "db update failure" } },
    });
    await assertRejects(
      () =>
        prepareTikTokReviewPublish({
          admin,
          accessToken: "token-valid",
          submissionId: "sub-uuid-1",
          accountId: "acct-uuid-1",
          post: defaultPost,
        }),
      Error,
      "TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_READ_FAILED",
    );
  });
});

Deno.test("valid input returns postInfo matching snapshot settings with explicit false booleans, ignoring post.metadata", async () => {
  await withCreatorResponse(validCreatorResponse, async () => {
    const { client: admin } = createFakeAdmin({});
    const result = await prepareTikTokReviewPublish({
      admin,
      accessToken: "token-valid",
      submissionId: "sub-uuid-1",
      accountId: "acct-uuid-1",
      post: defaultPost,
    });

    assertEquals(result.postInfo.title, defaultSnapshot.caption);
    assertEquals(result.postInfo.privacy_level, "PUBLIC_TO_EVERYONE");
    assertEquals(result.postInfo.disable_comment, false);
    assertEquals(result.postInfo.disable_duet, true);
    assertEquals(result.postInfo.disable_stitch, true);
    assertEquals(result.postInfo.brand_organic_toggle, false);
    assertEquals(result.postInfo.brand_content_toggle, false);
    assertEquals(result.postInfo.is_aigc, false);
  });
});

Deno.test("recordReviewPublishId filters on dispatch_state 'publishing' and 'unknown' and provider_publish_id null and throws on error or row count !== 1", async () => {
  // 1. Success case: verify filters and update payload
  const { client: adminSuccess, calls } = createFakeAdmin({});
  await recordReviewPublishId(adminSuccess, {
    submissionId: "sub-123",
    postId: "post-456",
    userId: "user-789",
    publishId: "v_pub_tiktok_abc",
  });

  const updateCall = calls.find(
    (c) => c.table === "tiktok_review_submissions" && c.action === "update",
  );
  assert(updateCall, "Expected update call in recordReviewPublishId");
  assertEquals(updateCall.args?.[0], { provider_publish_id: "v_pub_tiktok_abc" });
  assertEquals(updateCall.filters?.["id"], "sub-123");
  assertEquals(updateCall.filters?.["post_id"], "post-456");
  assertEquals(updateCall.filters?.["user_id"], "user-789");
  assertEquals(updateCall.filters?.["in:dispatch_state"], ["publishing", "unknown"]);
  assertEquals(updateCall.filters?.["is:provider_publish_id"], null);

  const selectCall = calls.find(
    (c) => c.table === "tiktok_review_submissions" && c.action === "select",
  );
  assert(selectCall, "Expected select('id') call in recordReviewPublishId");
  assertEquals(selectCall.args?.[0], "id");

  // 2. Error case: throws tiktok_review_publish_id_record_failed on DB error
  const { client: adminError } = createFakeAdmin({
    recordPublishId: { error: { message: "database deadlock" } },
  });
  await assertRejects(
    () =>
      recordReviewPublishId(adminError, {
        submissionId: "sub-123",
        postId: "post-456",
        userId: "user-789",
        publishId: "v_pub_tiktok_abc",
      }),
    Error,
    "tiktok_review_publish_id_record_failed",
  );

  // 3. Row count cases: throws when update did not change exactly one row
  const rowCountCases = [
    { name: "zero rows updated", data: [] },
    { name: "null data returned", data: null },
    { name: "multiple rows updated", data: [{ id: "sub-1" }, { id: "sub-2" }] },
  ];
  for (const tc of rowCountCases) {
    const { client: adminCount } = createFakeAdmin({
      recordPublishId: { data: tc.data, error: null },
    });
    await assertRejects(
      () =>
        recordReviewPublishId(adminCount, {
          submissionId: "sub-123",
          postId: "post-456",
          userId: "user-789",
          publishId: "v_pub_tiktok_abc",
        }),
      Error,
      "tiktok_review_publish_id_record_failed",
      `Expected reject for: ${tc.name}`,
    );
  }
});

Deno.test("a post moved to another account or publish time after consent is refused before the claim", async () => {
  const scheduledAt = "2026-10-05T09:00:00+00:00";
  const cases = [
    { name: "History retry switched the account", consent: defaultConsent, accountId: "acct-uuid-2", postScheduledAt: null },
    { name: "a publish-now post was scheduled later", consent: defaultConsent, accountId: "acct-uuid-1", postScheduledAt: scheduledAt },
    {
      name: "Calendar rescheduled the approved time",
      consent: { ...defaultConsent, mode: "scheduled", scheduled_at: scheduledAt },
      accountId: "acct-uuid-1",
      postScheduledAt: "2026-10-06T09:00:00+00:00",
    },
  ];
  for (const testCase of cases) {
    await withCreatorResponse(validCreatorResponse, async () => {
      const { client, calls } = createFakeAdmin({
        submission: { data: { ...testCase.consent, snapshot: defaultSnapshot }, error: null },
      });
      await assertRejects(
        () =>
          prepareTikTokReviewPublish({
            admin: client,
            accessToken: "token-1",
            submissionId: "sub-uuid-1",
            accountId: testCase.accountId,
            post: { ...defaultPost, scheduled_at: testCase.postScheduledAt },
          }),
        Error,
        "TIKTOK_REVIEW_NEEDS_ATTENTION:SNAPSHOT_MISMATCH",
        testCase.name,
      );
      assertZeroSubmissionUpdates(calls);
    });
  }
});

Deno.test("a scheduled post publishes at its approved time whatever the timestamp spelling", async () => {
  await withCreatorResponse(validCreatorResponse, async () => {
    const { client } = createFakeAdmin({
      submission: {
        data: { ...defaultConsent, mode: "scheduled", scheduled_at: "2026-10-05T09:00:00+00:00", snapshot: defaultSnapshot },
        error: null,
      },
    });
    const prepared = await prepareTikTokReviewPublish({
      admin: client,
      accessToken: "token-1",
      submissionId: "sub-uuid-1",
      accountId: "acct-uuid-1",
      post: { ...defaultPost, scheduled_at: "2026-10-05T09:00:00.000Z" },
    });
    assertEquals(prepared.postInfo.privacy_level, "PUBLIC_TO_EVERYONE");
  });
});
