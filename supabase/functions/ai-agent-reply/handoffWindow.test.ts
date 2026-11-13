// supabase/functions/ai-agent-reply/handoffWindow.test.ts
//
// The two notices around a silent handoff -- the one-time acknowledgement and
// the apology after an unanswered window -- are CLAIMS, and both are spent
// before the reply they belong to is durable. These tests hold that line:
// a claim that was spent on a reply nobody received comes back, and a claim
// that was spent on a reply the outbox row still holds stays spent.
//
// The claims are LEASES, so a worker that is killed between the claim and the
// durable write does not swallow the notice: a later turn takes the lease over.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  claimHumanModeAck,
  claimUnansweredEscalation,
  completeHumanModeAck,
  escalationForReply,
  readEscalationAftermath,
  releaseHumanModeAck,
  releaseUnansweredEscalationClaim,
  releaseUnpersistedEscalation,
  releaseFailedEscalationTurn,
  replyIsDurable,
  settleClosedGate,
  settleStaffInterruptedTurn,
  settleClosedGateNotice,
  settleEscalationAftermath,
  storeHeldCustomerTurn,
  type HandoffScope,
} from "./handoffWindow.ts";
import { ReplyNotPersistedError } from "./outbox.ts";
import { parseAgentReplyResult } from "../_shared/agentReplyResult.ts";

const SCOPE: HandoffScope = {
  userId: "00000000-0000-0000-0000-000000000001",
  platform: "whatsapp",
  conversationId: "conversation-1",
};

const THREAD_ID = "00000000-0000-0000-0000-000000000002";

const CLAIM_TOKEN = "2026-11-13T08:00:00.000Z";

interface StaffRow {
  /** The id of the message the row came from. */
  id?: string | null;
  direction: string;
  from_name: string | null;
  message_text: string | null;
  created_at: string;
  message_type?: string | null;
  media_url?: string | null;
}

/** The id of a staff send, so a test can watch it written once. */
const STAFF_MESSAGE_ID = "11111111-1111-1111-1111-111111111111";

/**
 * An admin stub that answers the reads the handoff window makes and records
 * every call, so a test can see which claim was taken and which was given back.
 */
function adminStub(options: {
  marker?: string | null;
  staff?: StaffRow[];
  /** What the leased claim returns: the marker, and the token that identifies the lease. */
  claim?: { marker: string | null; token: string | null };
  insertError?: { message: string; code?: string } | null;
  outboxStatus?: string;
  /** The outbox row cannot be read, so its state is unknown. */
  outboxReadError?: { message: string } | null;
  /**
   * How many of the first reads of the outbox row fail. The reads after them succeed, so
   * a test can watch a hiccup heal: the first attempt must not settle anything, and the
   * next one must.
   */
  outboxReadFailures?: number;
  /** The text the outbox row already holds, and what it is. */
  storedReply?: { text: string; kind?: "reply" | "human_mode_ack" } | null;
  /** What the acknowledgement claim says about the window. */
  ackClaim?: { result: string; claimToken?: string | null };
  /** The RPC fails: the state is unknown. */
  claimError?: { message: string } | null;
  /** The thread marker cannot be read, so the window's state is unknown. */
  markerReadError?: { message: string } | null;
  /** The staff window cannot be read, so its context is unknown. */
  staffReadError?: { message: string } | null;
  /** The escalation claim RPC fails, so the window's state is unknown. */
  escalationClaimError?: { message: string } | null;
} = {}) {
  const calls: Array<{ kind: string; args?: Record<string, unknown> }> = [];
  const staff = options.staff ?? [];
  const ackClaim = options.ackClaim ?? { result: "claimed", claimToken: CLAIM_TOKEN };
  let outboxReads = 0;
  const admin = {
    from(table: string) {
      const query: Record<string, unknown> = {};
      query.eq = () => query;
      query.gt = () => query;
      query.order = () => query;
      query.limit = () => query;
      query.select = () => query;
      query.maybeSingle = () => {
        if (table !== "pending_agent_replies") {
          return Promise.resolve({
            data: table === "ai_threads" ? { unanswered_escalation_since: options.marker ?? null } : null,
            error: table === "ai_threads" ? options.markerReadError ?? null : null,
          });
        }
        outboxReads += 1;
        const readFails = options.outboxReadError
          ? true
          : outboxReads <= (options.outboxReadFailures ?? 0);
        return Promise.resolve({
          data: readFails
            ? null
            : {
              status: options.outboxStatus ?? "pending",
              generated_reply: options.storedReply?.text ?? null,
              generated_kind: options.storedReply?.kind ?? null,
            },
          error: readFails
            ? options.outboxReadError ?? { message: "connection reset" }
            : null,
        });
      };
      query.then = (resolve: (value: unknown) => void) =>
        resolve({
          data: table === "whatsapp_messages" ? staff : [],
          error: table === "whatsapp_messages" ? options.staffReadError ?? null : null,
        });
      return {
        select: () => query,
        insert: (payload?: Record<string, unknown>) => {
          calls.push({ kind: `insert:${table}`, args: payload });
          return Promise.resolve({ error: options.insertError ?? null });
        },
        upsert: (payload?: unknown, onConflict?: Record<string, unknown>) => {
          calls.push({ kind: `upsert:${table}`, args: { payload, onConflict } });
          return Promise.resolve({ error: options.insertError ?? null });
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ kind: `rpc:${fn}`, args });
      if (fn === "claim_human_mode_ack_leased") {
        if (options.claimError) return Promise.resolve({ data: null, error: options.claimError });
        return Promise.resolve({
          data: { result: ackClaim.result, claim_token: ackClaim.claimToken ?? null },
          error: null,
        });
      }
      if (fn === "claim_unanswered_escalation") {
        if (options.escalationClaimError) {
          return Promise.resolve({ data: null, error: options.escalationClaimError });
        }
        // The claim comes with the marker AND the token of the lease it took: the marker
        // alone cannot say which lease a release or a completion is about.
        return Promise.resolve({
          data: options.claim ?? { marker: null, token: null },
          error: null,
        });
      }
      if (fn === "complete_human_mode_ack" || fn === "release_human_mode_ack_claim") {
        // Only the claim the caller holds can be completed or released. A token that is
        // not the live one -- a lease that lapsed and was taken over -- touches nothing.
        const live = ackClaim.claimToken ?? null;
        const held = args.p_claim_token ?? null;
        return Promise.resolve({ data: live !== null && held === live, error: null });
      }
      return Promise.resolve({ data: true, error: null });
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

Deno.test("the acknowledgement claim comes back when the notice never became durable", async () => {
  const { admin, calls } = adminStub();

  const released = await releaseHumanModeAck(admin, SCOPE, CLAIM_TOKEN);

  assertEquals(released, true);
  const rpc = calls.find((call) => call.kind === "rpc:release_human_mode_ack_claim");
  assert(rpc, "the claim must be released through the release RPC");
  assertEquals(rpc.args, {
    p_user_id: SCOPE.userId,
    p_platform: SCOPE.platform,
    p_conversation_id: SCOPE.conversationId,
    p_claim_token: CLAIM_TOKEN,
  });
});

Deno.test("the claim is only offered to a bounded human_first window", async () => {
  const { admin, calls } = adminStub();

  const claim = await claimHumanModeAck(admin, SCOPE, { gateReason: "cooldown_active", isComment: false });
  assertEquals(claim.result, "none");
  assertEquals(calls.length, 0, "a gate that is not human_first never touches the claim");

  const comment = await claimHumanModeAck(admin, SCOPE, { gateReason: "mode_human_first", isComment: true });
  assertEquals(comment.result, "none");
  assertEquals(calls.length, 0, "a comment never takes the acknowledgement claim");

  const claimed = await claimHumanModeAck(admin, SCOPE, { gateReason: "mode_human_first", isComment: false });
  assertEquals(claimed.result, "claimed");
  assertEquals(claimed.claimToken, CLAIM_TOKEN);
  assertEquals(calls.length, 1, "the bounded human_first window is the only one that claims");
});

Deno.test("a claim that could not be read is never read as 'no window'", async () => {
  const { admin } = adminStub({ claimError: { message: "connection reset" } });

  const claim = await claimHumanModeAck(admin, SCOPE, { gateReason: "mode_human_first", isComment: false });

  assertEquals(claim.result, "failed");
});

Deno.test("a reply that was never persisted leaves the claim to be released", () => {
  // No outbox row: nothing durable exists anywhere.
  assertEquals(replyIsDurable(null, new Error("send failed")), false);
  // The outbox row exists but the text never landed in it.
  assertEquals(replyIsDurable("outbox-1", new ReplyNotPersistedError()), false);
});

Deno.test("a reply the outbox row still holds keeps its claim spent", () => {
  // The text is persisted BEFORE the send, so a failed send leaves a row
  // recovery can deliver from: the reply exists and its claim stays spent.
  assertEquals(replyIsDurable("outbox-1", new Error("send failed")), true);
});

Deno.test("the escalation marker comes back when the reply never became durable", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  const { admin, calls } = adminStub();

  const released = await releaseUnansweredEscalationClaim(admin, SCOPE, THREAD_ID, since, CLAIM_TOKEN);

  assertEquals(released, true);
  const rpc = calls.find((call) => call.kind === "rpc:release_unanswered_escalation_claim");
  assert(rpc, "the lease must be released through the release RPC");
  assertEquals(rpc.args, {
    p_thread_id: THREAD_ID,
    p_user_id: SCOPE.userId,
    p_since: since,
    // The token of the lease the caller holds: the marker alone cannot say which lease
    // is being given back.
    p_claim_token: CLAIM_TOKEN,
  });
});

Deno.test("a lease the caller does not hold is never given back", async () => {
  // A worker that outlived its lease must not free the lease the worker that replaced
  // it is working under: a third worker could claim the marker while the second is still
  // on it.
  const since = "2026-11-12T08:00:00.000Z";
  const { admin, calls } = adminStub();

  const released = await releaseUnansweredEscalationClaim(admin, SCOPE, THREAD_ID, since, null);

  assertEquals(released, false);
  assertEquals(
    calls.find((call) => call.kind === "rpc:release_unanswered_escalation_claim"),
    undefined,
    "a caller that holds no lease may not release one",
  );
});

Deno.test("the escalation marker is leased, not taken, so a killed turn leaves it owed", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  const { admin, calls } = adminStub({
    marker: since,
    claim: { marker: since, token: CLAIM_TOKEN },
  });

  const claim = await claimUnansweredEscalation(admin, SCOPE, THREAD_ID);

  assertEquals(claim.claimed, true);
  assertEquals(claim.marker, since);
  // The lease comes with the token that identifies it: the marker alone cannot say which
  // lease a later release or completion is about.
  assertEquals(claim.token, CLAIM_TOKEN);
  const rpc = calls.find((call) => call.kind === "rpc:claim_unanswered_escalation");
  assert(rpc, "the marker must be leased through the claim RPC");
  assert(
    !calls.some((call) => call.kind === "rpc:take_unanswered_escalation"),
    "the marker must not be cleared when it is claimed",
  );
});

Deno.test("a lease without a token is not a lease anybody can act on", async () => {
  // A claim that cannot be named cannot be released or completed, so it is refused
  // rather than half-honoured.
  const since = "2026-11-12T08:00:00.000Z";
  const { admin } = adminStub({ marker: since, claim: { marker: since, token: null } });

  const claim = await claimUnansweredEscalation(admin, SCOPE, THREAD_ID);

  assertEquals(claim.claimed, false);
  assertEquals(claim.marker, null);
  assertEquals(claim.token, null);
});

Deno.test("a staff reply that lands while the model answers suppresses the apology", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  // The first read (before the model) saw no staff reply.
  const { admin } = adminStub({
    marker: since,
    staff: [],
    claim: { marker: since, token: CLAIM_TOKEN },
  });
  const aftermath = await readEscalationAftermath(admin, SCOPE, THREAD_ID);
  assertEquals(aftermath.staffReplies, 0);

  // The staff reply arrives while the model is still answering.
  const late = adminStub({
    marker: since,
    staff: [{
      direction: "outbound",
      from_name: "You",
      message_text: "نعم متوفر عندنا",
      created_at: "2026-11-12T08:05:00.000Z",
    }],
    claim: { marker: since, token: CLAIM_TOKEN },
  });
  const settlement = await settleEscalationAftermath(
    late.admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب متوفر",
  );

  assertEquals(settlement.replyText, "كريم الكعب متوفر");
  assertEquals(settlement.replyText.includes("نعتذر"), false);
  assertEquals(settlement.marker, since);
  assertEquals(settlement.claimToken, CLAIM_TOKEN);
  assertEquals(settlement.staffReadFailed, false);
});

// The answer that was drafted knows nothing about a staff reply that landed while the
// model was answering, so it is reported: the caller writes it again with the reply in
// mind, because an answer that contradicts the staff is worse than a late one.
Deno.test("a staff reply that lands while the model answers is reported as late", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  const { admin } = adminStub({
    marker: since,
    staff: [],
    claim: { marker: since, token: CLAIM_TOKEN },
  });
  const aftermath = await readEscalationAftermath(admin, SCOPE, THREAD_ID);
  assertEquals(aftermath.staffTurns.length, 0);

  const late = adminStub({
    marker: since,
    staff: [{
      id: STAFF_MESSAGE_ID,
      direction: "outbound",
      from_name: "You",
      message_text: "نعم متوفر عندنا",
      created_at: "2026-11-12T08:05:00.000Z",
    }],
    claim: { marker: since, token: CLAIM_TOKEN },
  });
  const settlement = await settleEscalationAftermath(
    late.admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب غير متوفر",
  );

  assertEquals(settlement.lateStaffTurns.length, 1);
  assertEquals(settlement.lateStaffTurns[0].content, "(staff) نعم متوفر عندنا");
  // The drafted answer is reported as it is: what to do with it is the caller's.
  assertEquals(settlement.replyText, "كريم الكعب غير متوفر");
});

// The other side: a staff reply the answer WAS written against is not late.
Deno.test("a staff reply the answer was written against is not late", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  const staff: StaffRow[] = [{
    id: STAFF_MESSAGE_ID,
    direction: "outbound",
    from_name: "You",
    message_text: "نعم متوفر عندنا",
    created_at: "2026-11-12T08:05:00.000Z",
  }];
  const { admin } = adminStub({
    marker: since,
    staff,
    claim: { marker: since, token: CLAIM_TOKEN },
  });
  const aftermath = await readEscalationAftermath(admin, SCOPE, THREAD_ID);
  assertEquals(aftermath.staffTurns.length, 1);

  const settlement = await settleEscalationAftermath(
    admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب متوفر",
  );

  assertEquals(settlement.lateStaffTurns.length, 0);
});

// The staff turns are written BEFORE the reply they belong to, so a reply that never
// became durable leaves them behind and the next attempt writes them again. The turn
// carries the id of the message it replays, so the second write is refused as a
// duplicate: the thread keeps ONE copy of the staff send instead of a pile of them
// that pushes the customer's own messages out of the bounded history.
Deno.test("a retried turn stores the same staff send once, not twice", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  const staff: StaffRow[] = [{
    id: STAFF_MESSAGE_ID,
    direction: "outbound",
    from_name: "You",
    message_text: "نعم متوفر عندنا",
    created_at: "2026-11-12T08:05:00.000Z",
  }];
  const { admin, calls } = adminStub({
    marker: since,
    staff,
    claim: { marker: since, token: CLAIM_TOKEN },
  });
  const aftermath = await readEscalationAftermath(admin, SCOPE, THREAD_ID);

  const first = await settleEscalationAftermath(
    admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب متوفر",
  );
  // The reply never became durable, so the marker goes back and the turn is retried.
  assertEquals(first.staffWriteFailed, false);

  const second = await settleEscalationAftermath(
    admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب متوفر",
  );
  assertEquals(second.staffWriteFailed, false);

  const writes = calls.filter((call) => call.kind === "upsert:ai_thread_messages");
  assertEquals(writes.length, 2, "both attempts write the staff turn");
  const ids = writes.map((call) => {
    const rows = call.args?.payload as Array<Record<string, unknown>>;
    return rows[0].id;
  });
  assertEquals(ids, [STAFF_MESSAGE_ID, STAFF_MESSAGE_ID], "the same staff send, the same id");
  // And the write refuses the duplicate instead of adding a second copy.
  assertEquals(writes[0].args?.onConflict, { onConflict: "id", ignoreDuplicates: true });
});

Deno.test("a window nobody answered still gets the apology", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  const { admin } = adminStub({
    marker: since,
    staff: [],
    claim: { marker: since, token: CLAIM_TOKEN },
  });
  const aftermath = await readEscalationAftermath(admin, SCOPE, THREAD_ID);

  const settlement = await settleEscalationAftermath(
    admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب متوفر",
  );

  assertEquals(settlement.replyText.includes("نعتذر"), true);
  assertEquals(settlement.marker, since);
  assertEquals(settlement.claimToken, CLAIM_TOKEN);
  assertEquals(settlement.staffWriteFailed, false);
});

Deno.test("a staff context that could not be stored sends the marker back", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  const staff: StaffRow[] = [{
    direction: "outbound",
    from_name: "You",
    message_text: "نعم متوفر عندنا",
    created_at: "2026-11-12T08:05:00.000Z",
  }];
  const { admin } = adminStub({
    marker: since,
    staff,
    claim: { marker: since, token: CLAIM_TOKEN },
    insertError: { message: "write failed" },
  });
  const aftermath = await readEscalationAftermath(admin, SCOPE, THREAD_ID);

  const settlement = await settleEscalationAftermath(
    admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب متوفر",
  );

  assertEquals(settlement.staffWriteFailed, true);
  assertEquals(settlement.marker, since);
  // The lease comes back with the marker: the turn that gives it back has to name the
  // lease it is giving back.
  assertEquals(settlement.claimToken, CLAIM_TOKEN);
});

// A database error is not an absent window. The marker may well be set, and the apology
// and the staff context that go with it are still owed -- so a turn that cannot read the
// window may not answer as if the customer had never waited.
Deno.test("a claim that could not be read is not an absent window", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  const { admin } = adminStub({
    marker: since,
    // The lease could not be taken: the window's state is unknown.
    escalationClaimError: { message: "connection reset" },
  });
  const aftermath = await readEscalationAftermath(admin, SCOPE, THREAD_ID);
  assertEquals(aftermath.since, since);

  const settlement = await settleEscalationAftermath(
    admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب متوفر",
  );

  // The window is still owed, and the caller is told so.
  assertEquals(settlement.windowReadFailed, true);
  assertEquals(settlement.marker, null);
  assertEquals(settlement.claimToken, null);
  // The reply resolves no window: it may not consume a marker nobody could name.
  assertEquals(
    escalationForReply(settlement, { threadId: THREAD_ID, userId: SCOPE.userId }),
    null,
  );
});

Deno.test("a marker that could not be read is not an absent window", async () => {
  const { admin } = adminStub({ markerReadError: { message: "db down" } });

  const aftermath = await readEscalationAftermath(admin, SCOPE, THREAD_ID);

  assertEquals(aftermath.readFailed, true);
  assertEquals(aftermath.since, null);

  const settlement = await settleEscalationAftermath(
    admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب متوفر",
  );

  // The turn may not answer as if the customer had never waited.
  assertEquals(settlement.windowReadFailed, true);
  assertEquals(settlement.marker, null);
});

Deno.test("a staff window that could not be read is not an absent window", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  const { admin } = adminStub({ marker: since, staffReadError: { message: "db down" } });

  const aftermath = await readEscalationAftermath(admin, SCOPE, THREAD_ID);

  // The marker is known; only the staff context is missing.
  assertEquals(aftermath.readFailed, true);
  assertEquals(aftermath.since, since);

  const settlement = await settleEscalationAftermath(
    admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب متوفر",
  );

  assertEquals(settlement.windowReadFailed, true);
  assertEquals(settlement.marker, null);
});

// A customer wrote during a window that was already notified. The assistant is silent
// for the whole window, so that turn is the only durable record of a question nobody
// answered. When the write fails the question is lost for good, so the work item must
// not be settled as done -- and the caller must be told the turn failed, not that the
// reply was skipped: "skipped" is terminal and would claim the question was handled.
Deno.test("a customer turn that could not be stored keeps the work item retryable", async () => {
  const { admin, calls } = adminStub({ insertError: { message: "write failed" } });

  const settlement = await settleClosedGate({
    admin,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    humanWindow: "window",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
  });

  // The work item is not settled as done: the row stays where it is, unsettled, so the
  // outbox's own retry path may try again.
  assertEquals(settlement.cancelWorkItem, false);
  assertEquals(
    calls.find((call) => call.kind === "rpc:advance_agent_reply_for_owner"),
    undefined,
    "the work item must not be cancelled",
  );
  // The caller reads the body, not the HTTP status, so the body has to say failure.
  assertEquals(parseAgentReplyResult(200, settlement.body).kind, "retryable");

  // A turn that WAS stored leaves the closed gate terminal, as before.
  const written = await settleClosedGate({
    admin: adminStub().admin,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    humanWindow: "window",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
  });
  assertEquals(written.body, { ok: true, skipped: "mode_human_first" });
  assertEquals(written.cancelWorkItem, true);
});

// An answer the model produced under an open gate is durable in the outbox row. A human
// takeover then closes the gate, and the row is re-driven: the stored answer may NOT be
// delivered, or the customer gets an AI answer in the middle of a human handoff.
Deno.test("a closed gate never delivers an answer the row stored under an open gate", async () => {
  const { admin, calls } = adminStub({
    outboxStatus: "ready_to_send",
    storedReply: { text: "كريم الكعب متوفر", kind: "reply" },
  });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  });

  // The stored answer is not what goes out: the notice takes its place in the row.
  assertEquals(decision.kind, "notice");
  if (decision.kind !== "notice") return;
  assertEquals(decision.text.includes("كريم"), false, "the stored answer may never be delivered");
  assertEquals(decision.text.includes("تم تحويل محادثتك"), true);
  assertEquals(decision.fromRow, true);
  const replace = calls.find((call) => call.kind === "rpc:replace_agent_reply_and_complete_claim");
  assert(replace, "the notice has to take the row's place");
  assertEquals(replace.args?.p_generated_kind, "human_mode_ack");
  // The claim the notice spends is spent by the SAME statement, so a worker that dies
  // between the write and the send cannot leave a durable notice whose claim is owed.
  assertEquals(replace.args?.p_claim_token, CLAIM_TOKEN);
  assertEquals(replace.args?.p_platform, SCOPE.platform);
  assertEquals(replace.args?.p_conversation_id, SCOPE.conversationId);
});

// The claim is the authority for the notice, and the token identifies it. A claim that
// carries no token cannot be spent by this caller, so the notice is not written: a notice
// that is durable with its claim still owed is the second notice the customer gets.
Deno.test("a closed gate writes no notice when the claim carries no token", async () => {
  const { admin, calls } = adminStub({
    outboxStatus: "ready_to_send",
    storedReply: { text: "كريم الكعب متوفر", kind: "reply" },
    ackClaim: { result: "claimed", claimToken: null },
  });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  });

  assertEquals(decision.kind, "retryable");
  assertEquals(
    calls.find((call) => call.kind === "rpc:replace_agent_reply_and_complete_claim"),
    undefined,
    "the notice may not be written without the claim it spends",
  );
});

// The notice was persisted by an earlier attempt that died before the send. The row holds
// it, so the row delivers it -- exactly as it was persisted -- and the claim is spent on
// that delivery.
Deno.test("a closed gate delivers the notice the row already holds", async () => {
  const { admin } = adminStub({
    outboxStatus: "ready_to_send",
    storedReply: { text: "تم تحويل محادثتك لفريقنا", kind: "human_mode_ack" },
  });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  });

  assertEquals(decision.kind, "notice");
  if (decision.kind !== "notice") return;
  assertEquals(decision.text, "تم تحويل محادثتك لفريقنا");
  assertEquals(decision.fromRow, true);
  assertEquals(decision.claimToken, CLAIM_TOKEN);
});

// The claim was COMPLETED before the notice was sent: the worker that persisted it died
// between the two. The claim says "delivered" and the row says the notice never went
// out. Cancelling the row here would swallow the notice -- the customer would never
// learn that a human has their conversation -- so the stored notice is delivered from
// the row instead.
Deno.test("a notice that was completed but never sent is delivered from the row", async () => {
  const { admin, calls } = adminStub({
    outboxStatus: "ready_to_send",
    storedReply: { text: "تم تحويل محادثتك لفريقنا", kind: "human_mode_ack" },
    // The claim was completed by the worker that persisted the notice.
    ackClaim: { result: "delivered" },
  });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  });

  // The notice the customer was promised goes out, and it is the STORED one.
  assertEquals(decision.kind, "notice");
  if (decision.kind !== "notice") return;
  assertEquals(decision.text, "تم تحويل محادثتك لفريقنا");
  assertEquals(decision.fromRow, true);
  // The row is not cancelled: the notice it holds is still owed.
  assertEquals(
    calls.find((call) => call.args?.p_to === "cancelled"),
    undefined,
    "the row holding the notice must not be cancelled",
  );
});

// The bounded window can end before the notice is recovered: the worker that persisted
// the notice died, the window expired, and a later turn finds the promise in the row
// with no window left to claim. Cancelling the row there swallows the promise for good
// -- the customer never learns that a human has their conversation -- so the stored
// notice is delivered from the row instead.
Deno.test("a notice the bounded window outlived is delivered from the row", async () => {
  const { admin, calls } = adminStub({
    outboxStatus: "ready_to_send",
    storedReply: { text: "تم تحويل محادثتك لفريقنا", kind: "human_mode_ack" },
    // The window is gone: there is nothing left to claim.
    ackClaim: { result: "none" },
  });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  });

  // The promise is kept: the notice the customer was given goes out.
  assertEquals(decision.kind, "notice");
  if (decision.kind !== "notice") return;
  assertEquals(decision.text, "تم تحويل محادثتك لفريقنا");
  assertEquals(decision.fromRow, true);
  // And the row that holds it is not cancelled.
  assertEquals(
    calls.find((call) => call.args?.p_to === "cancelled"),
    undefined,
    "the row holding the notice must not be cancelled",
  );
});

// The other side of that promise: a row that may already have gone out is never sent
// again. `sending` and `delivery_unknown` mean an attempt was made, and the notice in
// them may already be in the customer's inbox.
Deno.test("a row past the point of no send never has the notice sent again", async () => {
  for (const status of ["sending", "delivery_unknown", "sent"]) {
    const { admin, calls } = adminStub({
      outboxStatus: status,
      storedReply: { text: "تم تحويل محادثتك لفريقنا", kind: "human_mode_ack" },
      ackClaim: { result: "claimed" },
    });

    const decision = await settleClosedGateNotice({
      admin,
      scope: SCOPE,
      outboxId: "outbox-1",
      gateReason: "mode_human_first",
      isComment: false,
      language: "ar",
      threadId: THREAD_ID,
      turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
      serviceWindowOpen: true,
    });

    // No notice: the row may already carry it to the customer.
    assertEquals(decision.kind, "skipped", `${status} must not produce a notice`);
    if (decision.kind !== "skipped") return;
    assertEquals(decision.settlement.body.ok, true);
    // And the row is neither cancelled nor rewritten.
    assertEquals(
      calls.find((call) => call.args?.p_to === "cancelled"),
      undefined,
      `${status} must not be cancelled`,
    );
  }
});

// A read that FAILED is not an empty row. Reading it as one lets the gate take the
// notice's claim and settle the work item on a row whose contents nobody could read --
// and a stored answer in that row is then delivered by the outbox, under a gate that is
// closed for it.
Deno.test("a row that could not be read settles nothing and spends no claim", async () => {
  const { admin, calls } = adminStub({ outboxReadError: { message: "db down" } });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  });

  // The work item stays unsettled: the outbox retries, and the row is read again.
  assertEquals(decision.kind, "retryable");
  // The claim is NOT spent on a row nobody could read.
  assertEquals(
    calls.find((call) => call.kind === "rpc:claim_human_mode_ack_leased"),
    undefined,
    "the claim must not be taken before the row is known",
  );
  assertEquals(
    calls.find((call) => call.args?.p_to === "cancelled"),
    undefined,
    "nothing may be cancelled on the strength of a failed read",
  );
});

// The same hiccup, one retry later: the read succeeds and the gate decides as it should.
Deno.test("a failed read followed by a successful one decides the gate", async () => {
  const { admin, calls } = adminStub({
    outboxReadFailures: 1,
    outboxStatus: "ready_to_send",
    storedReply: { text: "تم تحويل محادثتك لفريقنا", kind: "human_mode_ack" },
  });
  const gate = {
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar" as const,
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  };

  const failed = await settleClosedGateNotice(gate);
  assertEquals(failed.kind, "retryable");

  const recovered = await settleClosedGateNotice(gate);
  assertEquals(recovered.kind, "notice");
  if (recovered.kind !== "notice") return;
  assertEquals(recovered.text, "تم تحويل محادثتك لفريقنا");
  // The claim is taken exactly once: on the attempt that could read the row.
  assertEquals(
    calls.filter((call) => call.kind === "rpc:claim_human_mode_ack_leased").length,
    1,
  );
});

// The claim is a lease. A turn that was killed before the notice was durable leaves the
// lease behind, and a later turn takes it over instead of leaving the customer without
// the notice.
Deno.test("a notice another worker is delivering is left to that worker", async () => {  const { admin } = adminStub({
    outboxStatus: "ready_to_send",
    storedReply: { text: "تم تحويل محادثتك لفريقنا", kind: "human_mode_ack" },
    ackClaim: { result: "window" },
  });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  });

  // Cancelling the row here would take the notice away from the worker delivering it.
  assertEquals(decision.kind, "retryable");
});

// Two turns for the same work item. The winner holds the claim and is about to persist
// the notice into the row it took into `running`; the loser arrives, sees the claim
// already taken and the notice not yet persisted. The loser may not cancel that row:
// the winner's own persist would then be refused, and the notice would be owed to
// nobody.
Deno.test("the turn that lost the claim cannot cancel the row the winner holds", async () => {
  const { admin, calls } = adminStub({
    // The row is taken into `running` by the winner, and it holds no notice yet.
    outboxStatus: "running",
    storedReply: null,
    // Another worker holds the claim.
    ackClaim: { result: "window" },
  });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  });

  // The row another worker is holding is left alone, and the work item stays unsettled.
  assertEquals(decision.kind, "retryable");
  assertEquals(
    calls.find((call) => call.args?.p_to === "cancelled"),
    undefined,
    "the row another worker holds must not be cancelled",
  );
});

// A claim that could not be read leaves the state unknown, so nothing may be settled on
// the strength of it: the work item stays unsettled and the customer's question is not
// lost over a hiccup.
Deno.test("a closed gate that cannot read the claim keeps the work item retryable", async () => {
  const { admin } = adminStub({ claimError: { message: "connection reset" } });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  });

  assertEquals(decision.kind, "retryable");
});

// The human_first gate takes precedence over the service window, so a closed window is
// turned into the one-time notice. A notice is a free-form message, and outside the
// service window the provider refuses one: the notice may not be attempted there, and
// the acknowledgement may not be completed for a notice that was never sent.
Deno.test("a closed service window never attempts the notice", async () => {
  const { admin, calls } = adminStub({
    outboxStatus: "running",
    storedReply: null,
    ackClaim: { result: "claimed", claimToken: CLAIM_TOKEN },
  });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: false,
  });

  // No notice goes out.
  assertEquals(decision.kind, "skipped");
  assertEquals(
    calls.find((call) => call.kind === "rpc:replace_agent_reply_and_complete_claim"),
    undefined,
    "the row may not be given the notice",
  );
  // And the acknowledgement is not completed for a notice that was never attempted.
  assertEquals(
    calls.find((call) => call.kind === "rpc:complete_human_mode_ack"),
    undefined,
    "an unsent notice may not have its acknowledgement completed",
  );
  // The claim comes back, so a later turn whose window is open can still deliver it.
  assert(
    calls.find((call) => call.kind === "rpc:release_human_mode_ack_claim"),
    "the claim must be released",
  );
});

// The same gate with the window open still sends the notice: the service window is a
// delivery rule, not a reason to stop promising.
Deno.test("an open service window still sends the notice", async () => {
  const { admin } = adminStub({
    outboxStatus: "running",
    storedReply: null,
    ackClaim: { result: "claimed", claimToken: CLAIM_TOKEN },
  });

  const decision = await settleClosedGateNotice({
    admin,
    scope: SCOPE,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    isComment: false,
    language: "ar",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
    serviceWindowOpen: true,
  });

  assertEquals(decision.kind, "notice");
  if (decision.kind !== "notice") return;
  assert(decision.text.includes("تم تحويل محادثتك"), "the notice is the one the customer is promised");
});

Deno.test("the acknowledgement is only completed for the claim the caller holds", async () => {
  const { admin, calls } = adminStub();

  assertEquals(await completeHumanModeAck(admin, SCOPE, CLAIM_TOKEN), true);
  const rpc = calls.find((call) => call.kind === "rpc:complete_human_mode_ack");
  assert(rpc, "the claim must be completed through the completion RPC");
  assertEquals(rpc.args?.p_claim_token, CLAIM_TOKEN);

  // No claim, no completion: a caller that holds nothing may not consume a claim.
  const { admin: bare, calls: bareCalls } = adminStub();
  assertEquals(await completeHumanModeAck(bare, SCOPE, null), false);
  assertEquals(bareCalls.length, 0);
});

// The claim is a lease: a worker that outlived its lease does not hold the claim any
// more. Its token names a claim that was taken over, and completing or releasing that
// token would spend the claim the worker that replaced it is holding.
Deno.test("an acknowledgement claim that was taken over is not the caller's to spend", async () => {
  const stale = "2026-11-13T07:00:00.000Z";
  const live = "2026-11-13T08:00:00.000Z";
  const { admin } = adminStub({ ackClaim: { result: "claimed", claimToken: live } });

  assertEquals(await completeHumanModeAck(admin, SCOPE, stale), false);
  assertEquals(await releaseHumanModeAck(admin, SCOPE, stale), false);
  // The claim that IS live can still be spent.
  assertEquals(await completeHumanModeAck(admin, SCOPE, live), true);
});

// The turn write and the cancellation that follows it are two statements, and a worker
// killed between them leaves the work item open. Recovery re-drives it, reaches the
// same gate and stores the same question again -- so the question is stored under the
// work item's own id, and the second write is refused as a duplicate.
Deno.test("the same customer turn is stored once, however often the work item is re-driven", async () => {
  const { admin, calls } = adminStub({ insertError: { message: "duplicate key value", code: "23505" } });

  const stored = await storeHeldCustomerTurn(admin, THREAD_ID, {
    userId: SCOPE.userId,
    content: "عندكم كريم الكعب؟",
    id: "outbox-1",
  });

  // A unique violation means this exact turn is already there: the question is durable.
  assertEquals(stored.stored, true);
  const insert = calls.find((call) => call.kind === "insert:ai_thread_messages");
  assert(insert, "the turn must be written");
  assertEquals(insert.args?.id, "outbox-1", "the turn must carry the work item's own id");
});

Deno.test("a work item whose row cannot be read is not reported as settled", async () => {
  // The row's state is unknown, so the work item stays open: reporting it as skipped
  // would tell the outbox the question was handled while the row is still there.
  const { admin } = adminStub({ outboxReadError: { message: "db down" } });

  const settlement = await settleClosedGate({
    admin,
    outboxId: "outbox-1",
    gateReason: "mode_human_first",
    humanWindow: "window",
    threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "عندكم كريم الكعب؟" },
  });

  assertEquals(settlement.cancelWorkItem, false);
  assertEquals(parseAgentReplyResult(200, settlement.body).kind, "retryable");
});

// The reply carries the apology, so the reply and the window it resolves are one fact.
// The marker is consumed by the SAME statement that writes the reply: a worker killed
// between the two would leave the apology owed a second time, and the customer would be
// apologised to twice. The lease token travels with it, so a worker whose lease lapsed
// cannot consume the window a newer worker is working on.
Deno.test("the reply resolves the escalation window it was owed", () => {
  const since = "2026-11-12T08:00:00.000Z";

  assertEquals(
    escalationForReply(
      {
        replyText: "كريم الكعب متوفر",
        marker: since,
        claimToken: CLAIM_TOKEN,
        staffReadFailed: false,
        staffWriteFailed: false,
        windowReadFailed: false,
        lateStaffTurns: [],
      },
      { threadId: THREAD_ID, userId: SCOPE.userId },
    ),
    { threadId: THREAD_ID, userId: SCOPE.userId, since, claimToken: CLAIM_TOKEN },
  );

  // No window, nothing to resolve.
  assertEquals(
    escalationForReply(
      {
        replyText: "كريم الكعب متوفر",
        marker: null,
        claimToken: null,
        staffReadFailed: false,
        staffWriteFailed: false,
        windowReadFailed: false,
        lateStaffTurns: [],
      },
      { threadId: THREAD_ID, userId: SCOPE.userId },
    ),
    null,
  );

  // A window without a lease token is no window: it cannot be consumed by name, and a
  // reply that carries it would be stored against a window nobody owns.
  assertEquals(
    escalationForReply(
      {
        replyText: "كريم الكعب متوفر",
        marker: since,
        claimToken: null,
        staffReadFailed: false,
        staffWriteFailed: false,
        windowReadFailed: false,
        lateStaffTurns: [],
      },
      { threadId: THREAD_ID, userId: SCOPE.userId },
    ),
    null,
  );
});

// A staff context that could not be read or stored resolves NOTHING: the marker is what
// carries that context, so the lease goes back and a later turn stores the staff replies
// this one lost. Consuming the marker here would drop them for good.
Deno.test("a staff context that failed leaves the escalation window owed", () => {
  const since = "2026-11-12T08:00:00.000Z";

  assertEquals(
    escalationForReply(
      {
        replyText: "كريم الكعب متوفر",
        marker: since,
        claimToken: CLAIM_TOKEN,
        staffReadFailed: true,
        staffWriteFailed: false,
        windowReadFailed: false,
        lateStaffTurns: [],
      },
      { threadId: THREAD_ID, userId: SCOPE.userId },
    ),
    null,
    "a window nobody could read must not be consumed",
  );
  assertEquals(
    escalationForReply(
      {
        replyText: "كريم الكعب متوفر",
        marker: since,
        claimToken: CLAIM_TOKEN,
        staffReadFailed: false,
        staffWriteFailed: true,
        windowReadFailed: false,
        lateStaffTurns: [],
      },
      { threadId: THREAD_ID, userId: SCOPE.userId },
    ),
    null,
    "staff replies that could not be stored must not be dropped",
  );
});

Deno.test("a durable acknowledgement survives a closed service window without cancellation", async () => {
  const { admin, calls } = adminStub({ outboxStatus: "ready_to_send",
    storedReply: { text: "A human has your conversation", kind: "human_mode_ack" },
    ackClaim: { result: "delivered" } });
  const result = await settleClosedGateNotice({ admin, scope: SCOPE, outboxId: "outbox-1",
    gateReason: "mode_human_first", isComment: false, language: "en", threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "My question" }, serviceWindowOpen: false });
  assertEquals(result.kind, "retryable");
  assertEquals(calls.length, 0, "no claim, release or cancellation may erase the durable notice");
});

Deno.test("a failed staff-interruption hold leaves the customer's work retryable", async () => {
  const { admin, calls } = adminStub({ insertError: { message: "temporary write failure" }, outboxStatus: "running" });
  const result = await settleClosedGate({ admin, outboxId: "outbox-1",
    gateReason: "staff_answered_during_generation", humanWindow: "window", threadId: THREAD_ID,
    turn: { userId: SCOPE.userId, content: "My question", id: "outbox-1" } });
  assertEquals(result.body, { ok: false, error: "the customer's turn could not be stored" });
  assertEquals(result.cancelWorkItem, false);
  assertEquals(calls.some((call) => call.kind.startsWith("rpc:")), false);
});

Deno.test("a preclaimed escalation settles without a second fallible claim read", async () => {
  const marker = "2026-11-12T08:00:00Z";
  const { admin, calls } = adminStub({ escalationClaimError: { message: "late read unavailable" } });
  const result = await settleEscalationAftermath(admin, {
    scope: SCOPE, threadId: THREAD_ID, language: "en",
    claim: { marker, token: CLAIM_TOKEN, claimed: true, failed: false },
  }, { since: marker, staffReplies: 0, staffTurns: [], readFailed: false }, "Answer");
  assertEquals(result.windowReadFailed, false);
  assertEquals(result.marker, marker);
  assertEquals(result.claimToken, CLAIM_TOKEN);
  assertEquals(calls.some((call) => call.kind === "rpc:claim_unanswered_escalation"), false);
});

Deno.test("early setup failures release their escalation lease while durable replies retain it", async () => {
  for (const replyDurable of [false, true]) {
    const { admin, calls } = adminStub();
    await releaseUnpersistedEscalation(admin, SCOPE, {
      threadId: THREAD_ID, marker: "2026-11-12T08:00:00Z", claimToken: CLAIM_TOKEN, replyDurable,
    });
    assertEquals(calls.some((call) => call.kind === "rpc:release_unanswered_escalation_claim"), !replyDurable);
  }
});

Deno.test("a notice claim records its recoverable text and outbox scope together", async () => {
  const { admin, calls } = adminStub();
  await claimHumanModeAck(admin, SCOPE, {
    gateReason: "mode_human_first", isComment: false, outboxId: "outbox-1", noticeText: "One fixed notice",
  });
  const claim = calls.find((call) => call.kind === "rpc:claim_human_mode_ack_leased");
  assertEquals(claim?.args?.p_reply_id, "outbox-1");
  assertEquals(claim?.args?.p_notice_text, "One fixed notice");
});

Deno.test("a failed held-turn write requeues safe work and retains work with side effects", async () => {
  for (const sideEffectsHappened of [false, true]) {
    const { admin, calls } = adminStub({ insertError: { message: "temporary failure" }, outboxStatus: "running" });
    const held = await settleStaffInterruptedTurn({ admin, outboxId: "outbox-1", threadId: THREAD_ID,
      turn: { userId: SCOPE.userId, content: "Question", id: "outbox-1" }, sideEffectsHappened, scope: SCOPE, lease: null });
    assertEquals(held.cancelWorkItem, false);
    assertEquals(parseAgentReplyResult(200, held.body).kind, "retryable");
    const requeue = calls.find((call) => call.kind === "rpc:advance_agent_reply_for_owner");
    assertEquals(Boolean(requeue), !sideEffectsHappened);
    if (requeue) assertEquals(requeue.args?.p_to, "pending");
  }
});

Deno.test("failed work releases its escalation lease before making the row retryable", async () => {
  for (const failure of ["none", "refused", "thrown"]) {
    const { admin, calls } = adminStub();
    const rpc = admin.rpc.bind(admin);
    admin.rpc = ((fn: string, args: Record<string, unknown>) => {
      if (fn === "release_unanswered_escalation_claim") {
        calls.push({ kind: `rpc:${fn}`, args });
        if (failure === "thrown") return Promise.reject(new Error("connection reset"));
        return Promise.resolve({ data: failure === "none", error: null });
      }
      return rpc(fn, args);
    }) as typeof admin.rpc;
    const lease = { threadId: THREAD_ID, marker: CLAIM_TOKEN, claimToken: CLAIM_TOKEN, replyDurable: false };
    await releaseFailedEscalationTurn(admin, SCOPE, lease, "outbox-1", { sideEffectsHappened: false, error: "setup failed" });
    assertEquals(calls.map((call) => call.kind), failure === "none"
      ? ["rpc:release_unanswered_escalation_claim", "rpc:advance_agent_reply_for_owner"]
      : ["rpc:release_unanswered_escalation_claim"]);
    if (failure === "none") {
      await releaseUnpersistedEscalation(admin, SCOPE, lease);
      assertEquals(calls.length, 2); // Finally does not release a successfully returned token twice.
    }
  }
});

Deno.test("a turn that read an owed marker refuses a competing live escalation lease", async () => {
  const { admin } = adminStub({ claim: { marker: null, token: null } });
  assertEquals(await claimUnansweredEscalation(admin, SCOPE, THREAD_ID, true), {
    marker: null, token: null, claimed: false, failed: true,
  });
});

Deno.test("an earlier successful cleanup still permits retry after persistence or held-turn failure", async () => {
  for (const heldTurn of [false, true]) {
    const { admin, calls } = adminStub({ insertError: { message: "temporary failure" }, outboxStatus: "running" });
    const lease = { threadId: THREAD_ID, marker: CLAIM_TOKEN, claimToken: CLAIM_TOKEN, replyDurable: false };
    assertEquals(await releaseUnpersistedEscalation(admin, SCOPE, lease), true);
    if (heldTurn) {
      await settleStaffInterruptedTurn({ admin, scope: SCOPE, lease, outboxId: "outbox-1", threadId: THREAD_ID,
        sideEffectsHappened: false, turn: { userId: SCOPE.userId, content: "Question", id: "outbox-1" } });
    } else {
      await releaseFailedEscalationTurn(admin, SCOPE, lease, "outbox-1", { sideEffectsHappened: false, error: "persist failed" });
    }
    assertEquals(calls.filter((call) => call.kind === "rpc:release_unanswered_escalation_claim").length, 1);
    assertEquals(calls.find((call) => call.kind === "rpc:advance_agent_reply_for_owner")?.args?.p_to, "pending");
  }
});
