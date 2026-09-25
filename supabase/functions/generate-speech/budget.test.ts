import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { tierTimeout } from "./budget.ts";

Deno.test("no time elapsed yet: returns the per-tier max", () => {
  assertEquals(tierTimeout(0, 0, 50_000, 45_000), 45_000);
});

Deno.test("partway through the budget: returns whatever remains, capped by the per-tier max", () => {
  // 10s elapsed of a 50s budget leaves 40s, which is under the 45s per-tier max.
  assertEquals(tierTimeout(0, 10_000, 50_000, 45_000), 40_000);
});

Deno.test("remaining budget still exceeds the per-tier max: caps at the per-tier max", () => {
  // 1s elapsed of a 50s budget leaves 49s, but no single tier should run longer than 45s.
  assertEquals(tierTimeout(0, 1_000, 50_000, 45_000), 45_000);
});

Deno.test("less than 5s of budget left: signals stop by returning null", () => {
  // 46s elapsed of a 50s budget leaves 4s -- too little to bother starting another tier.
  assertEquals(tierTimeout(0, 46_000, 50_000, 45_000), null);
});

Deno.test("budget already exhausted: returns null", () => {
  assertEquals(tierTimeout(0, 60_000, 50_000, 45_000), null);
});

Deno.test("exactly 5s left: 5s is not less than 5s, so it is still usable", () => {
  assertEquals(tierTimeout(0, 45_000, 50_000, 45_000), 5_000);
});
