import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  youtubePostDeferral,
  type ScheduledYouTubeRefreshProbe,
} from "./youtubePostDeferral.ts";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const EXPIRED_AT = new Date(NOW - 60_000).toISOString();
const USABLE_AT = new Date(NOW + 2 * 60 * 60_000).toISOString();

const probe = (
  overrides: Partial<ScheduledYouTubeRefreshProbe>,
): ScheduledYouTubeRefreshProbe => ({
  accountId: "yt-1",
  platform: "youtube",
  authProvider: "native",
  isActive: true,
  refreshRefusalReason: null,
  refreshRefusalRetryable: false,
  storedAccessToken: "stored-tok",
  storedTokenExpiresAt: EXPIRED_AT,
  ...overrides,
});

Deno.test("contention with an expired stored token defers the whole post", () => {
  const decision = youtubePostDeferral(
    [
      probe({
        refreshRefusalReason: "refresh_in_progress",
        refreshRefusalRetryable: true,
        storedTokenExpiresAt: EXPIRED_AT,
      }),
      // A healthy non-YouTube account never influences the decision.
      probe({
        accountId: "fb-1",
        platform: "facebook",
        storedTokenExpiresAt: null,
      }),
    ],
    { nowMs: NOW },
  );
  assertEquals(decision.defer, true);
  assertEquals(decision.accountId, "yt-1");
  assertEquals(decision.reason, "refresh_in_progress");
});

Deno.test("contention inside the refresh window still proceeds when the token is publishable", () => {
  // 10 minutes left is inside the refresh window but strictly publishable:
  // the decision follows the publication credential policy, not the refresh
  // window, so the post goes out instead of waiting a tick.
  const decision = youtubePostDeferral(
    [
      probe({
        refreshRefusalReason: "lease_acquire_failed",
        refreshRefusalRetryable: true,
        storedAccessToken: "stored-tok",
        storedTokenExpiresAt: new Date(NOW + 10 * 60_000).toISOString(),
      }),
    ],
    { nowMs: NOW },
  );
  assertEquals(decision.defer, false);
});

Deno.test("contention with a missing expiry defers", () => {
  const decision = youtubePostDeferral(
    [
      probe({
        refreshRefusalReason: "refresh_in_progress",
        refreshRefusalRetryable: true,
        storedAccessToken: "stored-tok",
        storedTokenExpiresAt: null,
      }),
    ],
    { nowMs: NOW },
  );
  assertEquals(decision.defer, true);
  assertEquals(decision.reason, "refresh_in_progress");
});

Deno.test("contention with a missing access token defers", () => {
  const decision = youtubePostDeferral(
    [
      probe({
        refreshRefusalReason: "refresh_in_progress",
        refreshRefusalRetryable: true,
        storedAccessToken: null,
        storedTokenExpiresAt: USABLE_AT,
      }),
    ],
    { nowMs: NOW },
  );
  assertEquals(decision.defer, true);
});

Deno.test("contention with a still-usable stored token proceeds", () => {
  const decision = youtubePostDeferral(
    [
      probe({
        refreshRefusalReason: "refresh_in_progress",
        refreshRefusalRetryable: true,
        storedTokenExpiresAt: USABLE_AT,
      }),
    ],
    { nowMs: NOW },
  );
  assertEquals(decision.defer, false);
});

Deno.test("a non-retryable refusal never defers; the normal failure flow continues", () => {
  const decision = youtubePostDeferral(
    [
      probe({
        refreshRefusalReason: "invalid_account",
        refreshRefusalRetryable: false,
        storedTokenExpiresAt: EXPIRED_AT,
      }),
    ],
    { nowMs: NOW },
  );
  assertEquals(decision.defer, false);
});

Deno.test("a successful YouTube refresh never defers", () => {
  const decision = youtubePostDeferral(
    [
      probe({
        refreshRefusalReason: null,
        refreshRefusalRetryable: false,
        storedTokenExpiresAt: USABLE_AT,
      }),
    ],
    { nowMs: NOW },
  );
  assertEquals(decision.defer, false);
});

Deno.test("a composio YouTube account never defers", () => {
  const decision = youtubePostDeferral(
    [
      probe({
        authProvider: "composio",
        refreshRefusalReason: "refresh_in_progress",
        refreshRefusalRetryable: true,
        storedTokenExpiresAt: EXPIRED_AT,
      }),
    ],
    { nowMs: NOW },
  );
  assertEquals(decision.defer, false);
});

Deno.test("an inactive account with a retryable refusal never defers the post", () => {
  const decision = youtubePostDeferral(
    [
      probe({
        isActive: false,
        refreshRefusalReason: "refresh_in_progress",
        refreshRefusalRetryable: true,
        storedTokenExpiresAt: EXPIRED_AT,
      }),
    ],
    { nowMs: NOW },
  );
  assertEquals(decision.defer, false);
});
