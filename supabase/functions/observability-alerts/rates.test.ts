// supabase/functions/observability-alerts/rates.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { errorRatePercent, triageFailurePercent } from "./rates.ts";

// Regression 2026-09-28: 8 of 23 WhatsApp replies (35%) ran with no triage and nothing alerted.
Deno.test("triageFailurePercent: 8 failures in 23 triaged replies read as 35%", () => {
  assertEquals(triageFailurePercent(23, 8), 35);
});

Deno.test("triageFailurePercent: fewer than 10 triaged replies is no rate at all", () => {
  assertEquals(triageFailurePercent(9, 9), null);
});

// Regression 2026-10-01 06:06: one failed Threads post among 3 log rows paged as a 33% error rate.
Deno.test("errorRatePercent: a quiet window under 20 logs reports no rate, even when every row is an error", () => {
  assertEquals(errorRatePercent(3, 1), null);
  assertEquals(errorRatePercent(19, 19), null);
});

Deno.test("errorRatePercent: a real spike at or above 20 logs still reports its rate", () => {
  assertEquals(errorRatePercent(20, 5), 25);
  assertEquals(errorRatePercent(400, 120), 30);
});
