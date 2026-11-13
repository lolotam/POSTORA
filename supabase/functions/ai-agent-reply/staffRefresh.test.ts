import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { answerWithinBudget, refreshStaffDraft } from "./staffRefresh.ts";
import { modelBudgetRemaining, type StoredTurn } from "./logic.ts";

Deno.test("staff regeneration fallbacks share one elapsed budget", async () => {
  const total = modelBudgetRemaining(0, 0);
  let now = 0;
  const timeouts: number[] = [];
  const answer = await answerWithinBudget({
    tiers: [1, 2, 3], startedAt: 0, ceilingMs: total, now: () => now,
    complete: (_tier, timeout) => {
      timeouts.push(timeout);
      now += total - 10;
      return Promise.reject(new Error("provider timeout"));
    },
  });
  assertEquals(answer, null);
  assertEquals(timeouts, [total, 10]);
});

Deno.test("a staff follow-up during regeneration suppresses the stale refreshed draft", async () => {
  const known: StoredTurn[] = [{ role: "assistant", content: "(staff) Available",
    created_at: "2026-11-13T09:00:00Z", source_id: "send-1" }];
  for (const scenario of ["unchanged", "follow-up", "read-failed", "model-failed"]) {
    let generated = false;
    const result = await refreshStaffDraft({
      known,
      regenerate: () => { generated = true; return Promise.resolve(scenario === "model-failed" ? null : "Fresh answer"); },
      readLatest: () => {
        assertEquals(generated, true, "the verification read must follow the provider call");
        return Promise.resolve({ readFailed: scenario === "read-failed",
          staffTurns: scenario === "follow-up" ? [...known, { ...known[0], source_id: "send-2" }] : known });
      },
    });
    assertEquals(result, scenario === "unchanged" ? "Fresh answer" : null, scenario);
  }
});
