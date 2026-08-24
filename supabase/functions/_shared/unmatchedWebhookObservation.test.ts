import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildObservation, flushObservations, type UnmatchedObservation } from "./unmatchedWebhookObservation.ts";

const INSTAGRAM_ENTRY = {
  id: "17841401514313845",
  time: 1756060069,
  messaging: [
    {
      sender: { id: "1387955722662249", name: "Some Person" },
      recipient: { id: "17841401514313845" },
      timestamp: 1756060069,
      message: { mid: "aWdfZAG1", text: "my phone number is 555-0100" },
    },
  ],
};

Deno.test("buildObservation stores envelope shape, never content or sender ids", () => {
  const observation = buildObservation({
    recipientId: "17841401514313845",
    eventKind: "message",
    entry: INSTAGRAM_ENTRY,
  });

  const serialized = JSON.stringify(observation);
  // The message text and the sender's id are both present in the source entry. Neither
  // may survive into a row that the owning user of an inactive account can read.
  assertEquals(serialized.includes("555-0100"), false);
  assertEquals(serialized.includes("1387955722662249"), false);
  assertEquals(serialized.includes("Some Person"), false);
  assertEquals(serialized.includes("aWdfZAG1"), false);

  // What it does keep: enough shape to tell a delivered-but-undeliverable event apart
  // from one that never arrived.
  assertEquals(observation.summary.entry_keys, ["id", "time", "messaging"]);
  assertEquals(observation.summary.messaging_kinds, [["message"]]);
  assertEquals(observation.summary.entry_time, 1756060069);
});

Deno.test("buildObservation reports unknown_recipient when no account exists at all", () => {
  const observation = buildObservation({
    recipientId: "17841401514313845",
    eventKind: "message",
    inactiveAccount: null,
    entry: INSTAGRAM_ENTRY,
  });

  assertEquals(observation.reason, "unknown_recipient");
  assertEquals(observation.social_account_id, undefined);
  assertEquals(observation.user_id, undefined);
});

Deno.test("buildObservation reports account_inactive and its owner when a disconnected row exists", () => {
  const observation = buildObservation({
    recipientId: "17841401514313845",
    eventKind: "message",
    inactiveAccount: { id: "acc-1", user_id: "user-1" },
    entry: INSTAGRAM_ENTRY,
  });

  // This is the distinction the handlers cannot draw on their own: both account
  // resolvers filter is_active = true, so a disconnected account and a stranger look
  // identical to them, while the remedies differ completely.
  assertEquals(observation.reason, "account_inactive");
  assertEquals(observation.social_account_id, "acc-1");
  assertEquals(observation.user_id, "user-1");
});

Deno.test("buildObservation records which field was dropped for non-message events", () => {
  const observation = buildObservation({
    recipientId: "201285060308",
    eventKind: "unknown",
    entry: { id: "wa-entry", changes: [{ field: "history" }] },
    change: { field: "history" },
  });

  assertEquals(observation.event_kind, "unknown");
  assertEquals(observation.summary.change_field, "history");
  assertEquals(observation.summary.change_fields, ["history"]);
});

Deno.test("flushObservations sends one RPC call for a whole batch", async () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ error: null });
    },
  };
  const observations: UnmatchedObservation[] = [
    { recipient_id: "a", event_kind: "message", reason: "unknown_recipient", summary: {} },
    { recipient_id: "b", event_kind: "comment", reason: "unknown_recipient", summary: {} },
    { recipient_id: "c", event_kind: "unknown", reason: "unknown_recipient", summary: {} },
  ];

  await flushObservations(client, "instagram", observations);

  // One call, not three: the caller runs this inside runInBackground, whose degraded
  // path awaits up to 2s per invocation.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].fn, "record_unmatched_webhook_observations");
  assertEquals(calls[0].args.p_platform, "instagram");
  assertEquals((calls[0].args.p_observations as unknown[]).length, 3);
});

Deno.test("flushObservations does nothing when there is nothing to record", async () => {
  let called = false;
  const client = {
    rpc() {
      called = true;
      return Promise.resolve({ error: null });
    },
  };

  await flushObservations(client, "facebook", []);

  assertEquals(called, false);
});

Deno.test("flushObservations swallows a thrown client error", async () => {
  const client = {
    rpc(): Promise<{ error?: unknown }> {
      throw new Error("connection refused");
    },
  };

  // No assertion needed beyond "this returns": the handlers calling it return 500 from
  // their outer catch, and a 500 makes Meta redeliver. A diagnostic write must never be
  // able to turn into a delivery bug.
  await flushObservations(client, "instagram", [
    { recipient_id: "a", event_kind: "message", reason: "unknown_recipient", summary: {} },
  ]);
});

Deno.test("flushObservations swallows a returned error without throwing", async () => {
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    const client = {
      rpc() {
        return Promise.resolve({ error: { message: "permission denied for function" } });
      },
    };
    await flushObservations(client, "whatsapp", [
      { recipient_id: "a", event_kind: "message", reason: "unknown_recipient", summary: {} },
    ]);
  } finally {
    console.error = originalError;
  }

  // A silently swallowed failure is what this whole feature exists to prevent, so the
  // swallow has to at least be loud in the logs.
  assertEquals(errors.length, 1);
  assertStringIncludes(String(errors[0]), "[unmatched-observation] write failed");
});
