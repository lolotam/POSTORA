import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { nextFailureCount, shouldEscalateToReauth } from "./escalation.ts";

const MAX = 3;

Deno.test("a permanent Meta error escalates on the first failure", () => {
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 1, maxFailures: MAX, isPermanentMessage: false,
      canAttemptRefresh: true,
      providerError: { type: "OAuthException", code: 190, transient: false },
    }),
    true,
  );
});

Deno.test("a transient Meta error does not escalate early", () => {
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 1, maxFailures: MAX, isPermanentMessage: false,
      canAttemptRefresh: true,
      providerError: { type: "TimeoutError", transient: true },
    }),
    false,
  );
});

Deno.test("three transient failures do NOT latch a healthy account", () => {
  // The regression guard. The ceiling exists for repeated provider REJECTIONS, not for
  // infrastructure noise: three DNS blips must never retire a working account, because
  // the cron then excludes it forever (`needs_reauth.is.null,needs_reauth.eq.false`).
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 3, maxFailures: MAX, isPermanentMessage: false,
      canAttemptRefresh: true,
      providerError: { type: "TimeoutError", transient: true },
    }),
    false,
  );
});

Deno.test("a non-Meta failure with no provider error still escalates at the ceiling", () => {
  // Unchanged behaviour for every adapter that reports no structured error.
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 3, maxFailures: MAX, isPermanentMessage: false, canAttemptRefresh: true,
    }),
    true,
  );
});

Deno.test("a platform that cannot refresh at all escalates immediately", () => {
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 1, maxFailures: MAX, isPermanentMessage: false, canAttemptRefresh: false,
    }),
    true,
  );
});

Deno.test("a permanent message escalates with no provider error present", () => {
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 1, maxFailures: MAX, isPermanentMessage: true, canAttemptRefresh: true,
    }),
    true,
  );
});

// Regression guard (Codex review round 3, PR #69): declining to latch ON a transient
// failure is not enough if the counter still rises, because a later failure then arrives
// at the ceiling carrying two timeouts' worth of borrowed evidence.
Deno.test("a transient failure does not move the failure counter", () => {
  assertEquals(nextFailureCount(2, { type: "TimeoutError", transient: true }), 2);
});

Deno.test("a non-transient failure increments the counter", () => {
  assertEquals(nextFailureCount(2, { type: "OAuthException", code: 100, transient: false }), 3);
});

Deno.test("a failure with no provider error still increments", () => {
  assertEquals(nextFailureCount(0, undefined), 1);
});

Deno.test("two timeouts then one real failure does NOT reach the ceiling", () => {
  const timeout = { type: "TimeoutError", transient: true };
  let count = 0;
  count = nextFailureCount(count, timeout);
  count = nextFailureCount(count, timeout);
  count = nextFailureCount(count, { type: "OAuthException", code: 100, transient: false });
  assertEquals(count, 1);
  assertEquals(
    shouldEscalateToReauth({
      failureCount: count,
      maxFailures: 3,
      isPermanentMessage: false,
      canAttemptRefresh: true,
      providerError: { type: "OAuthException", code: 100, transient: false },
    }),
    false,
  );
});
