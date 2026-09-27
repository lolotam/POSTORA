// supabase/functions/ai-agent-reply/procedureRuntime.test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createProcedureTurn, planWaitlistJoin, type ProcedurePorts, type ProcedureTurnInput, type StockSighting, type StoreEventRow,
} from "./procedureRuntime.ts";

function fakePorts(overrides: Partial<ProcedurePorts> = {}) {
  const calls = {
    leads: [] as Array<{ meta_lead_id: string; lead_data: Record<string, string> }>,
    notified: [] as string[], escalated: [] as string[], lookups: [] as string[], failures: [] as string[],
    claims: [] as Array<{ claimed_by?: string; run_id: string }>,
    order: [] as string[],
  };
  const seen = new Set<string>();
  const ports: ProcedurePorts = {
    claim: async (claimed) => { calls.order.push("claim"); calls.claims.push(claimed); return true; },
    saveLead: async (row) => { calls.order.push("saveLead"); calls.leads.push(row); const fresh = !seen.has(row.meta_lead_id); seen.add(row.meta_lead_id); return fresh; },
    notifyAdmin: async (message) => { calls.order.push("notify"); calls.notified.push(message); return 1; },
    escalate: async (reason, summary) => { calls.order.push("escalate"); calls.escalated.push(`${reason}|${summary}`); return { output: "Escalated.", escalated: true, humanNotified: true }; },
    storeLookup: async (capability, parameters) => { calls.order.push("lookup"); calls.lookups.push(`${capability}:${JSON.stringify(parameters)}`); return { output: "Order 1234: shipped" }; },
    hasStoreCapability: () => true,
    logFailure: async (message) => { calls.failures.push(message); },
    eventFor: async () => null,
    updateOrder: async () => { throw new Error("updateOrder was not expected"); },
    getProduct: async () => { throw new Error("getProduct was not expected"); },
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
  ports, dryRun: false, now: () => T, runId: "run-1", userId: "user-1",
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
  assertStringIncludes(result.output, "the team will contact them soon");
  assertStringIncludes(result.output, "Do not say an order was placed");
  assertEquals(calls.claims.map((claimed) => claimed.claimed_by), ["run-1"]);
  assertEquals(calls.order.slice(0, 2), ["claim", "saveLead"]);
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
  const result = await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals([calls.leads.length, calls.notified.length, calls.claims.length], [0, 0, 0]);
  assertEquals(turn.completed, "lead_capture");
  assertStringIncludes(result.output, "(test mode, nothing written)");
  assertStringIncludes(result.output, "Do not say an order was placed");
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
  assertStringIncludes(next.output, "Needed now: contact (accept: a phone number or an area/city (for example Salmiya); accept either, do not insist on a phone number).");
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
  assertEquals(next.output.includes("(accept:"), false);
});

Deno.test("a second flow cannot start in the turn that completed one", async () => {
  const { ports } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals(turn.start("booking", "model"), false);
  assertEquals(turn.state, null);
});

Deno.test("a failed end action retries on the next submit without asking for fields again", async () => {
  let failing = true;
  const { ports, calls } = fakePorts({
    saveLead: async (row) => {
      if (failing) throw new Error("db down");
      calls.leads.push(row);
      return true;
    },
  });
  const first = createProcedureTurn(input(ports));
  await first.handle("start_procedure", { key: "lead_capture" });
  await first.handle("procedure_submit", { fields: leadFields });
  failing = false;
  const retry = createProcedureTurn(input(ports, { state: first.state, runId: "run-2" }));
  await retry.handle("procedure_submit", { fields: {} });
  assertEquals(retry.completed, "lead_capture");
  assertEquals(calls.leads.map((row) => row.meta_lead_id), ["ai:run-1"]);
});

// Two concurrent turns finishing one stored flow share its run id, so the lead is saved
// once and the admin is alerted once, whichever turn wins (PR #209 review, P1).
Deno.test("two turns finishing the same stored flow save one lead and send one alert", async () => {
  const { ports, calls } = fakePorts();
  const opener = createProcedureTurn(input(ports));
  await opener.handle("start_procedure", { key: "lead_capture" });
  await opener.handle("procedure_submit", { fields: { name: "Sara", contact: "Salmiya" } });
  for (const runId of ["outbox-a", "outbox-b"]) {
    const turn = createProcedureTurn(input(ports, { state: opener.state, runId }));
    await turn.handle("procedure_submit", { fields: { product: "oud" } });
  }
  assertEquals(new Set(calls.leads.map((row) => row.meta_lead_id)), new Set(["ai:run-1"]));
  assertEquals(calls.notified.length, 1);
});

Deno.test("a lost claim saves nothing, alerts nobody, and keeps the finished flow", async () => {
  const { ports, calls } = fakePorts({ claim: async () => false });
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  const result = await turn.handle("procedure_submit", { fields: leadFields });
  const order = createProcedureTurn(input(ports));
  await order.handle("start_procedure", { key: "order_status" });
  await order.handle("procedure_submit", { fields: { order_number: "1234" } });
  const complaint = createProcedureTurn(input(ports));
  await complaint.handle("start_procedure", { key: "complaint_return" });
  await complaint.handle("procedure_submit", { fields: { order_number: "88", problem: "arrived broken" } });
  assertEquals([calls.leads.length, calls.notified.length, calls.escalated.length, calls.lookups.length], [0, 0, 0, 0]);
  assertEquals(calls.failures, ["Procedure claim lost", "Procedure claim lost", "Procedure claim lost"]);
  assertEquals(turn.completed, null);
  assertEquals(turn.claimConflict, true);
  assertEquals(turn.state?.fields, leadFields);
  assertEquals(order.state?.key, "order_status");
  assertEquals(complaint.state?.key, "complaint_return");
  assertStringIncludes(result.output, "offer a human");
});

Deno.test("two turns built from the same empty state save one lead when claim is a compare-and-set", async () => {
  let stored: unknown = null;
  const leads: string[] = [];
  const seen = new Set<string>();
  const portsFor = (expected: unknown) => fakePorts({
    claim: async (claimed) => {
      if (stored !== expected) return false;
      stored = claimed;
      return true;
    },
    saveLead: async (row) => {
      leads.push(row.meta_lead_id);
      const fresh = !seen.has(row.meta_lead_id);
      seen.add(row.meta_lead_id);
      return fresh;
    },
  }).ports;
  const run = async (runId: string) => {
    const turn = createProcedureTurn(input(portsFor(null), { runId }));
    await turn.handle("start_procedure", { key: "lead_capture" });
    await turn.handle("procedure_submit", { fields: leadFields });
    return turn;
  };
  const [first, second] = await Promise.all([run("run-a"), run("run-b")]);
  assertEquals(leads.length, 1);
  assertEquals([first, second].filter((turn) => turn.completed === "lead_capture").length, 1);
  assertEquals([first, second].filter((turn) => turn.state?.fields.product === "oud").length, 1);
});

Deno.test("a retry of an already complete flow claims before saving", async () => {
  let failing = true;
  const { ports, calls } = fakePorts({
    saveLead: async (row) => {
      calls.order.push("saveLead");
      if (failing) throw new Error("db down");
      calls.leads.push(row);
      return true;
    },
  });
  const first = createProcedureTurn(input(ports));
  await first.handle("start_procedure", { key: "lead_capture" });
  await first.handle("procedure_submit", { fields: leadFields });
  assertEquals(calls.claims.map((claimed) => claimed.claimed_by), ["run-1"]);
  failing = false;
  const retry = createProcedureTurn(input(ports, { state: first.state, runId: "run-2" }));
  await retry.handle("procedure_submit", { fields: {} });
  assertEquals(calls.claims.map((claimed) => claimed.claimed_by), ["run-1", "run-2"]);
  assertEquals(retry.completed, "lead_capture");
  assertEquals(calls.order.filter((step) => step === "claim" || step === "saveLead"), ["claim", "saveLead", "claim", "saveLead"]);
});

// PR #211 Codex P1: the second turn loaded the state after the first turn's claim landed.
Deno.test("a flow freshly claimed by another run is not taken over, and the turn is marked conflicted", async () => {
  const { ports, calls } = fakePorts();
  const claimedElsewhere = {
    run_id: "run-1", key: "lead_capture" as const, version: 1, step: 3, fields: leadFields, off_script: 0,
    origin: "jev" as const, started_at: T.toISOString(), updated_at: T.toISOString(),
    claimed_by: "run-other", claimed_at: T.toISOString(),
  };
  const turn = createProcedureTurn(input(ports, { state: claimedElsewhere, runId: "run-2" }));
  await turn.handle("procedure_submit", { fields: {} });
  assertEquals([calls.claims.length, calls.leads.length, calls.notified.length], [0, 0, 0]);
  assertEquals(turn.claimConflict, true);
  assertEquals(turn.completed, null);
});

Deno.test("a flow whose claim outlived the lease is reclaimed and finished", async () => {
  const { ports, calls } = fakePorts();
  const abandoned = {
    run_id: "run-1", key: "lead_capture" as const, version: 1, step: 3, fields: leadFields, off_script: 0,
    origin: "jev" as const, started_at: T.toISOString(), updated_at: T.toISOString(),
    claimed_by: "run-crashed", claimed_at: new Date(T.getTime() - 3 * 60 * 1000).toISOString(),
  };
  const turn = createProcedureTurn(input(ports, { state: abandoned, runId: "run-2" }));
  await turn.handle("procedure_submit", { fields: {} });
  assertEquals(calls.claims.map((claimed) => claimed.claimed_by), ["run-2"]);
  assertEquals(calls.leads.length, 1);
  assertEquals([turn.completed, turn.claimConflict], ["lead_capture", false]);
});

Deno.test("start_procedure never starts a store-event flow", async () => {
  const { ports } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  const result = await turn.handle("start_procedure", { key: "cod_confirm" });
  assertStringIncludes(result.output, "not enabled");
  assertEquals(turn.start("cod_confirm", "jev"), false);
  assertEquals(turn.state, null);
});

Deno.test("a pending_opener state is inert: no start, no submit, nothing progressed", async () => {
  const { ports, calls } = fakePorts();
  const pending = {
    run_id: "evt-1", key: "cod_confirm" as const, version: 1, step: 0, fields: {}, off_script: 0,
    origin: "event" as const, started_at: T.toISOString(), updated_at: T.toISOString(), phase: "pending_opener" as const,
  };
  const base = input(ports);
  const turn = createProcedureTurn({
    ...base,
    state: pending,
    config: { ...base.config, cod_confirm: { enabled: true, prompts: {}, closing: "" } },
  });
  assertEquals(turn.inert, true);
  assertEquals(turn.state, null);
  assertEquals(turn.start("lead_capture", "jev"), false);
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_submit", { fields: { decision: "confirm" } });
  assertEquals(turn.state, null);
  assertEquals(turn.progressed, false);
  assertEquals(calls.order, []);
});

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const eventRow = (flow: StoreEventRow["flow"]): StoreEventRow => ({
  id: EVENT_ID, user_id: "user-1", social_account_id: "acc-1", connector_id: "conn-1", flow,
  payload: { order_id: "10432", product_id: "55", parent_id: "10", product_name: "Blue hat" },
});

function eventPorts(flow: StoreEventRow["flow"]) {
  const updates: Array<Record<string, unknown>> = [];
  const products: Array<Record<string, unknown>> = [];
  const { ports, calls } = fakePorts({
    eventFor: async (runId) => (runId === EVENT_ID ? eventRow(flow) : null),
    updateOrder: async (order) => { calls.order.push("update"); updates.push(order); return { changed: true, status: order.status ?? "processing" }; },
    getProduct: async (product) => {
      calls.order.push("product");
      products.push(product);
      return { ok: true, name: "Blue hat", price: "3.500", permalink: "https://store.example/hat" };
    },
  });
  return { ports, calls, updates, products };
}

function eventTurn(flow: "cod_confirm" | "review_request" | "back_in_stock", ports: ProcedurePorts, extra: Partial<ProcedureTurnInput> = {}) {
  const base = input(ports);
  return createProcedureTurn(input(ports, {
    state: {
      run_id: EVENT_ID, key: flow, version: 1, step: 0, fields: {}, off_script: 0,
      origin: "event", started_at: T.toISOString(), updated_at: T.toISOString(),
    },
    config: {
      ...base.config,
      cod_confirm: { enabled: true, prompts: {}, closing: "", consent_attested_at: "2026-09-01T00:00:00Z" },
      review_request: {
        enabled: true, prompts: {}, closing: "", consent_attested_at: "2026-09-01T00:00:00Z",
        delay_days: 3, review_url: "https://shop.example/reviews",
      },
      back_in_stock: { enabled: true, prompts: {}, closing: "" },
    },
    ...extra,
  }));
}

Deno.test("cod confirm notes the order from the event and does not change its status", async () => {
  const { ports, calls, updates } = eventPorts("cod_confirm");
  const turn = eventTurn("cod_confirm", ports);
  const result = await turn.handle("procedure_submit", { fields: { decision: "confirm", order_id: "99999" } });
  assertEquals(turn.completed, "cod_confirm");
  assertEquals(calls.order[0], "claim");
  assertEquals(updates[0], {
    connectorId: "conn-1", orderId: "10432",
    note: "Confirmed by the customer on WhatsApp (Postora)",
    expectedStatuses: ["pending", "on-hold", "processing"],
  });
  assertEquals(calls.notified.length, 0);
  assertStringIncludes(result.output, "confirmed");
});

Deno.test("cod cancel sets status cancelled and alerts the admin", async () => {
  const { ports, calls, updates } = eventPorts("cod_confirm");
  const turn = eventTurn("cod_confirm", ports);
  const result = await turn.handle("procedure_submit", { fields: { decision: "cancel" } });
  assertEquals(updates[0].status, "cancelled");
  assertEquals(updates[0].note, "Customer asked to cancel on WhatsApp (Postora)");
  assertEquals(calls.notified.length, 1);
  assertStringIncludes(result.output, "cancelled");
});

Deno.test("a store write that changes nothing alerts and tells the customer the team will follow up", async () => {
  const { ports, calls } = eventPorts("cod_confirm");
  ports.updateOrder = async () => { calls.order.push("update"); return { changed: false, status: "completed" }; };
  const result = await eventTurn("cod_confirm", ports).handle("procedure_submit", { fields: { decision: "confirm" } });
  assertStringIncludes(result.output, "team will follow up");
  assertEquals(calls.notified.length, 1);
  assertEquals(calls.failures.length, 1);
});

Deno.test("store_write_denied alerts and does not claim the order changed", async () => {
  const { ports, calls } = eventPorts("cod_confirm");
  ports.updateOrder = async () => { calls.order.push("update"); return { error: "store_write_denied" }; };
  const result = await eventTurn("cod_confirm", ports).handle("procedure_submit", { fields: { decision: "cancel" } });
  assertStringIncludes(result.output, "team will follow up");
  assertStringIncludes(calls.notified[0], "refused");
  assertEquals(result.output.includes("cancelled"), false);
});

Deno.test("an event for another account is refused before any store write", async () => {
  const { ports, calls, updates } = eventPorts("cod_confirm");
  ports.eventFor = async () => ({ ...eventRow("cod_confirm"), user_id: "someone-else" });
  const result = await eventTurn("cod_confirm", ports).handle("procedure_submit", { fields: { decision: "confirm" } });
  assertEquals(updates.length, 0);
  assertEquals(calls.notified.length, 1);
  assertStringIncludes(result.output, "team will follow up");
});

Deno.test("a cod end action in dry run writes nothing and alerts nobody", async () => {
  const { ports, calls, updates } = eventPorts("cod_confirm");
  const result = await eventTurn("cod_confirm", ports, { dryRun: true }).handle("procedure_submit", { fields: { decision: "cancel" } });
  assertEquals(updates.length, 0);
  assertEquals(calls.notified.length, 0);
  assertEquals(calls.claims.length, 0);
  assertStringIncludes(result.output, "nothing written");
});

Deno.test("a high rating tells the model to send the configured review link", async () => {
  const { ports, calls } = eventPorts("review_request");
  const result = await eventTurn("review_request", ports).handle("procedure_submit", { fields: { rating: "5" } });
  assertStringIncludes(result.output, "https://shop.example/reviews");
  assertEquals(calls.escalated.length, 0);
});

Deno.test("a low rating escalates with the rating and a sanitized problem", async () => {
  const { ports, calls } = eventPorts("review_request");
  await eventTurn("review_request", ports).handle("procedure_submit", { fields: { rating: "2", problem: "Torn\nbox" } });
  assertEquals(calls.escalated.length, 1);
  assertStringIncludes(calls.escalated[0], "2");
  assertStringIncludes(calls.escalated[0], "Torn box");
  assertEquals(calls.escalated[0].includes("\n"), false);
});

Deno.test("stock interest yes reads the event product and returns its link and price", async () => {
  const { ports, products } = eventPorts("back_in_stock");
  const result = await eventTurn("back_in_stock", ports).handle("procedure_submit", { fields: { interest: "yes", product_id: "1" } });
  assertEquals(products[0], { connectorId: "conn-1", productId: "55", parentId: "10" });
  assertStringIncludes(result.output, "https://store.example/hat");
  assertStringIncludes(result.output, "3.500");
});

Deno.test("stock interest no ends without reading the product", async () => {
  const { ports, products } = eventPorts("back_in_stock");
  const result = await eventTurn("back_in_stock", ports).handle("procedure_submit", { fields: { interest: "no" } });
  assertEquals(products.length, 0);
  assertStringIncludes(result.output, "does not want");
});

const sighting = (stockStatus: string, name = "Blue hat"): StockSighting => ({
  connectorId: "conn-9", productId: "55", parentId: "10", name, stockStatus,
});
const joinInput = (sightings: StockSighting[], extra: Partial<Parameters<typeof planWaitlistJoin>[0]> = {}) => planWaitlistJoin({
  productId: "55", sightings, platform: "whatsapp", phone: "+965 5551 2345", dryRun: false,
  userId: "user-1", socialAccountId: "acc-1", conversationId: "conv-1", now: T.toISOString(),
  ...extra,
});

Deno.test("waitlist join is refused without a stock result", () => {
  const plan = joinInput([]);
  assertEquals(plan.action, "refuse");
});

Deno.test("waitlist join is refused for an in-stock product", () => {
  const plan = joinInput([sighting("instock")]);
  assertEquals(plan.action, "refuse");
  if (plan.action === "refuse") assertStringIncludes(plan.output, "in stock");
});

Deno.test("waitlist join copies id, parent and name from the stock result", () => {
  const plan = joinInput([sighting("outofstock", "Real Hat")]);
  assertEquals(plan.action, "upsert");
  if (plan.action !== "upsert") return;
  assertEquals(plan.row.product_id, 55);
  assertEquals(plan.row.parent_id, 10);
  assertEquals(plan.row.product_name, "Real Hat");
  assertEquals(plan.row.connector_id, "conn-9");
  assertEquals(plan.row.phone, "96555512345");
  assertEquals(plan.row.consent_source, "chat_optin");
  assertEquals(joinInput([sighting("outofstock")], { dryRun: true }).action, "dry_run");
});
