// supabase/functions/ai-agent-reply/handoffWindow.test.ts
//
// The two notices around a silent handoff -- the one-time acknowledgement and
// the apology after an unanswered window -- are CLAIMS, and both are spent
// before the reply they belong to is durable. These tests hold that line:
// a claim that was spent on a reply nobody received comes back, and a claim
// that was spent on a reply the outbox row still holds stays spent.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  claimHumanModeAck,
  readEscalationAftermath,
  releaseHumanModeAck,
  replyIsDurable,
  restoreUnansweredEscalation,
  settleClosedGate,
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

interface StaffRow {
  direction: string;
  from_name: string | null;
  message_text: string | null;
  created_at: string;
}

/**
 * An admin stub that answers the reads the handoff window makes and records
 * every call, so a test can see which claim was taken and which was given back.
 */
function adminStub(options: {
  marker?: string | null;
  staff?: StaffRow[];
  takeResult?: string | null;
  insertError?: { message: string } | null;
  outboxStatus?: string;
} = {}) {
  const calls: Array<{ kind: string; args?: Record<string, unknown> }> = [];
  const staff = options.staff ?? [];
  const admin = {
    from(table: string) {
      const query: Record<string, unknown> = {};
      query.eq = () => query;
      query.gt = () => query;
      query.order = () => query;
      query.limit = () => query;
      query.select = () => query;
      query.maybeSingle = () =>
        Promise.resolve({
          data: table === "ai_threads"
            ? { unanswered_escalation_since: options.marker ?? null }
            : table === "pending_agent_replies"
            ? { status: options.outboxStatus ?? "pending" }
            : null,
          error: null,
        });
      query.then = (resolve: (value: unknown) => void) =>
        resolve({ data: table === "whatsapp_messages" ? staff : [], error: null });
      return {
        select: () => query,
        insert: () => {
          calls.push({ kind: `insert:${table}` });
          return Promise.resolve({ error: options.insertError ?? null });
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ kind: `rpc:${fn}`, args });
      if (fn === "take_unanswered_escalation") {
        return Promise.resolve({ data: options.takeResult ?? null, error: null });
      }
      return Promise.resolve({ data: true, error: null });
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

Deno.test("the acknowledgement claim comes back when the notice never became durable", async () => {
  const { admin, calls } = adminStub();

  const released = await releaseHumanModeAck(admin, SCOPE);

  assertEquals(released, true);
  const rpc = calls.find((call) => call.kind === "rpc:release_human_mode_ack");
  assert(rpc, "the claim must be released through the release RPC");
  assertEquals(rpc.args, {
    p_user_id: SCOPE.userId,
    p_platform: SCOPE.platform,
    p_conversation_id: SCOPE.conversationId,
  });
});

Deno.test("the claim is only offered to a bounded human_first window", async () => {
  const { admin, calls } = adminStub();

  assertEquals(
    await claimHumanModeAck(admin, SCOPE, { gateReason: "cooldown_active", isComment: false }),
    "none",
  );
  assertEquals(calls.length, 0, "a gate that is not human_first never touches the claim");

  const claim = await claimHumanModeAck(admin, SCOPE, { gateReason: "mode_human_first", isComment: true });
  assertEquals(claim, "none");
  assertEquals(calls.length, 0, "a comment never takes the acknowledgement claim");

  const claimed = await claimHumanModeAck(admin, SCOPE, { gateReason: "mode_human_first", isComment: false });
  assertEquals(claimed, "none");
  assertEquals(calls.length, 1, "the bounded human_first window is the only one that claims");
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
  const { admin, calls } = adminStub();

  const restored = await restoreUnansweredEscalation(admin, SCOPE, THREAD_ID, "2026-11-12T08:00:00.000Z");

  assertEquals(restored, true);
  const rpc = calls.find((call) => call.kind === "rpc:restore_unanswered_escalation");
  assert(rpc, "the marker must be restored through the restore RPC");
  assertEquals(rpc.args, {
    p_thread_id: THREAD_ID,
    p_user_id: SCOPE.userId,
    p_since: "2026-11-12T08:00:00.000Z",
  });
});

Deno.test("a staff reply that lands while the model answers suppresses the apology", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  // The first read (before the model) saw no staff reply.
  const { admin } = adminStub({ marker: since, staff: [], takeResult: since });
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
    takeResult: since,
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
});

Deno.test("a window nobody answered still gets the apology", async () => {
  const since = "2026-11-12T08:00:00.000Z";
  const { admin } = adminStub({ marker: since, staff: [], takeResult: since });
  const aftermath = await readEscalationAftermath(admin, SCOPE, THREAD_ID);

  const settlement = await settleEscalationAftermath(
    admin,
    { scope: SCOPE, threadId: THREAD_ID, language: "ar" },
    aftermath,
    "كريم الكعب متوفر",
  );

  assertEquals(settlement.replyText.includes("نعتذر"), true);
  assertEquals(settlement.marker, since);
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
    takeResult: since,
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
    calls.find((call) => call.kind === "rpc:advance_agent_reply"),
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
