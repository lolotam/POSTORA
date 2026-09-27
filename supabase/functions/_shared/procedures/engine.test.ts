// supabase/functions/_shared/procedures/engine.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import {
  claimHeldByOther, expireIfStale, isPendingOpener, nextField, recordOffScript, startProcedure, submitFields,
} from "./engine.ts";
import { CLAIM_LEASE_MS, TEMPLATES } from "./templates.ts";

const T0 = new Date("2026-09-26T10:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const lead = TEMPLATES.lead_capture.fields;

Deno.test("starting with no active flow creates state at the first field", () => {
  const result = startProcedure(null, "lead_capture", "jev", T0, "run-1");
  assertEquals(result.started, true);
  assertEquals(result.state, {
    run_id: "run-1", key: "lead_capture", version: 1, step: 0, fields: {}, off_script: 0,
    origin: "jev", started_at: T0.toISOString(), updated_at: T0.toISOString(),
  });
});

Deno.test("starting while a flow is active keeps the active flow", () => {
  const active = startProcedure(null, "order_status", "model", T0, "run-1").state;
  const result = startProcedure(active, "lead_capture", "jev", later(1000), "run-2");
  assertEquals(result.started, false);
  assertEquals(result.state, active);
});

Deno.test("a valid partial submit advances to the next missing field and resets off-script", () => {
  const started = { ...startProcedure(null, "lead_capture", "jev", T0, "run-1").state, off_script: 2 };
  const result = submitFields(started, lead, { name: " Sara " }, later(1000));
  assertEquals(result.accepted, ["name"]);
  assertEquals(result.rejected, []);
  assertEquals(result.complete, false);
  assertEquals(result.state.fields, { name: "Sara" });
  assertEquals(result.state.step, 1);
  assertEquals(result.state.off_script, 0);
  assertEquals(nextField(result.state, lead)?.name, "contact");
});

Deno.test("invalid values are rejected with the field name and do not advance", () => {
  const started = startProcedure(null, "order_status", "jev", T0, "run-1").state;
  const result = submitFields(started, TEMPLATES.order_status.fields, { order_number: "abc" }, later(1));
  assertEquals(result.accepted, []);
  assertEquals(result.rejected, [{ field: "order_number", reason: "invalid" }]);
  assertEquals(result.state.step, 0);
});

Deno.test("unknown field names are rejected, not stored", () => {
  const started = startProcedure(null, "booking", "jev", T0, "run-1").state;
  const result = submitFields(started, TEMPLATES.booking.fields, { colour: "red" }, later(1));
  assertEquals(result.rejected, [{ field: "colour", reason: "unknown" }]);
  assertEquals(result.state.fields, {});
});

Deno.test("submitting every field in one call completes the flow", () => {
  const started = startProcedure(null, "order_status", "model", T0, "run-1").state;
  const result = submitFields(started, TEMPLATES.order_status.fields, { order_number: "#1234" }, later(1));
  assertEquals(result.complete, true);
  assertEquals(result.state.fields, { order_number: "1234" });
});

Deno.test("a partly invalid submit keeps the valid field and reports the invalid one", () => {
  const fields = TEMPLATES.complaint_return.fields;
  const started = startProcedure(null, "complaint_return", "jev", T0, "run-1").state;
  const result = submitFields(started, fields, { order_number: "x7", problem: "broken" }, later(1));
  assertEquals(result.accepted, ["problem"]);
  assertEquals(result.rejected, [{ field: "order_number", reason: "invalid" }]);
  assertEquals(result.complete, false);
  assertEquals(result.state.step, 0);
});

Deno.test("the third consecutive off-script turn ends the flow", () => {
  let state = startProcedure(null, "booking", "jev", T0, "run-1").state;
  state = recordOffScript(state, later(1))!;
  state = recordOffScript(state, later(2))!;
  assertEquals(state.off_script, 2);
  assertEquals(recordOffScript(state, later(3)), null);
});

for (const [label, ageMs, version, expected] of [
  ["fresh state is kept", 60_000, 1, "kept"],
  ["state older than 24 h expires", 24 * 60 * 60 * 1000 + 1, 1, "expired"],
  ["state from an older template version expires", 60_000, 0, "expired"],
] as const) {
  Deno.test(`expireIfStale: ${label}`, () => {
    const state = { ...startProcedure(null, "booking", "jev", T0, "run-1").state, version };
    const result = expireIfStale(state, later(ageMs));
    assertEquals(result === null ? "expired" : "kept", expected);
  });
}

const HOUR = 60 * 60 * 1000;
for (const [label, key, origin, ageMs, expected] of [
  ["an event flow at 71 h is kept", "cod_confirm", "event", 71 * HOUR, "kept"],
  ["an event flow at 73 h expires", "cod_confirm", "event", 73 * HOUR, "expired"],
  ["a model flow at 25 h expires", "booking", "model", 25 * HOUR, "expired"],
] as const) {
  Deno.test(`expireIfStale by origin: ${label}`, () => {
    const state = startProcedure(null, key, origin, T0, "run-1").state;
    assertEquals(expireIfStale(state, later(ageMs)) === null ? "expired" : "kept", expected);
  });
}

Deno.test("isPendingOpener is true only for the pending_opener phase", () => {
  const state = startProcedure(null, "cod_confirm", "event", T0, "run-1").state;
  assertEquals(isPendingOpener({ ...state, phase: "pending_opener" }), true);
  assertEquals(isPendingOpener({ ...state, phase: "active" }), false);
  assertEquals(isPendingOpener(state), false);
  assertEquals(isPendingOpener(null), false);
});

Deno.test("a review rated 4 completes without a problem; rated 2 it requires one", () => {
  const fields = TEMPLATES.review_request.fields;
  const started = startProcedure(null, "review_request", "event", T0, "run-1").state;
  const happy = submitFields(started, fields, { rating: "٤" }, later(1));
  assertEquals(happy.state.fields, { rating: "4" });
  assertEquals(happy.complete, true);
  const unhappy = submitFields(started, fields, { rating: "2" }, later(1));
  assertEquals(unhappy.complete, false);
  assertEquals(nextField(unhappy.state, fields)?.name, "problem");
  assertEquals(submitFields(unhappy.state, fields, { problem: "arrived broken" }, later(2)).complete, true);
});

// ai_threads.procedure_state is owner-writable through RLS, so the stored value is untrusted.
for (const [label, stored] of [
  ["fields that are not an object", { fields: null }],
  ["a non-string field value", { fields: { service: 7 } }],
  ["an unparseable updated_at", { updated_at: "soon" }],
] as const) {
  Deno.test(`expireIfStale drops a stored state with ${label}`, () => {
    const state = { ...startProcedure(null, "booking", "jev", T0, "run-1").state, ...stored };
    assertEquals(expireIfStale(state as never, later(1)), null);
  });
}

Deno.test("expireIfStale keeps a stored state that carries claimed_by", () => {
  const state = { ...startProcedure(null, "booking", "jev", T0, "run-1").state, claimed_by: "run-9" };
  assertEquals(expireIfStale(state, later(1)), state);
});

// PR #211 Codex P1: a turn that loads a flow another run has just claimed must not take it over.
for (const [label, claim, now, held] of [
  ["no claim", {}, T0, false],
  ["this run's own claim", { claimed_by: "run-1", claimed_at: T0.toISOString() }, T0, false],
  ["another run's fresh claim", { claimed_by: "run-2", claimed_at: T0.toISOString() }, later(CLAIM_LEASE_MS - 1), true],
  ["another run's expired claim", { claimed_by: "run-2", claimed_at: T0.toISOString() }, later(CLAIM_LEASE_MS), false],
  ["another run's claim with no time", { claimed_by: "run-2" }, T0, false],
] as const) {
  Deno.test(`claimHeldByOther: ${label} -> ${held}`, () => {
    const state = { ...startProcedure(null, "lead_capture", "jev", T0, "run-0").state, ...claim };
    assertEquals(claimHeldByOther(state, "run-1", now), held);
  });
}
