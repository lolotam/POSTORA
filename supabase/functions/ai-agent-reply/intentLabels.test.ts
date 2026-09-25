import { assertRejects, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { TriageAnswers } from "../_shared/agentTriage.ts";
import { applyIntentLabel, intentLabelFor, INTENT_LABELS, shouldLabel } from "./intentLabels.ts";

const answers = (intent: TriageAnswers["intent"]): TriageAnswers => ({
  needsKnowledge: null,
  smalltalk: null,
  handoff: null,
  connector: null,
  intent,
});

Deno.test("each intent keeps its exact label name and colour", () => {
  assertEquals(INTENT_LABELS.pricing, { name: "Pricing", color: "#3b82f6" });
  assertEquals(INTENT_LABELS.order_status, { name: "Order status", color: "#8b5cf6" });
  assertEquals(INTENT_LABELS.complaint, { name: "Complaint", color: "#ef4444" });
  assertEquals(INTENT_LABELS.lead, { name: "Lead", color: "#22c55e" });
  assertEquals(INTENT_LABELS.greeting, { name: "Greeting", color: "#94a3b8" });
});

Deno.test("a confident intent earns its label; everything else earns none", () => {
  assertEquals(intentLabelFor(answers({ choice: "pricing", confidence: 0.91 })), {
    name: "Pricing",
    color: "#3b82f6",
  });
  // Below the triage threshold the intent is a guess, not a signal.
  assertEquals(intentLabelFor(answers({ choice: "pricing", confidence: 0.5 })), null);
  // "other" is deliberately never labelled.
  assertEquals(intentLabelFor(answers({ choice: "other", confidence: 0.99 })), null);
  assertEquals(intentLabelFor(null), null);
  assertEquals(intentLabelFor(answers(null)), null);
});

Deno.test("labels apply only on WhatsApp, live runs, fresh deliveries", () => {
  assertEquals(shouldLabel({ platform: "whatsapp", dryRun: false, freshDelivery: true }), true);
  assertEquals(shouldLabel({ platform: "instagram", dryRun: false, freshDelivery: true }), false);
  assertEquals(shouldLabel({ platform: "whatsapp", dryRun: true, freshDelivery: true }), false);
  // Redelivered replies are not labelled: the intent belonged to the lost invocation.
  assertEquals(shouldLabel({ platform: "whatsapp", dryRun: false, freshDelivery: false }), false);
});

type LabelRow = { id: string; user_id: string; name: string; color: string; created_at: string };

interface RecordedCall {
  table: string;
  op: "select" | "insert" | "upsert";
  order: string[];
  filters: Array<[string, unknown]>;
  payload?: Record<string, unknown>;
}

/**
 * Records every chain the writer builds, and answers the labels select by
 * filtering on the recorded eq()s and sorting by created_at then id — the same
 * convergence rule the real query encodes.
 */
function labelDatabase(labels: LabelRow[] = []) {
  const calls: RecordedCall[] = [];
  let nextId = 1;
  const resolve = (record: RecordedCall): { data: unknown; error: null } => {
    if (record.op === "insert") {
      const row: LabelRow = {
        id: `inserted-${nextId++}`,
        user_id: String(record.payload!.user_id),
        name: String(record.payload!.name),
        color: String(record.payload!.color),
        created_at: "2026-09-25T00:00:00Z",
      };
      labels.push(row);
      return { data: { id: row.id }, error: null };
    }
    const matched = labels.filter((row) =>
      record.filters.every(([key, value]) => row[key as keyof LabelRow] === value)
    );
    matched.sort((a, b) =>
      a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at)
    );
    return { data: matched[0] ?? null, error: null };
  };
  const db = {
    from(table: string) {
      const record: RecordedCall = { table, op: "select", order: [], filters: [] };
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = (key: string, value: unknown) => { record.filters.push([key, value]); return query; };
      query.order = (column: string, options: { ascending: boolean }) => {
        record.order.push(`${column}:${options.ascending ? "asc" : "desc"}`);
        return query;
      };
      query.limit = (_count: number) => query;
      query.maybeSingle = () => { calls.push(record); return Promise.resolve(resolve(record)); };
      query.single = () => { calls.push(record); return Promise.resolve(resolve(record)); };
      query.insert = (payload: Record<string, unknown>) => { record.op = "insert"; record.payload = payload; return query; };
      query.upsert = (payload: Record<string, unknown>) => {
        record.op = "upsert";
        record.payload = payload;
        calls.push(record);
        return Promise.resolve({ error: null });
      };
      return query;
    },
  };
  return { db, calls, labels };
}

const PRICING = { name: "Pricing", color: "#3b82f6" };

Deno.test("applyIntentLabel creates the label on first use and assigns it", async () => {
  const { db, calls, labels } = labelDatabase();
  await applyIntentLabel(db, "user-1", "wa_1_customer", PRICING);
  assertEquals(labels.map((label) => label.name), ["Pricing"]);
  assertEquals(labels[0].color, "#3b82f6");
  const assignment = calls.find((call) => call.op === "upsert")!;
  assertEquals(assignment.table, "whatsapp_conversation_label_assignments");
  assertEquals(assignment.payload, {
    user_id: "user-1",
    conversation_id: "wa_1_customer",
    label_id: labels[0].id,
  });
});

Deno.test("a label already owned by the user is reused, not recreated", async () => {
  const { db, calls, labels } = labelDatabase([{
    id: "existing-1", user_id: "user-1", name: "Pricing", color: "#3b82f6", created_at: "2026-01-01T00:00:00Z",
  }]);
  await applyIntentLabel(db, "user-1", "wa_2_customer", PRICING);
  assertEquals(labels.length, 1);
  assertEquals(calls.find((call) => call.op === "upsert")!.payload!.label_id, "existing-1");
});

Deno.test("two same-name labels converge on the oldest, and the lookup is ordered to say so", async () => {
  const { db, calls } = labelDatabase([
    { id: "b-newer", user_id: "user-1", name: "Pricing", color: "#3b82f6", created_at: "2026-02-01T00:00:00Z" },
    { id: "a-older", user_id: "user-1", name: "Pricing", color: "#999999", created_at: "2026-01-01T00:00:00Z" },
  ]);
  await applyIntentLabel(db, "user-1", "wa_3_customer", PRICING);
  const lookup = calls.find((call) => call.table === "whatsapp_conversation_labels" && call.op === "select")!;
  assertEquals(lookup.order, ["created_at:asc", "id:asc"]);
  assertEquals(calls.find((call) => call.op === "upsert")!.payload!.label_id, "a-older");
});

Deno.test("another user's label is never reused", async () => {
  const { db, calls, labels } = labelDatabase([{
    id: "theirs", user_id: "user-2", name: "Pricing", color: "#3b82f6", created_at: "2026-01-01T00:00:00Z",
  }]);
  await applyIntentLabel(db, "user-1", "wa_4_customer", PRICING);
  assertEquals(labels.some((label) => label.user_id === "user-1"), true);
  assertEquals(calls.find((call) => call.op === "upsert")!.payload!.label_id !== "theirs", true);
});

Deno.test("a database failure rejects with no row data in the message", async () => {
  const db = {
    from() {
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = () => query;
      query.order = () => query;
      query.limit = () => query;
      query.maybeSingle = () => Promise.resolve({ data: null, error: { message: "db down" } });
      return query;
    },
  };
  const error = await assertRejects(
    () => applyIntentLabel(db, "user-1", "wa_5_customer", PRICING),
  );
  assertEquals(error.message.includes("wa_5_customer"), false);
  assertEquals(error.message.includes("Pricing"), false);
});
