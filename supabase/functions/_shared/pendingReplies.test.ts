// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  advanceReply,
  enqueueAgentReply,
  type PendingReplyItem,
  toEnqueueArgs,
} from "./pendingReplies.ts";

const ITEM: PendingReplyItem = {
  socialAccountId: "acc-1",
  platform: "facebook",
  messageId: "mid-1",
  conversationId: "conv-1",
  recipientId: "psid-1",
  inboundText: "[Image]",
  inboundAt: "2026-08-27T10:00:00.000Z",
};

/** The supabase-js rpc() surface, and nothing else: this module must not need more. */
function stubRpc(result: { data?: unknown; error?: { message: string } | null }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    admin: {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
      },
    },
  };
}

Deno.test("ownership is reported to the caller, so a redelivery does not dispatch", async () => {
  // The bug this prevents: Meta redelivers a webhook it thinks was unacknowledged while the
  // first invocation is still generating. A bare null was read by the caller as "no outbox
  // row, carry on", and both invocations replied.
  for (const owns of [true, false]) {
    const { admin } = stubRpc({ data: [{ id: "row-1", newly_enqueued: owns }] });
    assertEquals(await enqueueAgentReply(admin, ITEM), { id: "row-1", newlyEnqueued: owns });
  }
});

Deno.test("an enqueue that fails outright returns null, and the caller still replies", async () => {
  // A reply with no outbox row beats no reply. This is the one degradation the brief
  // explicitly accepts, and it must be distinguishable from "someone else owns it".
  const { admin } = stubRpc({ error: { message: "db down" } });
  assertEquals(await enqueueAgentReply(admin, ITEM), null);
});

Deno.test("an RPC that answers with an unexpected shape is a failure, not ownership", async () => {
  // Fail closed on the caller's side: treating garbage as newly_enqueued=true would let
  // two invocations both believe they own the row.
  const { admin } = stubRpc({ data: [] });
  assertEquals(await enqueueAgentReply(admin, ITEM), null);
});

Deno.test("every field the agent needs survives the round trip, by value", () => {
  // Object.keys() alone would be vacuous -- it proves names exist, not that they carry the
  // right values. A media_url mapped from the caption would pass a key check.
  const args = toEnqueueArgs({
    ...ITEM,
    mediaUrl: "https://cdn/x",
    mediaKind: "audio",
    mediaCaption: "hi",
    unreadAttachments: 2,
    languageHint: "ara",
    commentId: "c-1",
  });
  assertEquals(args, {
    p_social_account_id: "acc-1",
    p_platform: "facebook",
    p_message_id: "mid-1",
    p_conversation_id: "conv-1",
    p_recipient_id: "psid-1",
    p_inbound_text: "[Image]",
    p_inbound_at: "2026-08-27T10:00:00.000Z",
    p_media: { url: "https://cdn/x", kind: "audio", caption: "hi", unread: 2, expires_at: null },
    p_language_hint: "ara",
    p_comment_id: "c-1",
  });
});

Deno.test("a text-only message carries an empty media object, not a null one", () => {
  // enqueue_agent_reply reads p_media->>'url'; a JSON null there would error, an empty
  // object yields NULL columns.
  assertEquals(toEnqueueArgs(ITEM).p_media, { url: null, kind: null, caption: null, unread: 0, expires_at: null });
});

Deno.test("advanceReply reports the database's verdict, and refuses on error", async () => {
  // This is the confirmed transition. The caller gates a side effect on it, so an RPC error
  // must read as "refused", never as "proceed".
  const transition = { id: "row-1", from: "ready_to_send", to: "sending" } as const;

  const accepted = stubRpc({ data: true });
  assert(await advanceReply(accepted.admin, transition));
  assertEquals(accepted.calls[0].name, "advance_agent_reply");
  assertEquals(accepted.calls[0].args, {
    p_id: "row-1", p_from: "ready_to_send", p_to: "sending", p_generated_reply: null, p_error: null,
  });

  const refused = stubRpc({ data: false });
  assert(!await advanceReply(refused.admin, transition));

  const errored = stubRpc({ error: { message: "db down" } });
  assert(!await advanceReply(errored.admin, transition));
});

Deno.test("advanceReply never throws, because a bookkeeping failure must not undo a delivery", async () => {
  // After the provider accepted the message, a throw here would turn a delivered reply into
  // an error response. The row is left in `sending`; its lease lapses; recovery classifies it
  // delivery_unknown -- which is exactly true.
  const admin = { rpc: () => Promise.reject(new Error("socket closed")) };
  assert(!await advanceReply(admin, { id: "row-1", from: "sending", to: "sent" }));
});
