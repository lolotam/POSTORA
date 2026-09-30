// supabase/functions/observability-alerts/jevTriage.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { triageFailurePercent, type TriageLogRow } from "./jevTriage.ts";

const answered: TriageLogRow = { triage: { outcome: { provider: "vercel" } } };
const failed: TriageLogRow = { triage: { outcome: null } };
const untriaged: TriageLogRow = { triage: null };
const times = (row: TriageLogRow, n: number) => Array.from({ length: n }, () => row);

// Regression 2026-09-28: 8 of 23 WhatsApp replies (35%) ran with no triage and nothing alerted.
Deno.test("triageFailurePercent: 8 failures in 23 triaged replies read as 35%, ignoring replies with triage off", () => {
  const rows = [...times(answered, 15), ...times(failed, 8), ...times(untriaged, 40)];

  assertEquals(triageFailurePercent(rows), 35);
});

Deno.test("triageFailurePercent: fewer than 10 triaged replies is no rate at all", () => {
  const rows = [...times(failed, 9), ...times(untriaged, 20)];

  assertEquals(triageFailurePercent(rows), null);
});
