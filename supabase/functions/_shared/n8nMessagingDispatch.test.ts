import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildCommentPayload,
  buildMentionEnvelope,
  buildMessagePayload,
  describeMessagingAccount,
  dispatchMessageEvent,
  dispatchN8nEvent,
  signMessagePayload,
  shouldDispatchInboundMessage,
} from "./n8nMessagingDispatch.ts";

const messageInput = {
  platform: "whatsapp" as const,
  socialAccountId: "account-1",
  conversationId: "wa_123_96512345678",
  sender: { id: "96512345678", name: "Customer", phone: "+96512345678" },
  message: { id: "wamid.1", text: "Hello", type: "text", attachments: [] },
  timestamp: "2026-08-20T03:10:00.000Z",
};
const messagePayload = buildMessagePayload(messageInput);

Deno.test("buildMessagePayload emits the shared messaging envelope", () => {
  assertEquals(buildMessagePayload(messageInput), {
    event: "message.received",
    platform: "whatsapp",
    social_account_id: "account-1",
    account: { id: "account-1", platform: "whatsapp", name: "account-1", username: null, handle: null },
    conversation_id: "wa_123_96512345678",
    sender: { id: "96512345678", name: "Customer", phone: "+96512345678" },
    message: { id: "wamid.1", text: "Hello", type: "text", attachments: [] },
    timestamp: "2026-08-20T03:10:00.000Z",
  });
});

Deno.test("describeMessagingAccount labels handle platforms with @ and WhatsApp with its number", () => {
  assertEquals(
    describeMessagingAccount({ id: "ig-1", platform: "instagram", platform_user_id: "1789", platform_username: "danatfuture" }),
    { id: "ig-1", platform: "instagram", name: "danatfuture", username: "danatfuture", handle: "@danatfuture" },
  );
  assertEquals(
    describeMessagingAccount({ id: "wa-1", platform: "whatsapp", platform_user_id: "96566980961", platform_username: "" }),
    { id: "wa-1", platform: "whatsapp", name: "96566980961", username: null, handle: null },
  );
});

Deno.test("signMessagePayload signs the exact UTF-8 payload bytes", async () => {
  const payload = JSON.stringify({ text: "مرحبا" });
  const signature = await signMessagePayload(payload, "secret");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  assertEquals(signature, Array.from(new Uint8Array(expected)).map((b) => b.toString(16).padStart(2, "0")).join(""));
});

Deno.test("shouldDispatchInboundMessage suppresses echoes, statuses, and history", () => {
  for (const input of [{ isEcho: true }, { isStatus: true }, { isHistory: true }]) {
    assertEquals(shouldDispatchInboundMessage(input), false);
  }
  assertEquals(shouldDispatchInboundMessage({}), true);
});

Deno.test("dispatchMessageEvent matches aliases, wildcard, and active subscriptions", async () => {
  const requests: string[] = [];
  const updates: Array<{ key: string; value: Record<string, unknown> }> = [];
  const admin = stubAdmin({
    settings: [
      { key: "n8n_webhook_user-1_a", value: { webhook_url: "https://a.example", events: ["message.whatsapp"], is_active: true, failure_count: 0, secret: "a" } },
      { key: "n8n_webhook_user-1_b", value: { webhook_url: "https://b.example", events: ["message.received"], is_active: true, failure_count: 0 } },
      { key: "n8n_webhook_user-1_c", value: { webhook_url: "https://c.example", events: ["message.facebook"], is_active: true, failure_count: 0 } },
      { key: "n8n_webhook_user-1_d", value: { webhook_url: "https://a.example", events: ["*"], is_active: true, failure_count: 0 } },
      { key: "n8n_webhook_user-1_e", value: { webhook_url: "https://inactive.example", events: ["*"], is_active: false, failure_count: 0 } },
    ],
    legacy: [],
    updates,
  });

  await dispatchMessageEvent(admin, "user-1", messagePayload, {
    fetcher: async (url) => {
      requests.push(String(url));
      return new Response(null, { status: 204 });
    },
  });

  assertEquals(requests.sort(), ["https://a.example", "https://b.example"]);
  assertEquals(updates.length, 2);
});

Deno.test("dispatchMessageEvent disables a destination at ten failures", async () => {
  const updates: Array<{ key: string; value: Record<string, unknown> }> = [];
  const admin = stubAdmin({
    settings: [{ key: "n8n_webhook_user-1_a", value: { webhook_url: "https://a.example", events: ["message.received"], is_active: true, failure_count: 9 } }],
    legacy: [],
    updates,
  });

  await dispatchMessageEvent(admin, "user-1", messagePayload, {
    fetcher: async () => new Response(null, { status: 500 }),
  });

  assertEquals((updates[0].value.value as Record<string, unknown>).failure_count, 10);
  assertEquals((updates[0].value.value as Record<string, unknown>).is_active, false);
});

Deno.test("dispatchMessageEvent keeps at most five destinations in flight", async () => {
  let active = 0;
  let maximum = 0;
  const urls = Array.from({ length: 12 }, (_, index) => `https://hook-${index}.example`);
  const admin = stubAdmin({
    settings: urls.map((webhook_url) => ({ key: `n8n_webhook_user-1_${webhook_url}`, value: { webhook_url, events: ["message.received"], is_active: true, failure_count: 0 } })),
    legacy: [],
    updates: [],
  });

  await dispatchMessageEvent(admin, "user-1", messagePayload, {
    fetcher: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return new Response(null, { status: 204 });
    },
    deadlineMs: 1000,
  });

  assertEquals(maximum <= 5, true);
});

Deno.test("dispatchMessageEvent skips undelivered destinations once the deadline passes", async () => {
  // The deadline stops NEW deliveries from starting; it must not abandon ones
  // already in flight, or they become the detached promises this module avoids.
  const settings = Array.from({ length: 8 }, (_, index) => ({
    key: `n8n_webhook_user-1_${index}`,
    value: {
      webhook_url: `https://host-${index}.example`,
      events: ["message.received"],
      is_active: true,
      failure_count: 0,
    },
  }));
  const admin = stubAdmin({ settings, legacy: [], updates: [] });
  const attempted: string[] = [];
  const started = Date.now();

  await dispatchMessageEvent(admin, "user-1", messagePayload, {
    deadlineMs: 50,
    fetcher: async (url) => {
      attempted.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 80));
      return new Response(null, { status: 204 });
    },
  });

  // Only the first in-flight batch runs; the rest are skipped past the deadline.
  assertEquals(attempted.length, 5);
  // And the call waited for that batch rather than returning at the deadline.
  assertEquals(Date.now() - started >= 80, true);
});

Deno.test("legacy whatsapp_webhooks subscribers keep their original body and signature header", async () => {
  // These rows have live external subscribers predating the standardized
  // envelope. Changing their payload or header silently breaks integrations.
  const admin = stubAdmin({
    settings: [],
    legacy: [{ id: "legacy-1", url: "https://legacy.example", secret: "s3cret", events: ["message.received"], failure_count: 0, is_active: true }],
    updates: [],
  });
  let sent: any;

  await dispatchMessageEvent(admin, "user-1", messagePayload, {
    fetcher: async (_url, init) => {
      sent = { body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> };
      return new Response(null, { status: 204 });
    },
  });

  assertEquals(Object.keys(sent.body).sort(), ["data", "event", "timestamp"]);
  assertEquals(sent.body.data.message, messagePayload.message.text);
  assertEquals(sent.body.data.conversation_id, messagePayload.conversation_id);
  assertEquals(typeof sent.headers["X-Webhook-Signature"], "string");
  assertEquals(sent.headers["X-Postora-Signature"], undefined);
});

Deno.test("a legacy row with no events column still receives every message", async () => {
  // Historically a null events column meant "all events"; narrowing it would
  // silently cut off existing subscribers.
  const admin = stubAdmin({
    settings: [],
    legacy: [{ id: "legacy-2", url: "https://legacy2.example", secret: null, events: null, failure_count: 0, is_active: true }],
    updates: [],
  });
  let delivered = false;

  await dispatchMessageEvent(admin, "user-1", messagePayload, {
    fetcher: async () => {
      delivered = true;
      return new Response(null, { status: 204 });
    },
  });

  assertEquals(delivered, true);
});

Deno.test("dispatchMessageEvent names the owner when nothing is subscribed", async () => {
  // The tenancy mismatch this warns about — a webhook registered by one user for an account
  // owned by another — used to need a database dump to spot, because an empty fan-out is
  // indistinguishable from a successful one in the logs.
  //
  // CodeRabbit review on PR #14: this runs for every inbound message, so a user with no
  // webhooks at all would warn on each one. That normal case stays traceable at log level;
  // only a user who HAS webhooks but matches none is warned about.
  const warnings: string[] = [];
  const logs: string[] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (message: string) => { warnings.push(message); };
  console.log = (message: string) => { logs.push(message); };
  try {
    let fetched = false;
    await dispatchMessageEvent(
      stubAdmin({ settings: [], legacy: [], updates: [] }),
      "user-without-webhooks",
      messagePayload,
      { fetcher: (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch },
    );
    assertEquals(fetched, false);
    assertEquals(warnings, []);
    assertEquals(logs, [
      "[n8n-dispatch] no webhook destinations for user user-without-webhooks platform whatsapp",
    ]);
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

Deno.test("a webhook that exists but is not subscribed to this platform is warned about", async () => {
  // The actionable half of the empty fan-out: destinations are configured, so the operator
  // can fix the events list, the is_active flag, or the blank url.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    await dispatchMessageEvent(
      stubAdmin({
        settings: [{
          key: "n8n_webhook_user-1_a",
          value: { webhook_url: "https://example.test/hook", is_active: true, events: ["message.facebook"] },
        }],
        legacy: [],
        updates: [],
      }),
      "user-1",
      messagePayload,
      { fetcher: (async () => new Response("{}")) as unknown as typeof fetch },
    );
    assertEquals(warnings, [
      "[n8n-dispatch] 1 webhook(s) configured for user user-1 but none subscribed to message.whatsapp",
    ]);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("an inactive legacy webhook counts as configured, like an inactive settings one", async () => {
  // CodeRabbit round 2 on PR #14: the legacy query used to drop inactive rows in SQL while
  // the settings registry kept them, so the same misconfiguration produced a different log
  // line depending on which table it lived in. Both registries now share one rule.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    let delivered = false;
    await dispatchMessageEvent(
      stubAdmin({
        settings: [],
        legacy: [{ id: "legacy-off", url: "https://off.example", secret: null, events: null, failure_count: 0, is_active: false }],
        updates: [],
      }),
      "user-1",
      messagePayload,
      { fetcher: (async () => { delivered = true; return new Response("{}"); }) as unknown as typeof fetch },
    );
    assertEquals(delivered, false);
    assertEquals(warnings, [
      "[n8n-dispatch] 1 webhook(s) configured for user user-1 but none subscribed to message.whatsapp",
    ]);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("dispatchMessageEvent rejects a missing admin client query result", async () => {
  await assertRejects(() => dispatchMessageEvent({} as any, "user-1", messagePayload));
});

function stubAdmin(input: {
  settings: Array<{ key: string; value: Record<string, unknown> }>;
  legacy: Array<Record<string, unknown>>;
  updates: Array<{ key: string; value: Record<string, unknown> }>;
}) {
  return {
    from(table: string) {
      const rows = table === "app_settings" ? input.settings : input.legacy;
      return new Query(rows, input.updates, table);
    },
  } as any;
}

class Query {
  constructor(private readonly rows: any[], private readonly updates: any[], private readonly table: string) {}
  select() { return this; }
  like() { return this; }
  eq() { return this; }
  async maybeSingle() { return { data: null, error: null }; }
  async then(resolve: (result: unknown) => unknown) { return resolve({ data: this.rows, error: null }); }
  update(value: Record<string, unknown>) {
    this.updates.push({ key: this.rows[0]?.key, value });
    return this;
  }
}

const commentInput = {
  platform: "instagram" as const,
  socialAccountId: "account-ig",
  account: { id: "account-ig", platform: "instagram", platform_user_id: "1789", platform_username: "mybrand" },
  comment: { id: "c-1", kind: "comment" as const, text: "Nice!", parentCommentId: null, mediaUrl: null },
  post: { id: "m-1", url: "https://instagram.com/p/abc", caption: null },
  author: { id: "fan-1", name: null, username: "fan" },
  timestamp: "2026-08-22T10:00:00.000Z",
};

Deno.test("buildCommentPayload emits the comment envelope", () => {
  assertEquals(buildCommentPayload(commentInput), {
    event: "comment.received",
    platform: "instagram",
    social_account_id: "account-ig",
    account: { id: "account-ig", platform: "instagram", name: "mybrand", username: "mybrand", handle: "@mybrand" },
    comment: { id: "c-1", kind: "comment", text: "Nice!", parent_comment_id: null, media_url: null },
    post: { id: "m-1", url: "https://instagram.com/p/abc", caption: null },
    author: { id: "fan-1", name: null, username: "fan" },
    timestamp: "2026-08-22T10:00:00.000Z",
  });
});

Deno.test("dispatchN8nEvent honours platform and account filters and comment aliases", async () => {
  const requests: string[] = [];
  const admin = stubAdmin({
    settings: [
      { key: "k_a", value: { webhook_url: "https://alias.example", events: ["comment.instagram"], is_active: true } },
      { key: "k_b", value: { webhook_url: "https://generic.example", events: ["comment.received"], is_active: true } },
      { key: "k_c", value: { webhook_url: "https://other-platform.example", events: ["comment.received"], platform: "facebook", is_active: true } },
      { key: "k_d", value: { webhook_url: "https://other-account.example", events: ["comment.received"], social_account_id: "account-x", is_active: true } },
      { key: "k_e", value: { webhook_url: "https://this-account.example", events: ["comment.received"], platform: "instagram", social_account_id: "account-ig", is_active: true } },
      { key: "k_f", value: { webhook_url: "https://messages-only.example", events: ["message.received"], is_active: true } },
    ],
    legacy: [],
    updates: [],
  });
  await dispatchN8nEvent(admin, "user-1", buildCommentPayload(commentInput), {
    fetcher: async (url) => { requests.push(String(url)); return new Response(null, { status: 204 }); },
  });
  assertEquals(requests.sort(), ["https://alias.example", "https://generic.example", "https://this-account.example"]);
});

Deno.test("legacy whatsapp_webhooks rows never receive non-message events", async () => {
  // toLegacyPayload reshapes the body as a message; a comment envelope would throw
  // mid-reshape, count as a delivery failure, and eventually disable a live WhatsApp hook.
  const requests: string[] = [];
  const updates: Array<{ key: string; value: Record<string, unknown> }> = [];
  const admin = stubAdmin({
    settings: [],
    legacy: [{ id: "legacy-1", url: "https://legacy.example", secret: null, events: null, failure_count: 0, is_active: true }],
    updates,
  });
  await dispatchN8nEvent(admin, "user-1", buildCommentPayload(commentInput), {
    fetcher: async (url) => { requests.push(String(url)); return new Response(null, { status: 204 }); },
  });
  assertEquals(requests, []);
  assertEquals(updates, []);
});

Deno.test("message filters: a subscription pinned to another account does not receive this message", async () => {
  const requests: string[] = [];
  const admin = stubAdmin({
    settings: [
      { key: "k_a", value: { webhook_url: "https://pinned.example", events: ["message.received"], social_account_id: "account-2", is_active: true } },
    ],
    legacy: [],
    updates: [],
  });
  await dispatchMessageEvent(admin, "user-1", messagePayload, {
    fetcher: async (url) => { requests.push(String(url)); return new Response(null, { status: 204 }); },
  });
  assertEquals(requests, []);
});

Deno.test("threads mention envelope keeps the legacy event/timestamp/data body", async () => {
  // These subscribers predate the standardized envelope. The dispatcher now also signs the
  // request and counts failures for them, which is additive; the body must not move.
  const mention = {
    id: "m-1", social_account_id: "acc-th", mention_author_username: "fan", mention_text: "hi",
    mention_permalink: "https://threads.net/p/1", status: "new", sentiment: null, labels: [],
    assigned_to: null, mentioned_at: "2026-08-22T10:00:00.000Z", source: "webhook",
  };
  const envelope = buildMentionEnvelope("threads.mention.created", "acc-th", mention);
  assertEquals(envelope.event, "threads.mention.created");
  assertEquals(envelope.data, {
    mention_id: "m-1", social_account_id: "acc-th", platform: "threads", author_username: "fan",
    mention_text: "hi", mention_permalink: "https://threads.net/p/1", status: "new", sentiment: null,
    labels: [], assigned_to: null, mentioned_at: "2026-08-22T10:00:00.000Z", source: "webhook",
  });

  const headers: Array<Record<string, string>> = [];
  const admin = stubAdmin({
    settings: [{ key: "k", value: { webhook_url: "https://m.example", events: ["threads.mention.created"], is_active: true } }],
    legacy: [],
    updates: [],
  });
  await dispatchN8nEvent(admin, "user-1", envelope, {
    fetcher: async (_url, init) => {
      headers.push((init as RequestInit).headers as Record<string, string>);
      return new Response(null, { status: 204 });
    },
  });
  assertEquals(headers[0]["X-Postora-Event"], "threads.mention.created");
});
