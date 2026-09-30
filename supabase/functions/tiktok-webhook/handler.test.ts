import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  handleTikTokWebhook,
  type TikTokWebhookDeps,
} from "./handler.ts";

const clientSecret = "test-tiktok-client-secret-xyz";
const nowSeconds = 1727700000;

async function computeSignature(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    ),
  );
  const hex = Array.from(mac)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},s=${hex}`;
}

type Call = { name: string; args: unknown[] };

function createFakeWebhookAdmin(handlers: {
  upsertResult?: { data: unknown; error: unknown };
}) {
  const calls: Call[] = [];
  let upsertArgs: unknown[] = [];

  const client = {
    from: (table: string) => {
      calls.push({ name: `from:${table}`, args: [] });
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        upsert: (values: unknown, options: unknown) => {
          upsertArgs = [values, options];
          calls.push({ name: "upsert", args: [values, options] });
          return builder;
        },
        select: (cols: string) => {
          calls.push({ name: "select", args: [cols] });
          return Promise.resolve(
            handlers.upsertResult ?? { data: [{ id: 42 }], error: null },
          );
        },
      };
      return builder;
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    calls,
    getUpsertArgs: () => upsertArgs,
  };
}

Deno.test("GET ?challenge=x echoes x and GET without challenge echoes OK", async () => {
  const logs: string[] = [];
  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: null,
    log: (msg) => logs.push(msg),
  };

  const req1 = new Request(
    "https://example.com/tiktok-webhook?challenge=secret_echo_challenge_123",
    { method: "GET" },
  );
  const res1 = await handleTikTokWebhook(req1, deps);
  assertEquals(res1.status, 200);
  assertEquals(await res1.text(), "secret_echo_challenge_123");

  const req2 = new Request("https://example.com/tiktok-webhook", {
    method: "GET",
  });
  const res2 = await handleTikTokWebhook(req2, deps);
  assertEquals(res2.status, 200);
  assertEquals(await res2.text(), "OK");
});

Deno.test("POST without configured secrets returns 401", async () => {
  const deps: TikTokWebhookDeps = {
    clientSecret: null,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: null,
    log: () => {},
  };

  const req = new Request("https://example.com/tiktok-webhook", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const res = await handleTikTokWebhook(req, deps);
  assertEquals(res.status, 401);
});

Deno.test("POST with body > 64 KB returns 413 Payload Too Large", async () => {
  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: null,
    log: () => {},
  };

  const hugeBody = "a".repeat(64 * 1024 + 1);
  const signature = await computeSignature(clientSecret, nowSeconds, hugeBody);
  const req = new Request("https://example.com/tiktok-webhook", {
    method: "POST",
    headers: { "TikTok-Signature": signature },
    body: hugeBody,
  });
  const res = await handleTikTokWebhook(req, deps);
  assertEquals(res.status, 413);
});

Deno.test("timestamp replay window: 300s accepted, 301s rejected, now+301 rejected (table-driven)", async () => {
  const cases = [
    { offset: -300, expectedStatus: 200, name: "exactly 300s old accepted" },
    { offset: -301, expectedStatus: 401, name: "301s old rejected" },
    { offset: 301, expectedStatus: 401, name: "now+301 (future) rejected" },
  ];
  for (const c of cases) {
    const { client } = createFakeWebhookAdmin({});
    const deps: TikTokWebhookDeps = {
      clientSecret,
      webhookSecret: null,
      nowSeconds: () => nowSeconds,
      admin: client,
      applyPending: () => Promise.resolve("applied"),
      log: () => {},
    };
    const body = JSON.stringify({
      event: "post.publish.complete",
      user_openid: "open_id_test",
      create_time: nowSeconds,
      content: JSON.stringify({ publish_id: "pub_time_test" }),
    });
    const timestamp = nowSeconds + c.offset;
    const signature = await computeSignature(clientSecret, timestamp, body);
    const req = new Request("https://example.com/tiktok-webhook", {
      method: "POST",
      headers: { "TikTok-Signature": signature },
      body,
    });
    const res = await handleTikTokWebhook(req, deps);
    assertEquals(res.status, c.expectedStatus, `Failed for case: ${c.name}`);
  }
});

Deno.test("wrong signature returns 401", async () => {
  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: null,
    log: () => {},
  };

  const body = JSON.stringify({ event: "post.publish.complete" });
  const signature = `t=${nowSeconds},s=deadbeefbadc0de0000000000000000000000000000000000000000000000000`;

  const req = new Request("https://example.com/tiktok-webhook", {
    method: "POST",
    headers: { "TikTok-Signature": signature },
    body,
  });
  const res = await handleTikTokWebhook(req, deps);
  assertEquals(res.status, 401);
});

Deno.test("valid TikTok-Signature records event with onConflict event,publish_id,create_time and returns 200", async () => {
  const { client, getUpsertArgs } = createFakeWebhookAdmin({});
  const appliedCalls: string[] = [];

  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: client,
    applyPending: (_admin, pubId) => {
      appliedCalls.push(pubId);
      return Promise.resolve("applied");
    },
    log: () => {},
  };

  const payload = {
    event: "post.publish.complete",
    user_openid: "open_id_user_99",
    create_time: 1727700050,
    content: JSON.stringify({
      publish_id: "pub_12345",
      post_id: "video_67890",
    }),
  };
  const body = JSON.stringify(payload);
  const signature = await computeSignature(clientSecret, nowSeconds, body);

  const req = new Request("https://example.com/tiktok-webhook", {
    method: "POST",
    headers: { "TikTok-Signature": signature },
    body,
  });
  const res = await handleTikTokWebhook(req, deps);
  assertEquals(res.status, 200);

  const [upsertRow, upsertOptions] = getUpsertArgs();
  assertEquals(upsertRow, {
    event: "post.publish.complete",
    user_openid: "open_id_user_99",
    publish_id: "pub_12345",
    provider_post_id: "video_67890",
    reason: null,
    create_time: 1727700050,
  });
  assertEquals(upsertOptions, {
    onConflict: "event,publish_id,create_time",
    ignoreDuplicates: true,
  });
  assertEquals(appliedCalls, ["pub_12345"]);
});

Deno.test("malformed content returns 200 and nothing is recorded", async () => {
  const { client, calls } = createFakeWebhookAdmin({});
  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: client,
    log: () => {},
  };

  const payload = {
    event: "post.publish.complete",
    user_openid: "open_id_123",
    create_time: 1727700000,
    content: "invalid-not-json-content{",
  };
  const body = JSON.stringify(payload);
  const signature = await computeSignature(clientSecret, nowSeconds, body);

  const req = new Request("https://example.com/tiktok-webhook", {
    method: "POST",
    headers: { "TikTok-Signature": signature },
    body,
  });
  const res = await handleTikTokWebhook(req, deps);
  assertEquals(res.status, 200);
  assertEquals(calls.length, 0);
});

Deno.test("duplicate event (upsert returns no row) STILL calls applyPendingWebhookEvents (retry of a failed apply)", async () => {
  const { client } = createFakeWebhookAdmin({
    upsertResult: { data: [], error: null },
  });
  let applyPendingCalledWith: string | null = null;

  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: client,
    applyPending: (_admin, pubId) => {
      applyPendingCalledWith = pubId;
      return Promise.resolve("applied");
    },
    log: () => {},
  };

  const payload = {
    event: "post.publish.complete",
    user_openid: "open_id_duplicate",
    create_time: 1727700010,
    content: JSON.stringify({ publish_id: "pub_dup_1" }),
  };
  const body = JSON.stringify(payload);
  const signature = await computeSignature(clientSecret, nowSeconds, body);

  const req = new Request("https://example.com/tiktok-webhook", {
    method: "POST",
    headers: { "TikTok-Signature": signature },
    body,
  });
  const res = await handleTikTokWebhook(req, deps);
  assertEquals(res.status, 200);
  assertEquals(applyPendingCalledWith, "pub_dup_1");
});

Deno.test("apply error during webhook processing returns 500", async () => {
  const { client } = createFakeWebhookAdmin({});

  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: client,
    applyPending: () => {
      return Promise.reject(new Error("apply failed"));
    },
    log: () => {},
  };

  const payload = {
    event: "post.publish.complete",
    user_openid: "open_id_err",
    create_time: 1727700015,
    content: JSON.stringify({ publish_id: "pub_err_1" }),
  };
  const body = JSON.stringify(payload);
  const signature = await computeSignature(clientSecret, nowSeconds, body);

  const req = new Request("https://example.com/tiktok-webhook", {
    method: "POST",
    headers: { "TikTok-Signature": signature },
    body,
  });
  const res = await handleTikTokWebhook(req, deps);
  assertEquals(res.status, 500);
  const json = await res.json();
  assertEquals(json, { error: "Internal error" });
});

Deno.test("realistic opaque publish ids with characters like v_pub_url~v2.123/+= are accepted", async () => {
  const realisticOpaqueId = "v_pub_url~v2.123/+=";
  const { client, getUpsertArgs } = createFakeWebhookAdmin({});
  let recordedPublishId: string | null = null;

  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: client,
    applyPending: (_admin, pubId) => {
      recordedPublishId = pubId;
      return Promise.resolve("applied");
    },
    log: () => {},
  };

  const payload = {
    event: "post.publish.complete",
    user_openid: "open_id_opaque",
    create_time: 1727700020,
    content: JSON.stringify({ publish_id: realisticOpaqueId }),
  };
  const body = JSON.stringify(payload);
  const signature = await computeSignature(clientSecret, nowSeconds, body);

  const req = new Request("https://example.com/tiktok-webhook", {
    method: "POST",
    headers: { "TikTok-Signature": signature },
    body,
  });
  const res = await handleTikTokWebhook(req, deps);
  assertEquals(res.status, 200);

  const [upsertRow] = getUpsertArgs() as [{ publish_id: string }, unknown];
  assertEquals(upsertRow.publish_id, realisticOpaqueId);
  assertEquals(recordedPublishId, realisticOpaqueId);
});

Deno.test("database error on record returns 500", async () => {
  const { client } = createFakeWebhookAdmin({
    upsertResult: { data: null, error: { message: "database connection terminated" } },
  });

  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: client,
    log: () => {},
  };

  const payload = {
    event: "post.publish.complete",
    user_openid: "open_id_fail",
    create_time: 1727700030,
    content: JSON.stringify({ publish_id: "pub_db_fail" }),
  };
  const body = JSON.stringify(payload);
  const signature = await computeSignature(clientSecret, nowSeconds, body);

  const req = new Request("https://example.com/tiktok-webhook", {
    method: "POST",
    headers: { "TikTok-Signature": signature },
    body,
  });
  const res = await handleTikTokWebhook(req, deps);
  assertEquals(res.status, 500);
});

function createComprehensiveWebhookAdmin(initialState?: {
  events?: Array<Record<string, unknown>>;
  platformPosts?: Array<Record<string, unknown>>;
  isDuplicateUpsert?: boolean;
}) {
  const events = [...(initialState?.events ?? [])];
  const platformPosts = [...(initialState?.platformPosts ?? [])];
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: unknown; filters: Record<string, unknown> }> = [];
  let nextEventId = 100;

  const client = {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let updateValues: unknown = null;
      let upsertValues: unknown = null;

      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: (_cols?: string) => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        is: (col: string, val: unknown) => {
          filters[`is:${col}`] = val;
          return builder;
        },
        order: () => builder,
        upsert: (values: unknown, _options: unknown) => {
          upsertValues = values;
          return builder;
        },
        update: (values: unknown) => {
          updateValues = values;
          return builder;
        },
        then: (resolve: (val: unknown) => void) => {
          if (table === "tiktok_webhook_events") {
            if (upsertValues) {
              if (initialState?.isDuplicateUpsert) {
                return resolve({ data: [], error: null });
              }
              const row = { id: ++nextEventId, ...(upsertValues as Record<string, unknown>), applied_at: null };
              events.push(row);
              return resolve({ data: [{ id: row.id }], error: null });
            }
            if (updateValues) {
              updates.push({ table, values: updateValues, filters: { ...filters } });
              const id = filters["id"];
              const ev = events.find((e) => e.id === id);
              if (ev) Object.assign(ev, updateValues);
              return resolve({ data: null, error: null });
            }
            // select
            const filtered = events.filter((e) => {
              if ("publish_id" in filters && e.publish_id !== filters["publish_id"]) return false;
              if ("is:applied_at" in filters && filters["is:applied_at"] === null && e.applied_at !== null) return false;
              return true;
            });
            return resolve({ data: filtered, error: null });
          }

          if (table === "platform_posts") {
            if (updateValues) {
              updates.push({ table, values: updateValues, filters: { ...filters } });
              return resolve({ data: null, error: null });
            }
            // select
            const filtered = platformPosts.filter((p) => {
              if ("platform" in filters && p.platform !== filters["platform"]) return false;
              const resp = p.response_data as Record<string, unknown> | undefined;
              if (
                "response_data->>tiktok_publish_id" in filters &&
                resp?.tiktok_publish_id !== filters["response_data->>tiktok_publish_id"]
              ) {
                return false;
              }
              return true;
            });
            return resolve({ data: filtered, error: null });
          }

          return resolve({ data: [], error: null });
        },
      };
      return builder;
    },
    rpc: (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      return Promise.resolve({ data: { success: true }, error: null });
    },
  };

  return { client: client as unknown as SupabaseClient, events, platformPosts, rpcCalls, updates };
}

Deno.test("real applyPendingWebhookEvents: initial and duplicate retry delivery settle platform post and mark applied", async () => {
  const deliveryCases = [
    { isDuplicate: false, name: "initial delivery" },
    { isDuplicate: true, name: "duplicate retry delivery" },
  ];

  for (const tc of deliveryCases) {
    const pubId = `pub-real-${tc.isDuplicate ? "dup" : "init"}`;
    const userOpenId = tc.isDuplicate ? "user_dup" : "open_id_user_init";
    const initialEvents = tc.isDuplicate
      ? [
          {
            id: 201,
            event: "post.publish.complete",
            user_openid: userOpenId,
            publish_id: pubId,
            provider_post_id: "video-dup-123",
            reason: null,
            create_time: 1727700050,
            received_at: "2026-09-30T12:00:00Z",
            applied_at: null,
          },
        ]
      : [];

    const f = createComprehensiveWebhookAdmin({
      isDuplicateUpsert: tc.isDuplicate,
      events: initialEvents,
      platformPosts: [
        {
          id: "plat-post-real",
          post_id: "post-real-123",
          social_account_id: "soc-real-456",
          platform: "tiktok",
          status: "pending",
          platform_post_id: null,
          platform_post_url: null,
          response_data: { tiktok_publish_id: pubId },
          error_message: null,
          updated_at: "2026-09-30T12:00:00Z",
          social_accounts: {
            platform_user_id: userOpenId,
            platform_username: "creator_handle",
            account_metadata: { tiktok_username: "creator_handle" },
          },
        },
      ],
    });

    const deps: TikTokWebhookDeps = {
      clientSecret,
      webhookSecret: null,
      nowSeconds: () => nowSeconds,
      admin: f.client,
      // NOT injecting deps.applyPending: uses real applyPendingWebhookEvents
      log: () => {},
    };

    const payload = {
      event: "post.publish.complete",
      user_openid: userOpenId,
      create_time: 1727700050,
      content: JSON.stringify({
        publish_id: pubId,
        post_id: tc.isDuplicate ? "video-dup-123" : "video-init-456",
      }),
    };
    const body = JSON.stringify(payload);
    const signature = await computeSignature(clientSecret, nowSeconds, body);

    const req = new Request("https://example.com/tiktok-webhook", {
      method: "POST",
      headers: { "TikTok-Signature": signature },
      body,
    });
    const res = await handleTikTokWebhook(req, deps);
    assertEquals(res.status, 200, `Expected 200 for ${tc.name}`);

    // Assert settle RPC call
    const settleCalls = f.rpcCalls.filter((c) => c.name === "partner_settle_platform_post");
    assertEquals(settleCalls.length, 1, `Expected 1 settle RPC for ${tc.name}`);
    assertEquals(settleCalls[0].params.p_platform_post_id, "plat-post-real");
    assertEquals(settleCalls[0].params.p_status, "success");

    // Assert applied_at mark on tiktok_webhook_events
    const appliedUpdates = f.updates.filter(
      (u) => u.table === "tiktok_webhook_events" && (u.values as Record<string, unknown>).applied_at !== undefined,
    );
    assertEquals(appliedUpdates.length, 1, `Expected 1 applied_at update for ${tc.name}`);
    const expectedEventId = tc.isDuplicate ? 201 : 101;
    assertEquals(appliedUpdates[0].filters["id"], expectedEventId);
  }
});

Deno.test("webhookSecret Authorization fallback accept and reject (table-driven)", async () => {
  const cases = [
    { authHeader: "my-webhook-secret", expectedStatus: 200, name: "correct secret accepted" },
    { authHeader: "wrong-secret", expectedStatus: 401, name: "wrong secret rejected" },
    { authHeader: "", expectedStatus: 401, name: "empty secret rejected" },
  ];

  for (const c of cases) {
    const { client } = createFakeWebhookAdmin({});
    const deps: TikTokWebhookDeps = {
      clientSecret: null, // No client secret, forcing webhookSecret fallback
      webhookSecret: "my-webhook-secret",
      nowSeconds: () => nowSeconds,
      admin: client,
      applyPending: () => Promise.resolve("applied"),
      log: () => {},
    };
    const body = JSON.stringify({
      event: "post.publish.complete",
      user_openid: "open_id_auth",
      create_time: nowSeconds,
      content: JSON.stringify({ publish_id: "pub_auth_fallback" }),
    });
    const headers: Record<string, string> = {};
    if (c.authHeader) {
      headers["Authorization"] = c.authHeader;
    }
    const req = new Request("https://example.com/tiktok-webhook", {
      method: "POST",
      headers,
      body,
    });
    const res = await handleTikTokWebhook(req, deps);
    assertEquals(res.status, c.expectedStatus, `Failed for case: ${c.name}`);
  }
});

Deno.test("invalid envelopes return 200 and nothing is recorded (table-driven)", async () => {
  const cases = [
    {
      name: "missing user_openid",
      payload: {
        event: "post.publish.complete",
        create_time: 1727700000,
        content: JSON.stringify({ publish_id: "pub_valid_id" }),
      },
    },
    {
      name: "non-numeric create_time",
      payload: {
        event: "post.publish.complete",
        user_openid: "open_id_valid",
        create_time: "1727700000",
        content: JSON.stringify({ publish_id: "pub_valid_id" }),
      },
    },
    {
      name: "publish_id > 256 chars",
      payload: {
        event: "post.publish.complete",
        user_openid: "open_id_valid",
        create_time: 1727700000,
        content: JSON.stringify({ publish_id: "p".repeat(257) }),
      },
    },
  ];

  for (const c of cases) {
    const { client, calls } = createFakeWebhookAdmin({});
    const deps: TikTokWebhookDeps = {
      clientSecret,
      webhookSecret: null,
      nowSeconds: () => nowSeconds,
      admin: client,
      log: () => {},
    };
    const body = JSON.stringify(c.payload);
    const signature = await computeSignature(clientSecret, nowSeconds, body);
    const req = new Request("https://example.com/tiktok-webhook", {
      method: "POST",
      headers: { "TikTok-Signature": signature },
      body,
    });
    const res = await handleTikTokWebhook(req, deps);
    assertEquals(res.status, 200, `Expected 200 for ${c.name}`);
    assertEquals(calls.length, 0, `Expected 0 calls for ${c.name}`);
  }
});
