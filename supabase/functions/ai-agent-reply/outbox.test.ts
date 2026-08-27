// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  cancelOutboxRow,
  deliverGeneratedReply,
  deliverStoredReply,
  releaseAfterError,
  takeOutboxRow,
} from "./outbox.ts";

const REPLY = { text: "hello", toolCalls: [] };

/**
 * A stub that plays the database's part faithfully: advance_agent_reply only succeeds when
 * the row really is in the from-state, and records every transition in order. That is what
 * lets these tests assert ORDER -- the property the whole design rests on.
 */
function stubOutbox(
  initial:
    | { status: string; generated_reply?: string | null; generated_tool_calls?: unknown[] | null }
    | null,
) {
  const row = initial ? { ...initial } : null;
  const transitions: string[] = [];
  type RpcResult = Promise<{ data: unknown; error: { message: string } | null }>;
  const admin = {
    rpc: (name: string, args: Record<string, unknown>): RpcResult => {
      if (name !== "advance_agent_reply") throw new Error(`unexpected rpc ${name}`);
      if (row && row.status === args.p_from) {
        row.status = String(args.p_to);
        if (typeof args.p_generated_reply === "string") row.generated_reply = args.p_generated_reply;
        transitions.push(`${args.p_from}->${args.p_to}`);
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
  return { admin, row, transitions };
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
  const id = await deliverGeneratedReply(admin, "row-1", REPLY, send);
  assertEquals(id, "wamid.1");
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
    () => deliverStoredReply(admin, "row-1", "hello", () => { sent++; return Promise.resolve("x"); }),
    Error,
    "already delivering",
  );
  assertEquals(sent, 0);
  assertEquals(transitions, ["REFUSED ready_to_send->sending"]);
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
  const { admin } = stubOutbox({ status: "running" });
  let calls = 0;
  const original = admin.rpc;
  admin.rpc = (name: string, args: Record<string, unknown>) => {
    calls++;
    if (args.p_to === "sent") return Promise.resolve({ data: null, error: { message: "db down" } });
    return original(name, args);
  };
  const id = await deliverGeneratedReply(admin, "row-1", REPLY, () => Promise.resolve("wamid.2"));
  assertEquals(id, "wamid.2");
  assertEquals(calls, 3);
});

Deno.test("takeOutboxRow: a ready_to_send row is redelivered without the agent", async () => {
  const { admin, transitions, row } = stubOutbox({ status: "ready_to_send", generated_reply: "stored text" });
  assertEquals(await takeOutboxRow(admin, "row-1"), { mode: "redeliver", text: "stored text", toolCalls: null });
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
  assertEquals(await takeOutboxRow(admin, "row-1"), { mode: "redeliver", text: "hi", toolCalls: calls });
});

Deno.test("the reply and the tools that produced it are persisted in one statement", async () => {
  // Two statements could leave text without its provenance if the second failed.
  let saved: Record<string, unknown> | null = null;
  const { admin } = stubOutbox({ status: "running" });
  const original = admin.rpc;
  admin.rpc = (name: string, args: Record<string, unknown>) => {
    if (args.p_to === "ready_to_send") saved = args;
    return original(name, args);
  };
  const calls = [{ name: "lookup_order", arguments: { id: 7 } }];
  await deliverGeneratedReply(admin, "row-1", { text: "hi", toolCalls: calls }, () => Promise.resolve("m1"));
  assertEquals(saved!.p_generated_reply, "hi");
  assertEquals(saved!.p_tool_calls, calls);
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
