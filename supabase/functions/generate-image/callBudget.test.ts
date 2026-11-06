// deno-lint-ignore-file no-import-prefix
// callBudget.test.ts
import { assertEquals, assertThrows, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { withinCallBudget, budgetSignal, NotEnoughTimeError, timeLeftMs, UNBOUNDED, type CallBudget } from "./callBudget.ts";

const fake = (deadlineMs: number, t: { now: number }, seen: number[]): CallBudget =>
  ({ deadlineMs, now: () => t.now, signal: (ms) => { seen.push(ms); return new AbortController().signal; } });

Deno.test("signal is capped at the time left", () => {
  const seen: number[] = []; const t = { now: 0 };
  budgetSignal(fake(30_000, t, seen), 5_000, 50_000);
  assertEquals(seen, [30_000]);
});
Deno.test("signal is capped at capMs when more time is left", () => {
  const seen: number[] = []; const t = { now: 0 };
  budgetSignal(fake(100_000, t, seen), 5_000, 20_000);
  assertEquals(seen, [20_000]);
});
Deno.test("refuses before sending when less than minMs is left", () => {
  const t = { now: 96_000 };
  assertThrows(() => budgetSignal(fake(100_000, t, []), 5_000, 50_000), NotEnoughTimeError);
});
Deno.test("unbounded keeps today's behaviour", () => {
  assertEquals(budgetSignal(UNBOUNDED(), 5_000, undefined), undefined);
  assertEquals(timeLeftMs(UNBOUNDED()), Number.POSITIVE_INFINITY);
});

Deno.test("a stalled reference operation cannot consume the result-save reserve", async () => {
  const b = fake(10, { now: 0 }, []);
  await assertRejects(() => withinCallBudget(b, () => new Promise<never>(() => {})), NotEnoughTimeError);
});
