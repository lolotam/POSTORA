import { assertEquals } from "jsr:@std/assert@1";
import type { EvolutionSendResult } from "../_shared/evolutionApi.ts";
import type { WhatsAppTransport, WhatsAppTransportAccount } from "../_shared/whatsappTransport.ts";
import {
  handleScheduledSender,
  type ClaimedScheduledMessage,
  type ScheduledSenderDeps,
  type ScheduledTransition,
} from "./handler.ts";

const PHONE = "+965 5000-1111";
const DIGITS = "96550001111";
const FIXED = new Date("2026-09-27T12:00:00Z");

interface RecordedSend {
  mode: string | null;
  op: "text" | "media";
  recipient: string;
  text?: string;
  caption?: string;
  mediaType?: string;
}

function message(id: string, userId: string, over: Partial<ClaimedScheduledMessage> = {}): ClaimedScheduledMessage {
  return {
    id,
    user_id: userId,
    social_account_id: `acc-${userId}`,
    recipient_phone: PHONE,
    message_text: "hello",
    media_url: null,
    media_type: null,
    claim_token: `token-${id}`,
    account_connection_mode: "cloud_api",
    account_platform_user_id: "pnid",
    account_access_token: "account-token",
    account_metadata: null,
    account_is_active: true,
    ...over,
  };
}

function deps(messages: ClaimedScheduledMessage[], extra: Partial<ScheduledSenderDeps> = {}) {
  const sends: RecordedSend[] = [];
  const transitions: ScheduledTransition[] = [];
  const inserts: Record<string, unknown>[] = [];
  const lookups: Array<{ userId: string; phones: string[] }> = [];
  const logs: Array<{ userId: string; reason: string; metadata: Record<string, unknown> }> = [];
  const events: Array<{ userId: string; message: string; metadata: Record<string, unknown> }> = [];
  const accounts: WhatsAppTransportAccount[] = [];

  const transport = (mode: string | null): WhatsAppTransport => ({
    sendText: (input) => {
      sends.push({ mode, op: "text", recipient: input.recipientPhone, text: input.text });
      return Promise.resolve({ messageId: "wamid", raw: { leaked: "raw-secret" } } satisfies EvolutionSendResult);
    },
    sendMedia: (input) => {
      sends.push({
        mode,
        op: "media",
        recipient: input.recipientPhone,
        caption: input.caption,
        mediaType: input.mediaType,
      });
      return Promise.resolve({ messageId: "wamid-media", raw: { leaked: "raw-secret" } } satisfies EvolutionSendResult);
    },
    markRead: () => Promise.resolve(),
  });

  const gate = {
    sends,
    transitions,
    inserts,
    lookups,
    logs,
    events,
    accounts,
    authorize: () => ({ ok: true as const }),
    loadDue: async () => ({ messages }),
    optedOutPhones: async (userId: string, phones: string[]) => {
      lookups.push({ userId, phones });
      return userId === "user-a" ? new Set([DIGITS]) : new Set<string>();
    },
    logSendRefused: async (input: { userId: string; reason: string; metadata: Record<string, unknown> }) => {
      logs.push({ userId: input.userId, reason: input.reason, metadata: input.metadata });
    },
    logEvent: async (entry: { userId: string; message: string; metadata: Record<string, unknown> }) => {
      events.push({ userId: entry.userId, message: entry.message, metadata: entry.metadata });
    },
    transition: async (input: ScheduledTransition) => {
      transitions.push(input);
      return true;
    },
    insertOutbound: async (row: Record<string, unknown>) => {
      inserts.push(row);
    },
    resolveTransport: async (account: WhatsAppTransportAccount) => {
      accounts.push(account);
      return transport(account.connection_mode);
    },
    now: () => FIXED,
    budgetMs: 40_000,
    sendTimeoutMs: 20_000,
  };
  return Object.assign(gate, extra);
}

const request = () => new Request("https://api.example/whatsapp-scheduled-sender", { method: "POST" });

function summary(over: Partial<{ processed: number; skipped: number; failed: number; released: number; total: number }>) {
  return { processed: 0, skipped: 0, failed: 0, released: 0, total: 0, ...over };
}

Deno.test("an opted-out scheduled message is skipped while another user's same phone is sent", async () => {
  const gate = deps([message("msg-a", "user-a"), message("msg-b", "user-b")]);
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), summary({ processed: 1, skipped: 1, total: 2 }));
  assertEquals(gate.lookups.map((lookup) => lookup.userId).sort(), ["user-a", "user-b"]);
  assertEquals(gate.lookups.every((lookup) => lookup.phones.length === 1), true);
  assertEquals(gate.sends.map((send) => send.recipient), [DIGITS]);
  assertEquals(gate.transitions.map((update) => [update.id, update.expectedStatus, update.patch.status, update.claimToken]), [
    ["msg-a", "claimed", "skipped", "token-msg-a"],
    ["msg-b", "claimed", "sending", "token-msg-b"],
    ["msg-b", "sending", "sent", "token-msg-b"],
  ]);
  assertEquals(gate.transitions[0]?.patch.error_message, "opted_out");
  assertEquals(gate.transitions[0]?.patch.claim_token, null);
  assertEquals(gate.logs[0], { userId: "user-a", reason: "opted_out", metadata: { scheduled_message_id: "msg-a" } });
  assertEquals(JSON.stringify(gate.logs).includes(DIGITS), false);
  assertEquals(gate.inserts[0]?.message_id, "wamid");
  assertEquals(JSON.stringify(gate.inserts).includes("raw-secret"), false);
});

Deno.test("a scheduled opt-out lookup failure releases that user's claims and sends none of them", async () => {
  const gate = deps([message("msg-a", "user-a"), message("msg-a2", "user-a"), message("msg-b", "user-b")], {
    optedOutPhones: async (userId: string) => {
      if (userId === "user-a") throw new Error("opt_out_lookup_failed");
      return new Set<string>();
    },
  });
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), summary({ processed: 1, released: 2, total: 3 }));
  assertEquals(gate.sends.map((send) => send.recipient), [DIGITS]);
  assertEquals(gate.transitions.filter((update) => update.id !== "msg-b").map((update) => update.patch), [
    { status: "pending", claim_token: null, claimed_at: null },
    { status: "pending", claim_token: null, claimed_at: null },
  ]);
  assertEquals(gate.transitions.filter((update) => update.id !== "msg-b").every((update) => update.expectedStatus === "claimed"), true);
  assertEquals(gate.logs[0]?.reason, "opt_out_lookup_failed");
  assertEquals(JSON.stringify(gate.logs).includes(DIGITS), false);
  assertEquals(JSON.stringify(gate.events).includes(DIGITS), false);
});

Deno.test("a failed opted-out status write is logged and the message is not sent", async () => {
  const gate = deps([message("msg-a", "user-a")], {
    transition: async () => {
      throw new Error("scheduled_message_update_failed");
    },
  });
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), summary({ total: 1 }));
  assertEquals(gate.sends, []);
  assertEquals(gate.logs, [{ userId: "user-a", reason: "opt_out_skip_failed", metadata: { scheduled_message_id: "msg-a" } }]);
});

Deno.test("a claim lost while moving to sending does not call the provider", async () => {
  const gate = deps([message("msg-b", "user-b")], {
    transition: async (input) => input.patch.status !== "sending",
  });
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), summary({ total: 1 }));
  assertEquals(gate.sends, []);
  assertEquals(gate.accounts, []);
  assertEquals(gate.events[0]?.metadata.expected_status, "claimed");
  assertEquals(JSON.stringify(gate.events).includes(DIGITS), false);
});

Deno.test("a sent-status write failure after provider acceptance is logged and not retried or failed", async () => {
  const gate = deps([message("msg-b", "user-b")], {
    transition: async (input) => {
      gate.transitions.push(input);
      if (input.patch.status === "sent") throw new Error("sent write failed");
      return true;
    },
  });
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), summary({ total: 1 }));
  assertEquals(gate.sends.length, 1);
  assertEquals(gate.transitions.map((update) => update.patch.status), ["sending", "sent"]);
  assertEquals(gate.inserts, []);
  assertEquals(gate.events.some((event) => event.metadata.reason === "sent_write_failed"), true);
  assertEquals(JSON.stringify(gate.events).includes(PHONE), false);
});

Deno.test("an outbound insert failure after sent is logged and does not mark the row failed", async () => {
  const gate = deps([message("msg-b", "user-b")], {
    insertOutbound: async () => {
      throw new Error("whatsapp_message_insert_failed");
    },
  });
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), summary({ processed: 1, total: 1 }));
  assertEquals(gate.sends.length, 1);
  assertEquals(gate.transitions.some((update) => update.patch.status === "failed"), false);
  assertEquals(gate.events.some((event) => event.metadata.reason === "outbound_insert_failed"), true);
});

Deno.test("a provider refusal is stored and a 24h window maps to outside_session_window", async () => {
  const windowError = new Error("Re-engagement message");
  (windowError as Error & { code: number }).code = 131047;
  const refusals = [
    message("plain", "user-b"),
    message("window", "user-b"),
    message("hours", "user-b"),
  ];
  let call = 0;
  const errors = [new Error("Meta said no"), windowError, new Error("Outside the 24 hour window")];
  const gate = deps(refusals, {
    resolveTransport: async (account) => {
      gate.accounts.push(account);
      return {
        sendText: () => Promise.reject(errors[call++]),
        sendMedia: () => Promise.reject(new Error("unused")),
        markRead: () => Promise.resolve(),
      };
    },
  });
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), summary({ failed: 3, total: 3 }));
  assertEquals(gate.transitions.filter((update) => update.patch.status === "failed").map((update) => update.patch.error_message), [
    "Meta said no",
    "outside_session_window",
    "outside_session_window",
  ]);
  assertEquals(gate.transitions.filter((update) => update.patch.status === "failed").every((update) => update.expectedStatus === "sending" && update.patch.claim_token === null), true);
  assertEquals(gate.inserts, []);
});

Deno.test("cloud and QR accounts both send through the transport with digits only and audio has no caption", async () => {
  const gate = deps([
    message("qr-audio", "user-b", {
      account_connection_mode: "evolution_qr",
      account_platform_user_id: "qr-instance",
      media_type: "audio",
      media_url: "https://cdn.example/voice.ogg",
      message_text: "do not caption",
    }),
    message("cloud-text", "user-b", {
      account_connection_mode: "cloud_api",
      account_platform_user_id: "pn-cloud",
    }),
  ]);
  await handleScheduledSender(request(), gate);
  assertEquals(gate.accounts.map((account) => account.connection_mode), ["evolution_qr", "cloud_api"]);
  assertEquals(gate.sends, [
    { mode: "evolution_qr", op: "media", recipient: DIGITS, caption: undefined, mediaType: "audio" },
    { mode: "cloud_api", op: "text", recipient: DIGITS, text: "hello" },
  ]);
  assertEquals(gate.inserts.map((row) => row.conversation_id), [
    `wa_qr-instance_${DIGITS}`,
    `wa_pn-cloud_${DIGITS}`,
  ]);
  assertEquals(gate.inserts.map((row) => row.message_id), ["wamid-media", "wamid"]);
});

Deno.test("invalid media, empty text, an @lid recipient, and an inactive account fail before the provider", async () => {
  const cases: Array<[string, Partial<ClaimedScheduledMessage>, string]> = [
    ["media", { media_type: "sticker", media_url: "https://cdn.example/x.webp" }, "invalid_media"],
    ["empty-url", { media_type: "image", media_url: "  " }, "invalid_media"],
    ["empty", { message_text: "  " }, "empty_message"],
    ["lid", { recipient_phone: "96550001111@lid" }, "invalid_recipient"],
    ["short", { recipient_phone: "12345" }, "invalid_recipient"],
    ["inactive", { account_is_active: false }, "account_inactive"],
    ["mode", { account_connection_mode: "sms" }, "unsupported_account"],
  ];
  for (const [id, patch, reason] of cases) {
    const gate = deps([message(id, "user-b", patch)]);
    const response = await handleScheduledSender(request(), gate);
    assertEquals(await response.json(), summary({ failed: 1, total: 1 }), id);
    assertEquals(gate.sends, [], id);
    assertEquals(gate.accounts, [], id);
    assertEquals(gate.transitions[0]?.expectedStatus, "claimed", id);
    assertEquals(gate.transitions[0]?.patch, { status: "failed", error_message: reason, claim_token: null }, id);
    assertEquals(gate.events[0]?.metadata.reason, reason, id);
    assertEquals(JSON.stringify(gate.events).includes("96550001111"), false, id);
  }
});

Deno.test("an opted-out skip that loses the claim is not sent", async () => {
  const gate = deps([message("msg-a", "user-a")], {
    transition: async (input) => {
      gate.transitions.push(input);
      return false;
    },
  });
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), summary({ total: 1 }));
  assertEquals(gate.sends, []);
  assertEquals(gate.transitions[0]?.patch.status, "skipped");
  assertEquals(gate.logs, []);
  assertEquals(gate.events[0]?.metadata.expected_status, "claimed");
});

Deno.test("rows still claimed after the tick budget are released instead of sent", async () => {
  const stamps = [0, 0, 1_000, 40_000];
  let tick = 0;
  const gate = deps([message("first", "user-b"), message("second", "user-b")], {
    now: () => new Date(stamps[Math.min(tick++, stamps.length - 1)] ?? 40_000),
  });
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), summary({ processed: 1, released: 1, total: 2 }));
  assertEquals(gate.sends.length, 1);
  assertEquals(gate.transitions.filter((update) => update.id === "second").map((update) => [update.expectedStatus, update.patch.status]), [
    ["claimed", "pending"],
  ]);
});

Deno.test("a provider timeout after the sending claim leaves the row sending", async () => {
  let finish: (value: EvolutionSendResult) => void = () => {};
  const hung = new Promise<EvolutionSendResult>((resolve) => {
    finish = resolve;
  });
  const gate = deps([message("slow", "user-b")], {
    sendTimeoutMs: 20,
    resolveTransport: async () => ({
      sendText: () => hung,
      sendMedia: () => hung,
      markRead: () => Promise.resolve(),
    }),
  });
  try {
    const response = await handleScheduledSender(request(), gate);
    assertEquals(await response.json(), summary({ total: 1 }));
    assertEquals(gate.transitions.map((update) => update.patch.status), ["sending"]);
    assertEquals(gate.events[0]?.metadata.reason, "provider_timeout");
    assertEquals(JSON.stringify(gate.events).includes(DIGITS), false);
  } finally {
    finish({ messageId: "late", raw: {} });
  }
});

Deno.test("a claim RPC error sends nothing", async () => {
  const gate = deps([], { loadDue: async () => ({ error: "scheduled_query_failed" }) });
  const response = await handleScheduledSender(request(), gate);
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "scheduled_query_failed" });
  assertEquals(gate.sends, []);
});
