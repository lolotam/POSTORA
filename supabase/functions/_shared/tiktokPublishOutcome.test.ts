import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  applyPendingWebhookEvents,
  applyTikTokPublishOutcome,
  type TikTokOutcome,
} from "./tiktokPublishOutcome.ts";

type Call = { name: string; args: unknown[] };

function createFakeSupabase(handlers: {
  platformPostsSelect?: () => Promise<{ data: unknown; error: unknown }>;
  platformPostsUpdate?: (values: unknown) => Promise<{ data: unknown; error: unknown }>;
  webhookEventsSelect?: () => Promise<{ data: unknown; error: unknown }>;
  webhookEventsUpdate?: (values: unknown) => Promise<{ data: unknown; error: unknown }>;
  rpc?: (name: string, params: unknown) => Promise<{ data: unknown; error: unknown }>;
}) {
  const calls: Call[] = [];
  const client: Record<string, unknown> = {
    from: (table: string) => {
      calls.push({ name: `from:${table}`, args: [] });
      const currentTable = table;
      let updateValues: unknown = null;

      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: (cols: string) => {
          calls.push({ name: `${currentTable}:select`, args: [cols] });
          return builder;
        },
        eq: (col: string, val: unknown) => {
          calls.push({ name: `${currentTable}:eq`, args: [col, val] });
          return builder;
        },
        is: (col: string, val: unknown) => {
          calls.push({ name: `${currentTable}:is`, args: [col, val] });
          return builder;
        },
        order: (col: string, opts: unknown) => {
          calls.push({ name: `${currentTable}:order`, args: [col, opts] });
          return builder;
        },
        update: (values: unknown) => {
          updateValues = values;
          calls.push({ name: `${currentTable}:update`, args: [values] });
          return builder;
        },
        // deno-lint-ignore no-explicit-any
        then: (resolve: any, reject: any) => {
          let promise: Promise<{ data: unknown; error: unknown }>;
          if (currentTable === "platform_posts") {
            if (updateValues !== null) {
              promise = handlers.platformPostsUpdate
                ? handlers.platformPostsUpdate(updateValues)
                : Promise.resolve({ data: null, error: null });
            } else {
              promise = handlers.platformPostsSelect
                ? handlers.platformPostsSelect()
                : Promise.resolve({ data: [], error: null });
            }
          } else if (currentTable === "tiktok_webhook_events") {
            if (updateValues !== null) {
              promise = handlers.webhookEventsUpdate
                ? handlers.webhookEventsUpdate(updateValues)
                : Promise.resolve({ data: null, error: null });
            } else {
              promise = handlers.webhookEventsSelect
                ? handlers.webhookEventsSelect()
                : Promise.resolve({ data: [], error: null });
            }
          } else {
            promise = Promise.resolve({ data: null, error: null });
          }
          return promise.then(resolve, reject);
        },
      };
      return builder;
    },
    rpc: (name: string, params: unknown) => {
      calls.push({ name: `rpc:${name}`, args: [params] });
      if (handlers.rpc) return handlers.rpc(name, params);
      return Promise.resolve({ data: { success: true }, error: null });
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

Deno.test("applyTikTokPublishOutcome: returns unmatched when no platform_posts row exists", async () => {
  const { client, calls } = createFakeSupabase({
    platformPostsSelect: () => Promise.resolve({ data: [], error: null }),
  });

  const result = await applyTikTokPublishOutcome(client, {
    publishId: "pub-none",
    userOpenId: "open-123",
    outcome: { kind: "published", providerPostId: "v-1" },
  });

  assertEquals(result, "unmatched");
  const rpcCalls = calls.filter((c) => c.name.startsWith("rpc:"));
  assertEquals(rpcCalls.length, 0);
});

Deno.test("applyTikTokPublishOutcome: openid mismatch returns unmatched and executes no RPC", async () => {
  const { client, calls } = createFakeSupabase({
    platformPostsSelect: () =>
      Promise.resolve({
        data: [
          {
            id: "pp-1",
            post_id: "post-1",
            social_account_id: "sa-1",
            status: "pending",
            platform_post_url: null,
            social_accounts: {
              platform_user_id: "legit-owner-openid",
              platform_username: "user_handle",
              account_metadata: {},
            },
          },
        ],
        error: null,
      }),
  });

  const result = await applyTikTokPublishOutcome(client, {
    publishId: "pub-123",
    userOpenId: "spoofed-openid",
    outcome: { kind: "published", providerPostId: "v-1" },
  });

  assertEquals(result, "unmatched");
  const rpcCalls = calls.filter((c) => c.name.startsWith("rpc:"));
  assertEquals(rpcCalls.length, 0);
});

Deno.test("applyTikTokPublishOutcome: pending row + published settles with p_status success and stripped leading @ in URL", async () => {
  let settledParams: unknown = null;
  const { client } = createFakeSupabase({
    platformPostsSelect: () =>
      Promise.resolve({
        data: [
          {
            id: "pp-1",
            post_id: "post-1",
            social_account_id: "sa-1",
            status: "pending",
            platform_post_url: null,
            social_accounts: {
              platform_user_id: "open-1",
              platform_username: "fallback_handle",
              account_metadata: { tiktok_username: "@creator_account" },
            },
          },
        ],
        error: null,
      }),
    rpc: (_name, params) => {
      settledParams = params;
      return Promise.resolve({ data: { success: true }, error: null });
    },
  });

  const result = await applyTikTokPublishOutcome(client, {
    publishId: "pub-1",
    userOpenId: "open-1",
    outcome: { kind: "published", providerPostId: "789123456" },
  });

  assertEquals(result, "applied");
  assertEquals(settledParams, {
    p_platform_post_id: "pp-1",
    p_post_id: "post-1",
    p_social_account_id: "sa-1",
    p_platform: "tiktok",
    p_status: "success",
    p_provider_post_id: "789123456",
    p_provider_post_url: "https://www.tiktok.com/@creator_account/video/789123456",
    p_error_message: null,
    p_response_data: null,
  });
});

Deno.test("applyTikTokPublishOutcome: pending row + failed settles with formatted error message", async () => {
  let settledParams: unknown = null;
  const { client } = createFakeSupabase({
    platformPostsSelect: () =>
      Promise.resolve({
        data: [
          {
            id: "pp-2",
            post_id: "post-2",
            social_account_id: "sa-2",
            status: "pending",
            platform_post_url: null,
            social_accounts: {
              platform_user_id: "open-2",
              platform_username: "user2",
              account_metadata: null,
            },
          },
        ],
        error: null,
      }),
    rpc: (_name, params) => {
      settledParams = params;
      return Promise.resolve({ data: { success: true }, error: null });
    },
  });

  const result = await applyTikTokPublishOutcome(client, {
    publishId: "pub-2",
    userOpenId: "open-2",
    outcome: { kind: "failed", reason: "duration_check_failed" },
  });

  assertEquals(result, "applied");
  assertEquals(settledParams, {
    p_platform_post_id: "pp-2",
    p_post_id: "post-2",
    p_social_account_id: "sa-2",
    p_platform: "tiktok",
    p_status: "failed",
    p_provider_post_id: null,
    p_provider_post_url: null,
    p_error_message: "TikTok publish failed: duration_check_failed",
    p_response_data: null,
  });
});

Deno.test("applyTikTokPublishOutcome: success row + later failed outcome causes no regression and returns already_terminal", async () => {
  const { client, calls } = createFakeSupabase({
    platformPostsSelect: () =>
      Promise.resolve({
        data: [
          {
            id: "pp-3",
            post_id: "post-3",
            social_account_id: "sa-3",
            status: "success",
            platform_post_url: "https://www.tiktok.com/@u/video/123",
            social_accounts: {
              platform_user_id: "open-3",
              platform_username: "u",
              account_metadata: {},
            },
          },
        ],
        error: null,
      }),
  });

  const result = await applyTikTokPublishOutcome(client, {
    publishId: "pub-3",
    userOpenId: "open-3",
    outcome: { kind: "failed", reason: "late failure event" },
  });

  assertEquals(result, "already_terminal");
  const rpcCalls = calls.filter((c) => c.name.startsWith("rpc:"));
  assertEquals(rpcCalls.length, 0);
});

Deno.test("applyTikTokPublishOutcome: success row with null URL updates platform_posts without calling settle RPC", async () => {
  let updatePayload: unknown = null;
  const { client, calls } = createFakeSupabase({
    platformPostsSelect: () =>
      Promise.resolve({
        data: [
          {
            id: "pp-4",
            post_id: "post-4",
            social_account_id: "sa-4",
            status: "success",
            platform_post_url: null,
            social_accounts: {
              platform_user_id: "open-4",
              platform_username: "creator_name",
              account_metadata: { tiktok_username: "@creator_name" },
            },
          },
        ],
        error: null,
      }),
    platformPostsUpdate: (values) => {
      updatePayload = values;
      return Promise.resolve({ data: null, error: null });
    },
  });

  const result = await applyTikTokPublishOutcome(client, {
    publishId: "pub-4",
    userOpenId: "open-4",
    outcome: { kind: "published", providerPostId: "video-999" },
  });

  assertEquals(result, "already_terminal");
  const rpcCalls = calls.filter((c) => c.name.startsWith("rpc:"));
  assertEquals(rpcCalls.length, 0);
  assertEquals(updatePayload, {
    platform_post_id: "video-999",
    platform_post_url: "https://www.tiktok.com/@creator_name/video/video-999",
  });
});

Deno.test("applyTikTokPublishOutcome: database read error rejects with tiktok_outcome_read_failed", async () => {
  const { client } = createFakeSupabase({
    platformPostsSelect: () => Promise.resolve({ data: null, error: { message: "db unavailable" } }),
  });

  await assertRejects(
    () =>
      applyTikTokPublishOutcome(client, {
        publishId: "pub-err",
        userOpenId: "open-1",
        outcome: { kind: "published", providerPostId: "v-1" },
      }),
    Error,
    "tiktok_outcome_read_failed",
  );
});

Deno.test("applyPendingWebhookEvents: returns none when no unapplied webhook events exist", async () => {
  const { client } = createFakeSupabase({
    webhookEventsSelect: () => Promise.resolve({ data: [], error: null }),
  });

  const result = await applyPendingWebhookEvents(client, "pub-empty");
  assertEquals(result, "none");
});

Deno.test("applyPendingWebhookEvents: applies events in create_time order, marks applied_at, and ignores inbox_delivered", async () => {
  const markedAppliedIds: unknown[] = [];
  const appliedOutcomes: unknown[] = [];

  let currentPlatformPostStatus = "pending";
  const { client, calls } = createFakeSupabase({
    webhookEventsSelect: () =>
      Promise.resolve({
        data: [
          {
            id: 101,
            event: "post.publish.inbox_delivered",
            user_openid: "open-1",
            provider_post_id: null,
            reason: null,
            create_time: 1000,
          },
          {
            id: 102,
            event: "post.publish.complete",
            user_openid: "open-1",
            provider_post_id: null,
            reason: null,
            create_time: 1050,
          },
          {
            id: 103,
            event: "post.publish.publicly_available",
            user_openid: "open-1",
            provider_post_id: "final-video-id",
            reason: null,
            create_time: 1100,
          },
        ],
        error: null,
      }),
    platformPostsSelect: () =>
      Promise.resolve({
        data: [
          {
            id: "pp-100",
            post_id: "post-100",
            social_account_id: "sa-100",
            status: currentPlatformPostStatus,
            platform_post_url: null,
            social_accounts: {
              platform_user_id: "open-1",
              platform_username: "user_a",
              account_metadata: {},
            },
          },
        ],
        error: null,
      }),
    rpc: (_name, params) => {
      appliedOutcomes.push(params);
      currentPlatformPostStatus = "success";
      return Promise.resolve({ data: { success: true }, error: null });
    },
    platformPostsUpdate: (_vals) => {
      return Promise.resolve({ data: null, error: null });
    },
    webhookEventsUpdate: (_vals) => {
      return Promise.resolve({ data: null, error: null });
    },
  });

  const result = await applyPendingWebhookEvents(client, "pub-multi");
  // The first terminal event (102) settles the pending post to success.
  // The second terminal event (103) encounters a success row with null URL and fills the URL, returning already_terminal.
  assertEquals(result, "already_terminal");

  // Verify order call was made ascending
  const orderCall = calls.find((c) => c.name === "tiktok_webhook_events:order");
  assert(orderCall);
  assertEquals(orderCall.args, ["create_time", { ascending: true }]);

  // inbox_delivered is skipped. Event 102 settles the pending post (1 RPC call).
  assertEquals(appliedOutcomes.length, 1);
  // Both terminal events (102 and 103) were applied / already_terminal, so both were marked
  const updateCalls = calls.filter((c) => c.name === "tiktok_webhook_events:update");
  assertEquals(updateCalls.length, 2);
});
