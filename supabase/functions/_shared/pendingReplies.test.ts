// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  advanceReply,
  enqueueAgentReply,
  type PendingReplyItem,
  type ReplyTransition,
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

Deno.test("a lost RESPONSE is not a lost INSERT: the retry resolves ownership", async () => {
  // Postgres can commit the row and then fail to answer. Reporting that as "no row" sends
  // the reply now AND leaves a committed pending row for recovery to send again in a few
  // minutes -- a duplicate produced by the machinery meant to prevent them. The RPC is
  // idempotent, so a second call returns the committed row.
  let calls = 0;
  const admin = {
    rpc: () => {
      calls++;
      return calls === 1
        ? Promise.resolve({ data: null, error: { message: "connection reset" } })
        : Promise.resolve({ data: [{ id: "row-1", newly_enqueued: false }], error: null });
    },
  };
  assertEquals(await enqueueAgentReply(admin, ITEM), { id: "row-1", newlyEnqueued: false });
  assertEquals(calls, 2);
});

Deno.test("when both enqueues fail, a read decides — and never claims ownership", async () => {
  // A read is a different code path from a write and usually survives when the write does
  // not. Finding the row means an earlier attempt committed, so this caller is NOT the
  // owner and must not start work the real owner may also be doing.
  let reads = 0;
  const admin = {
    rpc: () => Promise.resolve({ data: null, error: { message: "connection reset" } }),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => {
              reads++;
              return Promise.resolve({ data: { id: "row-1" }, error: null });
            },
          }),
        }),
      }),
    }),
  };
  assertEquals(await enqueueAgentReply(admin, ITEM), { id: "row-1", newlyEnqueued: false });
  assertEquals(reads, 1);
});

Deno.test("an unreadable answer is treated as unknown, not as 'no row'", async () => {
  // A response this code cannot parse says NOTHING about whether the insert committed.
  // Treating it as "no row" replies now and leaves a committed row for recovery to answer
  // again. It gets the retry and the lookup like any other ambiguous outcome.
  let calls = 0;
  const admin = {
    rpc: () => {
      calls++;
      return calls === 1
        ? Promise.resolve({ data: [{ nonsense: true }], error: null })
        : Promise.resolve({ data: [{ id: "row-1", newly_enqueued: false }], error: null });
    },
  };
  assertEquals(await enqueueAgentReply(admin, ITEM), { id: "row-1", newlyEnqueued: false });
  assertEquals(calls, 2);
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
  const transition = {
    id: "row-1",
    from: "ready_to_send",
    to: "sending",
    userId: "user-1",
  } as const;

  const accepted = stubRpc({ data: true });
  assert(await advanceReply(accepted.admin, transition));
  assertEquals(accepted.calls[0].name, "advance_agent_reply_for_owner");
  assertEquals(accepted.calls[0].args, {
    p_id: "row-1",
    p_from: "ready_to_send",
    p_to: "sending",
    p_generated_reply: null,
    p_error: null,
    p_tool_calls: null,
    p_user_id: "user-1",
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
  assert(!await advanceReply(admin, {
    id: "row-1",
    from: "sending",
    to: "sent",
    userId: "user-1",
  }));
});

// Every transition names the tenant the row belongs to, and every statement that moves a
// row binds it to that tenant. The edge functions run as the service role, which bypasses
// RLS, so the database has nothing else to go by: without the tenant, a statement that
// moved a row id would move whatever row carried that id, whoever owned it.
Deno.test("every transition carries the tenant the row belongs to", async () => {
  const kinds: { name: string; transition: ReplyTransition; rpc: string }[] = [
    {
      name: "the plain transition",
      transition: {
        id: "row-1",
        from: "pending",
        to: "running",
        userId: "user-1",
      },
      rpc: "advance_agent_reply_for_owner",
    },
    {
      name: "the kind-aware transition",
      transition: {
        id: "row-1",
        from: "running",
        to: "ready_to_send",
        generatedKind: "human_mode_ack",
        userId: "user-1",
      },
      rpc: "advance_agent_reply_kind_for_owner",
    },
    {
      name: "the delivery claim",
      transition: {
        id: "row-1",
        from: "ready_to_send",
        to: "sending",
        expectedPayload: { text: "كريم الكعب متوفر", kind: null },
        userId: "user-1",
      },
      rpc: "claim_agent_reply_for_delivery_for_owner",
    },
    {
      name: "the notice and the claim it spends",
      transition: {
        id: "row-1",
        from: "running",
        to: "ready_to_send",
        generatedReply: "تم تحويل محادثتك لفريقنا",
        generatedKind: "human_mode_ack",
        humanModeAck: {
          userId: "user-1",
          platform: "whatsapp",
          conversationId: "conversation-1",
          claimToken: "2026-11-13T08:00:00.000Z",
        },
        userId: "user-1",
      },
      rpc: "persist_human_mode_ack_and_complete_claim",
    },
    {
      name: "the replacement and the claim it spends",
      transition: {
        id: "row-1",
        from: "ready_to_send",
        to: "ready_to_send",
        generatedReply: "تم تحويل محادثتك لفريقنا",
        generatedKind: "human_mode_ack",
        replaceAndCompleteClaim: {
          userId: "user-1",
          platform: "whatsapp",
          conversationId: "conversation-1",
          claimToken: "2026-11-13T08:00:00.000Z",
        },
        userId: "user-1",
      },
      rpc: "replace_agent_reply_and_complete_claim",
    },
    {
      name: "the escalation and the window it resolves",
      transition: {
        id: "row-1",
        from: "running",
        to: "ready_to_send",
        generatedReply: "نعتذر على التأخير",
        escalation: {
          threadId: "thread-1",
          userId: "user-1",
          since: "2026-11-12T08:00:00.000Z",
          claimToken: "2026-11-12T08:00:01.000Z",
        },
        userId: "user-1",
      },
      rpc: "persist_agent_reply_and_complete_escalation",
    },
  ];

  for (const kind of kinds) {
    const { admin, calls } = stubRpc({ data: true });
    assert(await advanceReply(admin, kind.transition));
    assertEquals(calls[0].name, kind.rpc, `${kind.name} calls the tenant-bound statement`);
    assertEquals(calls[0].args.p_user_id, "user-1", `${kind.name} names the tenant`);
  }
});

// A claim that names another tenant is refused before the database is asked: the row and
// the claim would not be one fact, and the statement that spends the claim binds the row
// to the tenant the transition claims.
Deno.test("a claim that names another tenant is refused before the database is asked", async () => {
  const { admin, calls } = stubRpc({ data: true });

  const refused = await advanceReply(admin, {
    id: "row-1",
    from: "running",
    to: "ready_to_send",
    generatedReply: "نعتذر على التأخير",
    escalation: {
      threadId: "thread-1",
      userId: "user-2",
      since: "2026-11-12T08:00:00.000Z",
      claimToken: "2026-11-12T08:00:01.000Z",
    },
    userId: "user-1",
  });

  assert(!refused);
  assertEquals(calls.length, 0);
});

// The one-time notice and the claim it spends are ONE statement. A notice that is durable
// with its claim still owed is a notice the next turn sends again, and the customer is told
// twice that a human has the conversation.
Deno.test("the notice is persisted together with the claim it spends", async () => {
  const { admin, calls } = stubRpc({ data: true });

  const accepted = await advanceReply(admin, {
    id: "row-1",
    from: "running",
    to: "ready_to_send",
    generatedReply: "تم تحويل محادثتك لفريقنا",
    generatedKind: "human_mode_ack",
    humanModeAck: {
      userId: "user-1",
      platform: "whatsapp",
      conversationId: "conversation-1",
      claimToken: "2026-11-13T08:00:00.000Z",
    },
    userId: "user-1",
  });

  assert(accepted);
  assertEquals(calls[0].name, "persist_human_mode_ack_and_complete_claim");
  assertEquals(calls[0].args, {
    p_id: "row-1",
    p_from: "running",
    p_to: "ready_to_send",
    p_generated_reply: "تم تحويل محادثتك لفريقنا",
    p_error: null,
    p_tool_calls: null,
    p_generated_kind: "human_mode_ack",
    p_user_id: "user-1",
    p_platform: "whatsapp",
    p_conversation_id: "conversation-1",
    p_claim_token: "2026-11-13T08:00:00.000Z",
  });
});

// The notice that takes a stored row's place and the claim it spends are ONE statement. A
// notice that is durable with its claim still owed is a notice a later turn takes the
// expired lease over and sends again, and the customer is told twice that a human has the
// conversation.
Deno.test("the replacement is written together with the claim it spends", async () => {
  const { admin, calls } = stubRpc({ data: true });

  const accepted = await advanceReply(admin, {
    id: "row-1",
    from: "ready_to_send",
    to: "ready_to_send",
    generatedReply: "تم تحويل محادثتك لفريقنا",
    generatedKind: "human_mode_ack",
    replaceAndCompleteClaim: {
      userId: "user-1",
      platform: "whatsapp",
      conversationId: "conversation-1",
      claimToken: "2026-11-13T08:00:00.000Z",
    },
    userId: "user-1",
  });

  assert(accepted);
  assertEquals(calls[0].name, "replace_agent_reply_and_complete_claim");
  assertEquals(calls[0].args, {
    p_user_id: "user-1",
    p_id: "row-1",
    p_from: "ready_to_send",
    p_to: "ready_to_send",
    p_generated_reply: "تم تحويل محادثتك لفريقنا",
    p_error: null,
    p_tool_calls: null,
    p_generated_kind: "human_mode_ack",
    p_platform: "whatsapp",
    p_conversation_id: "conversation-1",
    p_claim_token: "2026-11-13T08:00:00.000Z",
  });
});

// The delivery claim carries the payload the caller read. The row's text is read without a
// lock, so a closed gate can replace it between the read and the claim -- the row stays in
// `ready_to_send`, so the replacement is not refused, and the delivery would send the OLD
// text.
Deno.test("the delivery claim carries the payload the caller read", async () => {
  const { admin, calls } = stubRpc({ data: true });

  const accepted = await advanceReply(admin, {
    id: "row-1",
    from: "ready_to_send",
    to: "sending",
    expectedPayload: { text: "كريم الكعب متوفر", kind: null },
    userId: "user-1",
  });

  assert(accepted);
  assertEquals(calls[0].name, "claim_agent_reply_for_delivery_for_owner");
  assertEquals(calls[0].args, {
    p_id: "row-1",
    p_from: "ready_to_send",
    p_to: "sending",
    p_expected_reply: "كريم الكعب متوفر",
    p_expected_kind: null,
    p_user_id: "user-1",
  });
});

// The marker alone cannot say WHICH lease is being consumed: two workers that leased the
// same marker hold the same marker. The token travels with the reply to the statement that
// writes it.
Deno.test("the escalation reply carries the lease token it resolves the window with", async () => {
  const { admin, calls } = stubRpc({ data: true });

  const accepted = await advanceReply(admin, {
    id: "row-1",
    from: "running",
    to: "ready_to_send",
    generatedReply: "نعتذر على التأخير",
    escalation: {
      threadId: "thread-1",
      userId: "user-1",
      since: "2026-11-12T08:00:00.000Z",
      claimToken: "2026-11-12T08:00:01.000Z",
    },
    userId: "user-1",
  });

  assert(accepted);
  assertEquals(calls[0].name, "persist_agent_reply_and_complete_escalation");
  assertEquals(calls[0].args.p_claim_token, "2026-11-12T08:00:01.000Z");
  assertEquals(calls[0].args.p_since, "2026-11-12T08:00:00.000Z");
  assertEquals(calls[0].args.p_user_id, "user-1");
});
