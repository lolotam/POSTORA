import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { describeDispatchSubject, recordN8nDispatch } from "./automationDispatchLog.ts";
import type { N8nEnvelope } from "./n8nMessagingDispatch.ts";

const messageEnvelope = {
  event: "message.received",
  platform: "facebook",
  social_account_id: "account-1",
  timestamp: "2026-08-27T10:00:00.000Z",
  conversation_id: "account-1_sender-9",
  message: { id: "m-1", text: "ما هو مجال عملكم", type: "text", attachments: [] },
} as unknown as N8nEnvelope;

const commentEnvelope = {
  event: "comment.received",
  platform: "instagram",
  social_account_id: "account-2",
  timestamp: "2026-08-27T10:00:00.000Z",
  comment: { id: "c-1", kind: "comment", text: "Nice!", parent_comment_id: null, media_url: null },
} as unknown as N8nEnvelope;

Deno.test("describeDispatchSubject reads a message envelope", () => {
  assertEquals(describeDispatchSubject(messageEnvelope), {
    conversationId: "account-1_sender-9",
    inboundText: "ما هو مجال عملكم",
  });
});

// A comment has no conversation of its own. Falling back to the envelope's absent
// conversation_id would file every comment on an account under the same null thread.
Deno.test("describeDispatchSubject uses a comment's own id as its thread", () => {
  assertEquals(describeDispatchSubject(commentEnvelope), {
    conversationId: "c-1",
    inboundText: "Nice!",
  });
});

Deno.test("describeDispatchSubject tolerates an envelope missing both fields", () => {
  const bare = { event: "message.received", platform: "whatsapp", social_account_id: "a", timestamp: "t" };
  assertEquals(describeDispatchSubject(bare as N8nEnvelope), {
    conversationId: null,
    inboundText: null,
  });
});

Deno.test("recordN8nDispatch writes one row describing the fan-out", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const admin = {
    from(table: string) {
      assertEquals(table, "automation_dispatch_log");
      return {
        insert(row: Record<string, unknown>) {
          rows.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  await recordN8nDispatch(admin, "user-1", messageEnvelope, 2);

  assertEquals(rows, [{
    user_id: "user-1",
    social_account_id: "account-1",
    platform: "facebook",
    event: "message.received",
    conversation_id: "account-1_sender-9",
    inbound_text: "ما هو مجال عملكم",
    destination_count: 2,
  }]);
});

// The delivery already happened by the time this runs. A logging failure that propagated
// would be reported as a dispatch failure that did not occur.
Deno.test("recordN8nDispatch swallows a write that throws", async () => {
  const admin = {
    from() {
      throw new Error("relation does not exist");
    },
  };

  await recordN8nDispatch(admin, "user-1", messageEnvelope, 1);
});

Deno.test("recordN8nDispatch swallows a write that returns an error", async () => {
  const admin = {
    from: () => ({ insert: () => Promise.resolve({ error: { message: "permission denied" } }) }),
  };

  await recordN8nDispatch(admin, "user-1", commentEnvelope, 0);
});
