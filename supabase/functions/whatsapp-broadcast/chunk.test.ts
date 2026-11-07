import { assertEquals } from "jsr:@std/assert@1";
import {
  BROADCAST_SEND_RESERVE_MS,
  runBroadcastChunk,
  type BroadcastChunkPorts,
} from "./chunk.ts";
import type { BroadcastRecipient } from "./handler.ts";

const NOW = 1_700_000_000_000;
const DEADLINE = NOW + 60_000;
const USER = "user-1";

interface FakeState {
  recipients: BroadcastRecipient[];
  status: Map<string, string>;
  calls: string[];
  posted: string[];
  sent: string[];
  failed: Array<{ id: string; message: string }>;
  outbound: Array<Record<string, unknown>>;
  logs: Array<{ reason: string; metadata: Record<string, unknown> }>;
}

function fakePorts(overrides: Partial<BroadcastChunkPorts> = {}, hooks: { onBeginSend?: () => void } = {}) {
  const state: FakeState = {
    recipients: [],
    status: new Map(),
    calls: [],
    posted: [],
    sent: [],
    failed: [],
    outbound: [],
    logs: [],
  };
  const clock = { value: NOW };
  const accounts = [{
    id: "account-1",
    access_token: "cloud-token",
    platform_user_id: "phone-number-id",
    account_metadata: {},
  }];

  const ports: BroadcastChunkPorts = {
    now: () => clock.value,
    loadBroadcast: async () => ({
      id: "b1",
      user_id: USER,
      status: "sending",
      name: "Promo",
      template_name: "hello",
      template_components: { language: "en_US" },
      sent_count: 0,
      failed_count: 0,
    }),
    loadWhatsAppAccounts: async () => accounts,
    // The SQL settles every row that is still 'sending' as outcome_unknown.
    failStaleSends: async () => {
      state.calls.push("failStaleSends");
      let count = 0;
      for (const recipient of state.recipients) {
        if (state.status.get(recipient.id) !== "sending") continue;
        state.status.set(recipient.id, "failed");
        state.failed.push({ id: recipient.id, message: "outcome_unknown" });
        count++;
      }
      return count;
    },
    loadPendingRecipients: async () => {
      state.calls.push("loadPendingRecipients");
      return state.recipients.filter((r) => state.status.get(r.id) === "pending");
    },
    optedOutPhones: async () => new Set<string>(),
    skipRecipients: async (_broadcastId, ids) => {
      state.calls.push("skipRecipients");
      for (const id of ids) state.status.set(id, "skipped");
    },
    logSendRefused: async (input) => {
      state.calls.push("logSendRefused");
      state.logs.push({ reason: input.reason, metadata: input.metadata });
    },
    beginSend: async (id) => {
      state.calls.push(`beginSend:${id}`);
      if (state.status.get(id) !== "pending") return false;
      state.status.set(id, "sending");
      hooks.onBeginSend?.();
      return true;
    },
    markRecipientSent: async (id) => {
      state.calls.push(`markRecipientSent:${id}`);
      state.status.set(id, "sent");
      state.sent.push(id);
    },
    markRecipientFailed: async (id, message) => {
      state.calls.push(`markRecipientFailed:${id}`);
      state.status.set(id, "failed");
      state.failed.push({ id, message });
    },
    insertOutbound: async (row) => {
      state.calls.push("insertOutbound");
      state.outbound.push(row);
    },
    postTemplate: async () => {
      state.calls.push("postTemplate");
      state.posted.push("posted");
      return { ok: true, data: { messages: [{ id: "wamid" }] } };
    },
    refreshTotals: async (_broadcastId, finish) => {
      const count = (status: string) =>
        state.recipients.filter((r) => state.status.get(r.id) === status).length;
      const sent = count("sent");
      const failed = count("failed");
      const skipped = count("skipped");
      const pending = count("pending") + count("sending");
      return {
        sent,
        failed,
        skipped,
        pending,
        final_status: finish ? (sent === 0 && failed > 0 ? "failed" : "completed") : null,
      };
    },
    sleep: async () => {},
  };

  return { ports: Object.assign(ports, overrides), state, clock };
}

/** "+965 5000-0001" for r1, "+965 5000-0002" for r2 and so on. */
function recipients(...ids: string[]): BroadcastRecipient[] {
  return ids.map((id) => ({ id, phone_number: `+965 5000-${id.slice(1).padStart(4, "0")}` }));
}

function seed(state: FakeState, list: BroadcastRecipient[]): void {
  state.recipients = list;
  for (const r of list) state.status.set(r.id, "pending");
}

Deno.test("sends every pending recipient once and finishes completed", async () => {
  const { ports, state } = fakePorts();
  seed(state, recipients("r1", "r2", "r3"));

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(outcome, {
    kind: "done",
    result: { sent: 3, failed: 0, skipped: 0, status: "completed" },
  });
  assertEquals(state.posted.length, 3);
  assertEquals(state.sent, ["r1", "r2", "r3"]);
});

Deno.test("a recipient another worker began is not posted", async () => {
  const { ports, state } = fakePorts();
  seed(state, recipients("r1", "r2", "r3"));
  // Another worker won the race between the read and the conditional update.
  ports.beginSend = async (id: string) => {
    state.calls.push(`beginSend:${id}`);
    if (id === "r1") return false;
    if (state.status.get(id) !== "pending") return false;
    state.status.set(id, "sending");
    return true;
  };

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(state.sent, ["r2", "r3"]);
  assertEquals(state.posted.length, 2);
  assertEquals(outcome, {
    kind: "continue",
    progress: { sent: 2, failed: 0, skipped: 0, pending: 1 },
  });
});

Deno.test("stops at the deadline and continues", async () => {
  const { ports, state, clock } = fakePorts();
  seed(state, recipients("r1", "r2", "r3"));
  const originalPost = ports.postTemplate;
  ports.postTemplate = async (...args) => {
    const result = await originalPost(...args);
    clock.value = DEADLINE + 1;
    return result;
  };

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(outcome, {
    kind: "continue",
    progress: { sent: 1, failed: 0, skipped: 0, pending: 2 },
  });
  assertEquals(state.posted.length, 1);
});

Deno.test("a stale sending row is failed before any send", async () => {
  const { ports, state } = fakePorts();
  seed(state, recipients("r1"));

  await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  const stale = state.calls.indexOf("failStaleSends");
  const firstSend = state.calls.indexOf("beginSend:r1");
  assertEquals(stale >= 0 && stale < firstSend, true);
});

Deno.test("a Meta error marks the recipient failed with Meta's message", async () => {
  const { ports, state } = fakePorts({
    postTemplate: async () => ({ ok: false, data: { error: { message: "Template does not exist" } } }),
  });
  seed(state, recipients("r1"));

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(state.failed, [{ id: "r1", message: "Template does not exist" }]);
  assertEquals(outcome.kind, "done");
});

Deno.test("a write error after Meta accepted never marks the recipient failed", async () => {
  const { ports, state } = fakePorts({
    markRecipientSent: async () => {
      throw new Error("write failed");
    },
  });
  seed(state, recipients("r1", "r2"));

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(state.failed, []);
  assertEquals(state.calls.includes("markRecipientFailed:r1"), false);
  // The loop continued: the second recipient was still posted.
  assertEquals(state.calls.includes("beginSend:r2"), true);
  // The first recipient is still 'sending', so the chunk asks for another round.
  assertEquals(outcome.kind, "continue");
});

Deno.test("all sends failing finishes failed", async () => {
  const { ports, state } = fakePorts({
    postTemplate: async () => ({ ok: false, data: { error: { message: "nope" } } }),
  });
  seed(state, recipients("r1"));

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(outcome, {
    kind: "done",
    result: { sent: 0, failed: 1, skipped: 0, status: "failed" },
  });
});

Deno.test("missing credentials fail the job without retry", async () => {
  const { ports, state } = fakePorts({
    loadWhatsAppAccounts: async () => [{ access_token: null, platform_user_id: null, account_metadata: {} }],
  });
  seed(state, recipients("r1"));

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(outcome, { kind: "failed", error: "credentials_unavailable", retryable: false });
  assertEquals(state.posted.length, 0);
});

Deno.test("opt-out lookup failure fails retryably before any send", async () => {
  const { ports, state } = fakePorts({
    optedOutPhones: async () => {
      throw new Error("opt_out_lookup_failed");
    },
  });
  seed(state, recipients("r1"));

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(outcome, { kind: "failed", error: "opt_out_lookup_failed", retryable: true });
  assertEquals(state.posted.length, 0);
  assertEquals(state.logs.map((l) => l.reason), ["opt_out_lookup_failed"]);
});

Deno.test("opted-out recipients are skipped and logged, others sent", async () => {
  const { ports, state } = fakePorts({
    optedOutPhones: async () => new Set(["96550000001"]),
  });
  seed(state, recipients("r1", "r2"));

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(state.status.get("r1"), "skipped");
  assertEquals(state.sent, ["r2"]);
  assertEquals(state.logs.map((l) => l.reason), ["opted_out"]);
  assertEquals(outcome.kind, "done");
});

Deno.test("a broadcast no longer sending is done without sending", async () => {
  const { ports, state } = fakePorts({
    loadBroadcast: async () => ({
      id: "b1",
      user_id: USER,
      status: "completed",
      name: "Promo",
      template_name: "hello",
      template_components: null,
      sent_count: 3,
      failed_count: 0,
    }),
  });
  seed(state, recipients("r1"));

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(outcome, {
    kind: "done",
    result: { sent: 0, failed: 0, skipped: 0, status: "completed" },
  });
  assertEquals(state.posted.length, 0);
});

Deno.test("a missing broadcast is done without sending", async () => {
  const { ports, state } = fakePorts({ loadBroadcast: async () => null });
  seed(state, recipients("r1"));

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(outcome, {
    kind: "done",
    result: { sent: 0, failed: 0, skipped: 0, status: "missing" },
  });
  assertEquals(state.posted.length, 0);
});

Deno.test("a hung Meta call is aborted at the deadline and recorded outcome_unknown", async () => {
  const { ports, state, clock } = fakePorts(
    {
      postTemplate: async (_phoneNumberId, _accessToken, _body, signal) => {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return { ok: true, data: {} };
      },
    },
    {
      // The clock runs out while the request is in flight.
      onBeginSend: () => {
        clock.value = DEADLINE - 50;
      },
    },
  );
  seed(state, recipients("r1"));

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(state.failed, [{ id: "r1", message: "outcome_unknown" }]);
  assertEquals(state.sent, []);
  assertEquals(outcome, {
    kind: "done",
    result: { sent: 0, failed: 1, skipped: 0, status: "failed" },
  });
});

Deno.test("no recipient is begun inside the send reserve", async () => {
  const { ports, state } = fakePorts();
  seed(state, recipients("r1", "r2"));

  const outcome = await runBroadcastChunk(ports, {
    broadcastId: "b1", userId: USER,
    deadlineMs: NOW + BROADCAST_SEND_RESERVE_MS - 1,
  });

  assertEquals(state.calls.filter((c) => c.startsWith("beginSend:")), []);
  assertEquals(state.posted.length, 0);
  assertEquals(outcome, {
    kind: "continue",
    progress: { sent: 0, failed: 0, skipped: 0, pending: 2 },
  });
});

Deno.test("a transport outage stops after one unknown send and delays only untouched recipients", async () => {
  const { ports, state } = fakePorts();
  seed(state, recipients("r1", "r2", "r3"));
  ports.postTemplate = async () => { throw new Error("transport unavailable"); };

  const outcome = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });

  assertEquals(state.failed, [{ id: "r1", message: "outcome_unknown" }]);
  assertEquals(state.calls.filter((call) => call.startsWith("beginSend:")), ["beginSend:r1"]);
  assertEquals([...state.status], [["r1", "failed"], ["r2", "pending"], ["r3", "pending"]]);
  assertEquals(outcome, {
    kind: "continue", runAfterMs: 60_000,
    progress: { sent: 0, failed: 1, skipped: 0, pending: 2 },
  });

  // Once transport recovers, the next chunk sends only the untouched recipients.
  ports.postTemplate = async () => ({ ok: true, data: { messages: [{ id: "wamid" }] } });
  const recovered = await runBroadcastChunk(ports, { broadcastId: "b1", userId: USER, deadlineMs: DEADLINE });
  assertEquals(state.sent, ["r2", "r3"]);
  assertEquals(state.failed, [{ id: "r1", message: "outcome_unknown" }]);
  assertEquals(recovered.kind, "done");
});
