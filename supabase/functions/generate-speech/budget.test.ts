import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { tierTimeout } from "./budget.ts";

// Budget 50s, per-tier max 45s, started at 0; each row is [elapsed ms, expected timeout].
const CASES: Array<[string, number, number | null]> = [
  ["no time elapsed yet: the per-tier max", 0, 45_000],
  ["partway through: whatever remains, under the per-tier max", 10_000, 40_000],
  ["remaining budget exceeds the per-tier max: capped at it", 1_000, 45_000],
  ["less than 5s left: null, too little to start another tier", 46_000, null],
  ["budget already exhausted: null", 60_000, null],
  ["exactly 5s left: still usable", 45_000, 5_000],
];

Deno.test("tierTimeout splits the speech budget across tiers", async (t) => {
  for (const [name, elapsed, expected] of CASES) {
    await t.step(name, () => assertEquals(tierTimeout(0, elapsed, 50_000, 45_000), expected));
  }
});
