import {
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

Deno.test("timestamp 301 seconds old returns 401", async () => {
  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: null,
    log: () => {},
  };

  const body = JSON.stringify({ event: "post.publish.complete" });
  const oldTimestamp = nowSeconds - 301;
  const signature = await computeSignature(clientSecret, oldTimestamp, body);

  const req = new Request("https://example.com/tiktok-webhook", {
    method: "POST",
    headers: { "TikTok-Signature": signature },
    body,
  });
  const res = await handleTikTokWebhook(req, deps);
  assertEquals(res.status, 401);
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

Deno.test("duplicate event (upsert returns no row) does NOT call applyPendingWebhookEvents", async () => {
  const { client } = createFakeWebhookAdmin({
    upsertResult: { data: [], error: null },
  });
  let applyPendingCalled = false;

  const deps: TikTokWebhookDeps = {
    clientSecret,
    webhookSecret: null,
    nowSeconds: () => nowSeconds,
    admin: client,
    applyPending: () => {
      applyPendingCalled = true;
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
  assertEquals(applyPendingCalled, false);
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
