// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  cancelOutboxRow,
  deliverGeneratedReply,
  deliverStoredReply,
  releaseAfterError,
  takeOutboxRow,
} from "./outbox.ts";

const REPLY = { text: "hello", toolCalls: [] };

const NOTICE = "تم تحويل محادثتك لفريقنا";

const ACK_CLAIM = {
  userId: "user-1",
  platform: "whatsapp",
  conversationId: "conversation-1",
  claimToken: "2026-11-13T08:00:00.000Z",
};

/**
 * A stub that plays the database's part faithfully: advance_agent_reply only succeeds when
 * the row really is in the from-state, and records every transition in order. That is what
 * lets these tests assert ORDER -- the property the whole design rests on.
 */
function stubOutbox(
  initial:
    | {
      status: string;
      generated_reply?: string | null;
      generated_tool_calls?: unknown[] | null;
      generated_kind?: string | null;
      /** The tenant that owns the row. Every transition is bound to it. */
      user_id?: string;
    }
    | null,
  options: {
    /**
     * Whether the acknowledgement claim this caller holds is the live one. False is a
     * completion that fails: the notice must not become durable either.
     */
    ackClaimLive?: boolean;
  } = {},
) {
  const row = initial ? { user_id: "user-1", ...initial } : null;
  const transitions: string[] = [];
  /** The escalation windows a reply resolved, in the order they were written. */
  const escalations: Array<{
    threadId: string;
    userId: string;
    since: string;
    claimToken: string;
  }> = [];
  /** The acknowledgement claims a notice spent. */
  const acks: Array<{ conversationId: string; claimToken: string }> = [];
  type RpcResult = Promise<{ data: unknown; error: { message: string } | null }>;
  const admin = {
    rpc: (name: string, args: Record<string, unknown>): RpcResult => {
      if (
        name !== "advance_agent_reply_for_owner" &&
        name !== "advance_agent_reply_kind_for_owner" &&
        name !== "claim_agent_reply_for_delivery_for_owner" &&
        name !== "persist_human_mode_ack_and_complete_claim" &&
        name !== "persist_agent_reply_and_complete_escalation"
      ) {
        throw new Error(`unexpected rpc ${name}`);
      }
      // Every transition is bound to a tenant: the row has to belong to it. A row of
      // another tenant is not moved, whatever state it is in.
      if (String(args.p_user_id ?? "") !== String(row?.user_id ?? "")) {
        transitions.push(`REFUSED ${args.p_from}->${args.p_to}`);
        return Promise.resolve({ data: false, error: null });
      }
      if (name === "claim_agent_reply_for_delivery_for_owner") {
        // The claim carries the payload the caller read: the row is only moved while it
        // still holds exactly that text and that kind. A row whose payload was replaced
        // is not moved, and nothing is sent.
        const holdsPayload =
          row &&
          row.status === args.p_from &&
          (row.generated_reply ?? null) === (args.p_expected_reply ?? null) &&
          (row.generated_kind ?? null) === (args.p_expected_kind ?? null);
        if (!holdsPayload) {
          transitions.push(`REFUSED ${args.p_from}->${args.p_to}`);
          return Promise.resolve({ data: false, error: null });
        }
        row!.status = String(args.p_to);
        transitions.push(`${args.p_from}->${args.p_to}`);
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "persist_human_mode_ack_and_complete_claim") {
        // The notice and the claim it spends are ONE statement, and the claim has to be
        // the live one: a notice persisted with its claim still owed is a notice the
        // next turn sends again.
        if (!row || row.status !== args.p_from || options.ackClaimLive === false) {
          transitions.push(`REFUSED ${args.p_from}->${args.p_to}`);
          return Promise.resolve({ data: false, error: null });
        }
        row.status = String(args.p_to);
        if (typeof args.p_generated_reply === "string") row.generated_reply = args.p_generated_reply;
        if (typeof args.p_generated_kind === "string") row.generated_kind = args.p_generated_kind;
        acks.push({
          conversationId: String(args.p_conversation_id),
          claimToken: String(args.p_claim_token),
        });
        transitions.push(`${args.p_from}->${args.p_to}+ack`);
        return Promise.resolve({ data: true, error: null });
      }
      if (row && row.status === args.p_from) {
        row.status = String(args.p_to);
        if (typeof args.p_generated_reply === "string") row.generated_reply = args.p_generated_reply;
        if (typeof args.p_generated_kind === "string") row.generated_kind = args.p_generated_kind;
        if (name === "persist_agent_reply_and_complete_escalation") {
          // The reply and the window it resolves are ONE statement, so the marker is
          // consumed by the same call that writes the text. There is no boundary between
          // them for a worker to die in.
          escalations.push({
            threadId: String(args.p_thread_id),
            userId: String(args.p_user_id),
            since: String(args.p_since),
            claimToken: String(args.p_claim_token),
          });
          transitions.push(`${args.p_from}->${args.p_to}+escalation`);
        } else {
          transitions.push(`${args.p_from}->${args.p_to}`);
        }
        return Promise.resolve({ data: true, error: null });
      }
      transitions.push(`REFUSED ${args.p_from}->${args.p_to}`);
      return Promise.resolve({ data: false, error: null });
    },
    from: (table: string) => {
      if (table !== "pending_agent_replies") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }),
        }),
      };
    },
  };
  // The stub is handed over twice: `admin` is the client the module under test
  // takes, and `stub` is the same object with its own shape, so a test can
  // replace a method without restating the client's whole signature.
  return { admin: admin as unknown as SupabaseClient, stub: admin, row, transitions, escalations, acks };
}

Deno.test("a send is wrapped in three durable steps, in that order, and sends once", async () => {
  const { admin, transitions } = stubOutbox({ status: "running" });
  const sends: string[] = [];
  const send = (text: string) => {
    // The assertion that matters: by the time the provider is called, the row already says
    // `sending`. A kill from here on leaves a state recovery reads as delivery_unknown.
    assertEquals(transitions, ["running->ready_to_send", "ready_to_send->sending"]);
    sends.push(text);
    return Promise.resolve("wamid.1");
  };
  const delivered = await deliverGeneratedReply(admin, "row-1", REPLY, send);
  assertEquals(delivered.messageId, "wamid.1");
  assertEquals(delivered.text, "hello");
  assertEquals(delivered.kind, "reply");
  assertEquals(sends, ["hello"]);
  assertEquals(transitions, ["running->ready_to_send", "ready_to_send->sending", "sending->sent"]);
});

Deno.test("a reply that cannot be persisted is NOT sent", async () => {
  // The row is not in `running`, so the first transition is refused. An unpersisted reply
  // that goes out is one nothing can reconcile afterwards; the recovery pass is the better
  // outcome for the customer than a message no record exists of.
  const { admin } = stubOutbox({ status: "pending" });
  let sent = 0;
  await assertRejects(
    () => deliverGeneratedReply(admin, "row-1", REPLY, () => { sent++; return Promise.resolve("x"); }),
    Error,
    "persist",
  );
  assertEquals(sent, 0);
});

Deno.test("a row another worker is already delivering is NOT sent again", async () => {
  // The redelivery race: two recovery workers hold the same stored text, and one has already
  // moved the row to `sending`. ready_to_send -> sending refused means the other won. Two
  // workers both sending is the duplicate reply this exists to prevent.
  const { admin, transitions } = stubOutbox({ status: "sending", generated_reply: "hello" });
  let sent = 0;
  await assertRejects(
    () => deliverStoredReply(
      admin,
      "row-1",
      { text: "hello", kind: "reply" },
      () => { sent++; return Promise.resolve("x"); },
    ),
    Error,
    "already delivering",
  );
  assertEquals(sent, 0);
  assertEquals(transitions, ["REFUSED ready_to_send->sending"]);
});

Deno.test("a delivery whose text was replaced in the meantime is NOT sent", async () => {
  // The row's text is read without a lock, so a closed gate can replace it between the
  // read and the claim -- the row stays `ready_to_send`, so the replacement is not
  // refused. A delivery that sent the OLD text would hand the customer the answer the
  // closed gate was meant to block, and the notice would never go out.
  const { admin, stub, row } = stubOutbox({ status: "ready_to_send", generated_reply: "the answer" });
  const original = stub.rpc;
  let calls = 0;
  stub.rpc = (name: string, args: Record<string, unknown>) => {
    calls += 1;
    if (calls === 1 && name === "claim_agent_reply_for_delivery_for_owner") {
      // The closed gate takes the row's place with the notice it owes.
      row!.generated_reply = NOTICE;
      row!.generated_kind = "human_mode_ack";
    }
    return original(name, args);
  };

  const entry = await takeOutboxRow(admin, "row-1");
  if (entry.mode !== "redeliver") throw new Error("the row was expected to be redelivered");
  let sent = 0;
  await assertRejects(
    () => deliverStoredReply(
      admin,
      "row-1",
      { text: entry.text, kind: entry.kind },
      () => { sent++; return Promise.resolve("x"); },
    ),
    Error,
    "not deliverable",
  );
  // Nothing went out, and the row still holds the notice for the turn that owes it.
  assertEquals(sent, 0);
  assertEquals(row?.status, "ready_to_send");
  assertEquals(row?.generated_reply, NOTICE);
});

Deno.test("a delivery whose KIND changed is refused as well", async () => {
  // The kind is part of the payload: the row that holds the notice must never be sent
  // as an answer, and the row that holds an answer must never be sent as the notice.
  const { admin, row } = stubOutbox({
    status: "ready_to_send",
    generated_reply: NOTICE,
    generated_kind: "human_mode_ack",
  });
  let sent = 0;
  await assertRejects(
    () => deliverStoredReply(
      admin,
      "row-1",
      { text: NOTICE, kind: "reply" },
      () => { sent++; return Promise.resolve("x"); },
    ),
    Error,
    "not deliverable",
  );
  assertEquals(sent, 0);
  assertEquals(row?.status, "ready_to_send");
});

Deno.test("the delivery reports the text and the kind the ROW holds", async () => {
  // The caller writes the thread turn and the log from what it sent, so it has to be
  // what the row holds -- not what this invocation remembers.
  const { admin } = stubOutbox({
    status: "ready_to_send",
    generated_reply: NOTICE,
    generated_kind: "human_mode_ack",
  });

  const delivered = await deliverStoredReply(
    admin,
    "row-1",
    { text: NOTICE, kind: "human_mode_ack" },
    () => Promise.resolve("wamid.3"),
  );

  assertEquals(delivered.messageId, "wamid.3");
  assertEquals(delivered.text, NOTICE);
  assertEquals(delivered.kind, "human_mode_ack");
});

Deno.test("the notice and the claim it spends are written by ONE statement", async () => {
  // A notice that is durable with its claim still owed is a notice the next turn sends
  // again: the customer is told twice that a human has the conversation. The notice and
  // the completion of the claim it spends are therefore one statement.
  const { admin, row, transitions, acks } = stubOutbox({ status: "running" });

  const delivered = await deliverGeneratedReply(
    admin,
    "row-1",
    { text: NOTICE, toolCalls: [], kind: "human_mode_ack", humanModeAck: ACK_CLAIM },
    () => Promise.resolve("wamid.4"),
  );

  assertEquals(acks, [{ conversationId: ACK_CLAIM.conversationId, claimToken: ACK_CLAIM.claimToken }]);
  assertEquals(transitions, [
    "running->ready_to_send+ack",
    "ready_to_send->sending",
    "sending->sent",
  ]);
  assertEquals(row?.generated_reply, NOTICE);
  assertEquals(row?.generated_kind, "human_mode_ack");
  assertEquals(delivered.kind, "human_mode_ack");
});

Deno.test("a notice whose claim could not be spent is neither persisted nor sent", async () => {
  // The completion failed: the claim this caller holds is not the live one. The notice
  // must not become durable either -- a durable notice with an owed claim is the second
  // notice the customer gets.
  const { admin, row, transitions } = stubOutbox({ status: "running" }, { ackClaimLive: false });

  let sent = 0;
  await assertRejects(
    () => deliverGeneratedReply(
      admin,
      "row-1",
      { text: NOTICE, toolCalls: [], kind: "human_mode_ack", humanModeAck: ACK_CLAIM },
      () => { sent++; return Promise.resolve("x"); },
    ),
    Error,
    "persist",
  );

  assertEquals(sent, 0);
  assertEquals(row?.status, "running");
  assertEquals(row?.generated_reply, undefined);
  assertEquals(transitions, ["REFUSED running->ready_to_send"]);
});

Deno.test("a notice with no claim at all is never persisted", async () => {
  // There is nothing to spend, so there is nothing that makes the notice single-flight.
  // The work item stays unsettled and the outbox tries again.
  const { admin, row } = stubOutbox({ status: "running" });

  await assertRejects(
    () => deliverGeneratedReply(
      admin,
      "row-1",
      { text: NOTICE, toolCalls: [], kind: "human_mode_ack" },
      () => Promise.resolve("wamid.5"),
    ),
    Error,
    "claim",
  );

  assertEquals(row?.status, "running");
  assertEquals(row?.generated_reply, undefined);
});

Deno.test("a provider that throws leaves the row delivery_unknown, never ready_to_send", async () => {
  // A throw after the platform accepted the message is indistinguishable from one that never
  // reached it. Recovery must not guess: delivery_unknown goes to a human.
  const { admin, row } = stubOutbox({ status: "running" });
  await assertRejects(
    () => deliverGeneratedReply(admin, "row-1", REPLY, () => Promise.reject(new Error("socket reset"))),
    Error,
    "socket reset",
  );
  assertEquals(row?.status, "delivery_unknown");
});

Deno.test("a failed sending->sent bookkeeping update does not undo a delivery", async () => {
  // After the provider accepted the message, the last transition is deliberately unchecked.
  const { admin, stub } = stubOutbox({ status: "running" });
  let calls = 0;
  const original = stub.rpc;
  stub.rpc = (name: string, args: Record<string, unknown>) => {
    calls++;
    if (args.p_to === "sent") return Promise.resolve({ data: null, error: { message: "db down" } });
    return original(name, args);
  };
  const delivered = await deliverGeneratedReply(admin, "row-1", REPLY, () => Promise.resolve("wamid.2"));
  assertEquals(delivered.messageId, "wamid.2");
  assertEquals(calls, 3);
});

Deno.test("takeOutboxRow: a ready_to_send row is redelivered without the agent", async () => {
  const { admin, transitions, row } = stubOutbox({ status: "ready_to_send", generated_reply: "stored text" });
  assertEquals(await takeOutboxRow(admin, "row-1"), {
    mode: "redeliver",
    text: "stored text",
    toolCalls: null,
    kind: "reply",
  });
  // No transition at all, and the row is still ready_to_send. Claiming it into `running`
  // here would let the caller fall through to generation -- repeating the tool calls and
  // escalations the first attempt already performed, which is the whole failure the
  // two-stage design exists to prevent.
  assertEquals(transitions, []);
  assertEquals(row?.status, "ready_to_send");
});

Deno.test("a redelivery carries the tools the ORIGINAL generation ran", async () => {
  // The redelivering invocation runs no tools of its own. Without carrying the originals,
  // the thread row it writes claims the answer came from nowhere -- an audit trail that is
  // wrong for exactly the replies that needed recovering.
  const calls = [{ name: "escalate_to_human", arguments: {} }];
  const { admin } = stubOutbox({ status: "ready_to_send", generated_reply: "hi", generated_tool_calls: calls });
  assertEquals(await takeOutboxRow(admin, "row-1"), {
    mode: "redeliver",
    text: "hi",
    toolCalls: calls,
    kind: "reply",
  });
});

Deno.test("a redelivery says whether the stored text is the handoff notice", async () => {
  // A gate that is closed for an answer the model produced is not closed for the notice a
  // human takeover owes the customer, so the row has to say which one it holds.
  const { admin } = stubOutbox({
    status: "ready_to_send",
    generated_reply: "تم تحويل محادثتك لفريقنا",
    generated_kind: "human_mode_ack",
  });
  assertEquals(await takeOutboxRow(admin, "row-1"), {
    mode: "redeliver",
    text: "تم تحويل محادثتك لفريقنا",
    toolCalls: null,
    kind: "human_mode_ack",
  });
});

Deno.test("the reply and the tools that produced it are persisted in one statement", async () => {
  // Two statements could leave text without its provenance if the second failed.
  let saved: Record<string, unknown> | null = null;
  const { admin, stub } = stubOutbox({ status: "running" });
  const original = stub.rpc;
  stub.rpc = (name: string, args: Record<string, unknown>) => {
    if (args.p_to === "ready_to_send") saved = args;
    return original(name, args);
  };
  const calls = [{ name: "lookup_order", arguments: { id: 7 } }];
  await deliverGeneratedReply(admin, "row-1", { text: "hi", toolCalls: calls }, () => Promise.resolve("m1"));
  assertEquals(saved!.p_generated_reply, "hi");
  assertEquals(saved!.p_tool_calls, calls);
});

Deno.test("the reply and the escalation window it resolves are written by ONE statement", async () => {
  // A worker killed between "the reply is durable" and "the window is consumed" leaves
  // the apology owed a second time: the reply is redelivered, and a later turn takes the
  // marker over once its lease lapses and apologises for the same window again. One
  // statement has no such boundary.
  const { admin, row, transitions, escalations } = stubOutbox({ status: "running" });

  await deliverGeneratedReply(
    admin,
    "row-1",
    {
      text: "نعتذر على التأخير",
      toolCalls: [],
      escalation: {
        threadId: "thread-1",
        userId: "user-1",
        since: "2026-11-12T08:00:00.000Z",
        // The lease this turn holds on the marker. The marker alone cannot say WHICH
        // lease is being consumed.
        claimToken: "2026-11-12T08:00:01.000Z",
      },
    },
    () => Promise.resolve("m1"),
  );

  assertEquals(row?.status, "sent");
  assertEquals(transitions, [
    "running->ready_to_send+escalation",
    "ready_to_send->sending",
    "sending->sent",
  ]);
  assertEquals(escalations, [
    {
      threadId: "thread-1",
      userId: "user-1",
      since: "2026-11-12T08:00:00.000Z",
      claimToken: "2026-11-12T08:00:01.000Z",
    },
  ]);
});

Deno.test("a reply that resolves no window consumes no marker", async () => {
  const { admin, transitions, escalations } = stubOutbox({ status: "running" });

  await deliverGeneratedReply(admin, "row-1", REPLY, () => Promise.resolve("m1"));

  assertEquals(escalations, []);
  assertEquals(transitions, ["running->ready_to_send", "ready_to_send->sending", "sending->sent"]);
});

Deno.test("takeOutboxRow: a pending row is claimed into running before any tool can fire", async () => {
  const { admin, row, transitions } = stubOutbox({ status: "pending" });
  assertEquals(await takeOutboxRow(admin, "row-1"), { mode: "generate" });
  assertEquals(row?.status, "running");
  assertEquals(transitions, ["pending->running"]);
});

Deno.test("takeOutboxRow: anything else is refused, and nothing runs", async () => {
  // A row in `running` means a previous attempt may have fired tools; in `sending` an attempt
  // was in flight; terminal states are terminal. None of these may re-enter generation.
  for (const status of ["running", "sending", "sent", "delivery_unknown", "failed", "cancelled"]) {
    const { admin, transitions } = stubOutbox({ status, generated_reply: "x" });
    assertEquals(await takeOutboxRow(admin, "row-1"), { mode: "refuse", status }, status);
    assert(transitions.every((t) => t.startsWith("REFUSED")), `${status} must not transition`);
  }
});

Deno.test("takeOutboxRow: a missing row is refused rather than treated as fresh", async () => {
  const { admin } = stubOutbox(null);
  assertEquals(await takeOutboxRow(admin, "row-1"), { mode: "refuse", status: "missing" });
});

Deno.test("a closed gate cancels the row from whatever state it is actually in", async () => {
  // The delivery gates (agent disabled, cooldown, daily cap, human takeover) run BEFORE
  // takeOutboxRow, so the row is `pending` on a fresh message but `ready_to_send` on a
  // redelivery. Assuming "pending" silently refused the cancel on the redelivery path,
  // leaving the row to lapse and re-hit the same gate until its attempts ran out -- the
  // customer's outcome arrived as `recovery_failed` three attempts late instead of
  // `cancelled` at once.
  for (const status of ["pending", "ready_to_send", "running"]) {
    const { admin, row } = stubOutbox({ status, generated_reply: "hi" });
    await cancelOutboxRow(admin, "row-1", "daily_cap_reached");
    assertEquals(row?.status, "cancelled", `from ${status}`);
  }
});

Deno.test("a row past the point of no send is never rewritten as cancelled", async () => {
  // advance_agent_reply enforces the FROM state but not which pairs are legal, so a stale
  // caller could otherwise turn `sending` -- a reply the customer may already have -- into a
  // record saying nothing was attempted. That is the one lie this table must never tell.
  for (const status of ["sending", "sent", "delivery_unknown", "failed", "cancelled"]) {
    const { admin, row } = stubOutbox({ status, generated_reply: "hi" });
    await cancelOutboxRow(admin, "row-1", "daily_cap_reached");
    assertEquals(row?.status, status, `${status} must survive a stale cancel`);
  }
});

Deno.test("cancelling a row that no longer exists is a no-op, not a throw", async () => {
  // The caller is on its way to returning a response to Meta; a missing row must not
  // become an exception that replaces a legitimate skip.
  const { admin } = stubOutbox(null);
  await cancelOutboxRow(admin, "row-1", "agent_disabled");
});

Deno.test("releaseAfterError: no tool fired -> back to pending, so recovery can retry", async () => {
  // Knowable in-process: this attempt is still alive to say so. A killed process cannot,
  // which is why the lapsed `running` case is handed to a human instead.
  const { admin, row } = stubOutbox({ status: "running" });
  await releaseAfterError(admin, "row-1", { sideEffectsHappened: false, error: "provider 503" });
  assertEquals(row?.status, "pending");
});

Deno.test("releaseAfterError: a tool fired -> stays running, for a human", async () => {
  const { admin, row } = stubOutbox({ status: "running" });
  await releaseAfterError(admin, "row-1", { sideEffectsHappened: true, error: "provider 503" });
  assertEquals(row?.status, "running");
});

Deno.test("a move for another tenant is refused, and the row is untouched", async () => {
  // Every transition is bound to a tenant: the row has to belong to the one the caller
  // names. A row of another tenant is not moved, whatever state it is in -- and nothing
  // is sent on it either.
  const { admin, row, transitions } = stubOutbox({ status: "running" });
  let sent = 0;
  await assertRejects(
    () => deliverGeneratedReply(
      admin,
      "row-1",
      REPLY,
      () => { sent++; return Promise.resolve("x"); },
      "user-2",
    ),
    Error,
    "persist",
  );
  assertEquals(sent, 0);
  assertEquals(row?.status, "running");
  assertEquals(transitions, ["REFUSED running->ready_to_send"]);
});

Deno.test("a move that names no tenant takes the row's own", async () => {
  // A caller that does not know whose reply it is moving gets the row's own tenant, so
  // the move is bound to a tenant either way.
  const { admin, row, transitions } = stubOutbox({ status: "running" });
  await deliverGeneratedReply(admin, "row-1", REPLY, () => Promise.resolve("wamid.6"));
  assertEquals(row?.status, "sent");
  assertEquals(transitions, ["running->ready_to_send", "ready_to_send->sending", "sending->sent"]);
});
