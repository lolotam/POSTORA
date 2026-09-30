// supabase/functions/observability-alerts/jevTriage.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { triageFailurePercent } from "./jevTriage.ts";

// Regression 2026-09-28: 8 of 23 WhatsApp replies (35%) ran with no triage and nothing alerted.
Deno.test("triageFailurePercent: 8 failures in 23 triaged replies read as 35%", () => {
  assertEquals(triageFailurePercent(23, 8), 35);
});

Deno.test("triageFailurePercent: fewer than 10 triaged replies is no rate at all", () => {
  assertEquals(triageFailurePercent(9, 9), null);
});
