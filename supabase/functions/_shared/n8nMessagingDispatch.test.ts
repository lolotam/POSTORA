import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildMessagePayload,
  dispatchMessageEvent,
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
    conversation_id: "wa_123_96512345678",
    sender: { id: "96512345678", name: "Customer", phone: "+96512345678" },
    message: { id: "wamid.1", text: "Hello", type: "text", attachments: [] },
    timestamp: "2026-08-20T03:10:00.000Z",
  });
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
    legacy: [{ id: "legacy-1", url: "https://legacy.example", secret: "s3cret", events: ["message.received"], failure_count: 0 }],
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
    legacy: [{ id: "legacy-2", url: "https://legacy2.example", secret: null, events: null, failure_count: 0 }],
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
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    let fetched = false;
    await dispatchMessageEvent(
      stubAdmin({ settings: [], legacy: [], updates: [] }),
      "user-without-webhooks",
      messagePayload,
      { fetcher: (async () => { fetched = true; return new Response("{}"); }) as unknown as typeof fetch },
    );
    assertEquals(fetched, false);
    assertEquals(warnings, [
      "[n8n-dispatch] no webhook destinations for user user-without-webhooks platform whatsapp",
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
