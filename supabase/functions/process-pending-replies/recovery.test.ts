// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  canStartAnotherRow,
  decideRecovery,
  isOutsideSendWindow,
  RECOVERY_LIMITS,
  type RecoveryContext,
  type RecoveryRow,
} from "./recovery.ts";

const FRESH: RecoveryContext = {
  humanTookOver: false,
  newerPendingInConversation: false,
  outsideSendWindow: false,
};

function row(status: string, overrides: Partial<RecoveryRow> = {}): RecoveryRow {
  return {
    id: "row-1",
    status,
    generated_reply: "hi",
    inbound_at: "2026-08-27T10:00:00.000Z",
    comment_id: null,
    ...overrides,
  };
}

Deno.test("the lapsed state alone decides what recovery may do", () => {
  // This table IS the safety argument, so it is asserted as a table. Inferring "did anything
  // external happen" from tool-call LOGS cannot work: a worker can call a tool and die
  // before logOutcome ever runs, leaving a row that looks untouched. Only the durable state
  // knows.
  const cases: [string, string][] = [
    ["pending", "rerun_agent"], // nothing external has happened
    ["running", "hand_to_human"], // a tool or escalation MAY have fired
    ["ready_to_send", "deliver_stored"], // text exists, no delivery attempted
    ["sending", "delivery_unknown"], // an attempt was in flight; never re-send
  ];
  for (const [status, expected] of cases) {
    assertEquals(decideRecovery(row(status), FRESH).kind, expected, `lapsed in ${status}`);
  }
});

Deno.test("a sending row is never re-delivered, even though the text is right there", () => {
  // The tempting wrong move. The stored reply is valid and delivery "probably" failed --
  // but "probably" is how a customer gets the same answer twice.
  assertEquals(decideRecovery(row("sending"), FRESH).kind, "delivery_unknown");
});

Deno.test("ambiguity outranks the conversation's situation", () => {
  // A human taking over does not make a possibly-delivered message undelivered. sending and
  // running are settled before any context is read.
  const takenOver = { ...FRESH, humanTookOver: true };
  assertEquals(decideRecovery(row("sending"), takenOver).kind, "delivery_unknown");
  assertEquals(decideRecovery(row("running"), takenOver).kind, "hand_to_human");
});

Deno.test("a conversation a human took over is cancelled, not answered", () => {
  const action = decideRecovery(row("pending"), { ...FRESH, humanTookOver: true });
  assertEquals(action, { kind: "cancel", reason: "human_took_over" });
});

Deno.test("a superseded message is cancelled, so replies cannot land out of order", () => {
  // Two queued messages from one customer: answering the older one after the newer produces
  // a conversation that reads backwards.
  const action = decideRecovery(row("pending"), { ...FRESH, newerPendingInConversation: true });
  assertEquals(action, { kind: "cancel", reason: "superseded" });
});

Deno.test("a reply outside the send window is cancelled, whatever state it lapsed in", () => {
  // Applies to deliver_stored too. Persisting text does not extend Meta's 24-hour service
  // window -- a stored reply that crosses it is rejected by the platform exactly like a
  // fresh one, and attempting it burns every remaining attempt to end in a 'failed' row
  // whose error explains nothing.
  for (const status of ["pending", "ready_to_send"]) {
    assertEquals(
      decideRecovery(row(status), { ...FRESH, outsideSendWindow: true }),
      { kind: "cancel", reason: "outside_send_window" },
      `lapsed in ${status}`,
    );
  }
});

Deno.test("the send window is per surface: comments have none, DMs have 24h from the inbound", () => {
  const at = Date.parse("2026-08-27T10:00:00.000Z");
  const dm = row("pending");
  assert(!isOutsideSendWindow(dm, at + 23 * 60 * 60 * 1000));
  assert(isOutsideSendWindow(dm, at + 25 * 60 * 60 * 1000));
  // A public comment reply has no window; the same age is fine.
  assert(!isOutsideSendWindow(row("pending", { comment_id: "c-1" }), at + 25 * 60 * 60 * 1000));
});

Deno.test("a ready_to_send row with no text is handed to a human, not regenerated", () => {
  // advance_agent_reply cannot produce this state; something else wrote the table. Guessing
  // "regenerate" here is exactly the tool-replay the design forbids.
  assertEquals(decideRecovery(row("ready_to_send", { generated_reply: null }), FRESH).kind, "hand_to_human");
});

Deno.test("a row is claimed only when a full row's worth of budget remains", () => {
  // Claiming charges an attempt. Starting a row the deadline will cut off means a customer
  // pays for recovery that never happened -- three of those and the reaper marks them failed
  // with no attempt ever made.
  const { budgetMs, perRowMs } = RECOVERY_LIMITS;
  assert(canStartAnotherRow(0));
  assert(canStartAnotherRow(budgetMs - perRowMs));
  assert(!canStartAnotherRow(budgetMs - perRowMs + 1));
});
