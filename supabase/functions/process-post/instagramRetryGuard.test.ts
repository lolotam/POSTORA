import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isRetryRun, RETRY_LOOKBACK_MS, retryGuardDecision, retryWindowStart } from "./instagramRetryGuard.ts";

const since = Date.parse("2026-10-30T15:00:00Z");
const live = { id: "m1", caption: "Mirror reel 🪞", timestamp: "2026-10-30T15:03:26+0000", permalink: "https://www.instagram.com/reel/a/" };

Deno.test("a retry finds the post live once and records it instead of posting it again", () => {
  assertEquals(retryGuardDecision([{ id: "m0", caption: "Other" }, live], " Mirror reel 🪞 ", since), { kind: "already_live", media: live });
});

Deno.test("two live copies are never posted a third time, and no copy's id is guessed", () => {
  assertEquals(retryGuardDecision([live, { ...live, id: "m2" }], "Mirror reel 🪞", since), { kind: "already_live_copies", count: 2 });
});

Deno.test("no match, an older match, or no caption publishes as before", () => {
  assertEquals(retryGuardDecision([], "Mirror reel 🪞", since), { kind: "publish" });
  assertEquals(retryGuardDecision([{ ...live, timestamp: "2026-10-29T15:03:26+0000" }], "Mirror reel 🪞", since), { kind: "publish" });
  assertEquals(retryGuardDecision([live], "   ", since), { kind: "publish" });
});

Deno.test("only a run over a post an earlier run finished is a retry", () => {
  assertEquals(isRetryRun("failed", false), true);
  assertEquals(isRetryRun("completed", false), true);
  for (const status of ["pending", "scheduled", "processing", null]) assertEquals(isRetryRun(status, false), false);
  assertEquals(isRetryRun("failed", true), false);
});

Deno.test("the window opens before the later of creation and schedule", () => {
  const created = "2026-10-30T14:00:00Z";
  const scheduled = "2026-10-30T15:00:00Z";
  assertEquals(retryWindowStart({ created_at: created, scheduled_at: scheduled }), Date.parse(scheduled) - RETRY_LOOKBACK_MS);
  assertEquals(retryWindowStart({ created_at: created, scheduled_at: null }), Date.parse(created) - RETRY_LOOKBACK_MS);
});
