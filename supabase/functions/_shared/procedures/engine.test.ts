// supabase/functions/_shared/procedures/engine.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { expireIfStale, nextField, recordOffScript, startProcedure, submitFields } from "./engine.ts";
import { TEMPLATES } from "./templates.ts";

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
