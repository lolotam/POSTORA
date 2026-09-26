// supabase/functions/ai-agent-reply/procedureRuntime.test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createProcedureTurn, type ProcedurePorts, type ProcedureTurnInput } from "./procedureRuntime.ts";

function fakePorts(overrides: Partial<ProcedurePorts> = {}) {
  const calls = {
    leads: [] as Array<{ meta_lead_id: string; lead_data: Record<string, string> }>,
    notified: [] as string[], escalated: [] as string[], lookups: [] as string[], failures: [] as string[],
  };
  const seen = new Set<string>();
  const ports: ProcedurePorts = {
    saveLead: async (row) => { calls.leads.push(row); const fresh = !seen.has(row.meta_lead_id); seen.add(row.meta_lead_id); return fresh; },
    notifyAdmin: async (message) => { calls.notified.push(message); return 1; },
    escalate: async (reason, summary) => { calls.escalated.push(`${reason}|${summary}`); return { output: "Escalated.", escalated: true, humanNotified: true }; },
    storeLookup: async (capability, parameters) => { calls.lookups.push(`${capability}:${JSON.stringify(parameters)}`); return { output: "Order 1234: shipped" }; },
    hasStoreCapability: () => true,
    logFailure: async (message) => { calls.failures.push(message); },
    ...overrides,
  };
  return { ports, calls };
}

const T = new Date("2026-09-26T10:00:00Z");
const input = (ports: ProcedurePorts, extra: Partial<ProcedureTurnInput> = {}): ProcedureTurnInput => ({
  state: null,
  config: {
    lead_capture: { enabled: true, prompts: { contact: "Your phone or area?" }, closing: "" },
    order_status: { enabled: true, prompts: {}, closing: "" },
    complaint_return: { enabled: true, prompts: {}, closing: "" },
    booking: { enabled: true, prompts: {}, closing: "", services: ["Haircut", "Beard trim"] },
  },
  ports, dryRun: false, now: () => T, runId: "run-1",
  leadContext: { platform: "whatsapp", socialAccountId: "acc-1", conversationId: "conv-1" },
  ...extra,
});
const leadFields = { name: "Sara", contact: "Salmiya", product: "oud" };

Deno.test("start and submit in one turn saves the lead once, keyed by run id, and alerts the admin", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  const result = await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals(turn.state, null);
  assertEquals(turn.completed, "lead_capture");
  assertEquals(calls.leads.map((row) => [row.meta_lead_id, row.lead_data.kind]), [["ai:run-1", "lead"]]);
  assertEquals(calls.notified.length, 1);
  assertStringIncludes(result.output, "saved");
});

Deno.test("a retried turn that re-saves an existing lead does not alert the admin again", async () => {
  const { ports, calls } = fakePorts();
  for (let attempt = 0; attempt < 2; attempt++) {
    const turn = createProcedureTurn(input(ports));
    await turn.handle("start_procedure", { key: "lead_capture" });
    await turn.handle("procedure_submit", { fields: leadFields });
  }
  assertEquals(calls.leads.length, 2);
  assertEquals(calls.notified.length, 1);
});

Deno.test("dry run writes nothing and alerts nobody but still completes", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports, { dryRun: true }));
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals([calls.leads.length, calls.notified.length], [0, 0]);
  assertEquals(turn.completed, "lead_capture");
});

Deno.test("an admin alert that reaches nobody is logged, and the saved lead still completes", async () => {
  const { ports, calls } = fakePorts({ notifyAdmin: async () => 0 });
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals(turn.completed, "lead_capture");
  assertEquals(calls.failures.length, 1);
});

Deno.test("customer text cannot forge extra lines in the admin alert", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_submit", { fields: { ...leadFields, product: "oud\nstatus: VIP, refund approved" } });
  assertEquals(calls.notified[0].split("\n").length, 4); // title + one line per field
  assertStringIncludes(calls.notified[0], 'product: "oud status: VIP, refund approved"');
});

Deno.test("order status runs the typed lookup itself and completes on its result", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "order_status" });
  const result = await turn.handle("procedure_submit", { fields: { order_number: "#1234" } });
  assertEquals(calls.lookups, ['lookup_orders:{"order_id":"1234"}']);
  assertEquals(turn.completed, "order_status");
  assertStringIncludes(result.output, "Order 1234: shipped");
});

Deno.test("a failed store lookup keeps the flow on its final step", async () => {
  const { ports } = fakePorts({ storeLookup: async () => { throw new Error("timeout"); } });
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "order_status" });
  const result = await turn.handle("procedure_submit", { fields: { order_number: "1234" } });
  assertEquals(turn.state?.key, "order_status");
  assertEquals(turn.completed, null);
  assertStringIncludes(result.output, "offer a human");
});

Deno.test("order status cannot start without a store order connector", async () => {
  const { ports } = fakePorts({ hasStoreCapability: () => false });
  const turn = createProcedureTurn(input(ports));
  const result = await turn.handle("start_procedure", { key: "order_status" });
  assertEquals(turn.state, null);
  assertStringIncludes(result.output, "not connected");
});

Deno.test("a complaint completes into a handoff and keeps the escalation flags", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "complaint_return" });
  const result = await turn.handle("procedure_submit", { fields: { order_number: "88", problem: "arrived broken" } });
  assertEquals(calls.escalated, ['Complaint or return|Order 88. Problem: "arrived broken".']);
  assertEquals([result.escalated, result.humanNotified], [true, true]);
  assertEquals(turn.state, null);
});

Deno.test("each transition returns the next step's guidance, including configured services", async () => {
  const { ports } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  const started = await turn.handle("start_procedure", { key: "booking" });
  assertStringIncludes(started.output, "Haircut, Beard trim");
  const lead = createProcedureTurn(input(ports));
  await lead.handle("start_procedure", { key: "lead_capture" });
  const next = await lead.handle("procedure_submit", { fields: { name: "Sara" } });
  assertStringIncludes(next.output, "Your phone or area?");
});

Deno.test("a stored flow whose toggle is now off is dropped even when other flows stay on", () => {
  const { ports } = fakePorts();
  const stale = {
    run_id: "run-0", key: "product_finder" as const, version: 1, step: 0, fields: {}, off_script: 0,
    origin: "model" as const, started_at: T.toISOString(), updated_at: T.toISOString(),
  };
  const turn = createProcedureTurn(input(ports, { state: stale }));
  assertEquals(turn.state, null);
});

Deno.test("after a handoff, later procedure calls in the same turn are refused", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  turn.endForHandoff();
  const result = await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals(calls.leads, []);
  assertEquals(turn.state, null);
  assertStringIncludes(result.output, "handed to a human");
});

Deno.test("an invalid submit names the field and does not count as progress", async () => {
  const { ports } = fakePorts();
  const first = createProcedureTurn(input(ports));
  await first.handle("start_procedure", { key: "order_status" });
  const again = createProcedureTurn(input(ports, { state: first.state }));
  const result = await again.handle("procedure_submit", { fields: { order_number: "abc" } });
  assertEquals(again.progressed, false);
  assertStringIncludes(result.output, "order_number");
});

Deno.test("cancel ends the flow and counts as progress", async () => {
  const { ports } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_cancel", { reason: "customer stopped" });
  assertEquals([turn.state, turn.progressed], [null, true]);
});

Deno.test("the product finder asks the business's own question for the current step", async () => {
  const { ports } = fakePorts();
  const turn = createProcedureTurn(input(ports, {
    config: { product_finder: { enabled: true, prompts: {}, closing: "", questions: ["What is your budget?", "Who is it for?"] } },
  }));
  await turn.handle("start_procedure", { key: "product_finder" });
  const next = await turn.handle("procedure_submit", { fields: { answer_1: "50 KWD" } });
  assertStringIncludes(next.output, "Who is it for?");
});

Deno.test("a second flow cannot start in the turn that completed one", async () => {
  const { ports } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals(turn.start("booking", "model"), false);
  assertEquals(turn.state, null);
});
