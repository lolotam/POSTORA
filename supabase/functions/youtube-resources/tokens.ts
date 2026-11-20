import type { YouTubeRefreshOutcome } from "../_shared/youtubeTokenRefresh.ts";
import type { YouTubeTokenResult } from "./handler.ts";

export function tokenResultFromOutcome(outcome: YouTubeRefreshOutcome): YouTubeTokenResult {
  if (outcome.ok) {
    // Only a token this call minted counts: a reused one may still be rejected and
    // then deserves its single forced refresh.
    return { ok: true, accessToken: outcome.accessToken, minted: outcome.status === "refreshed" };
  }
  // refresh_refused is a permanent Google refusal (invalid_client, unauthorized_client):
  // a retry can never succeed, so the caller is sent to reconnect like the other
  // permanent refusals. Retryable refusals, lease contention and a vanished row stay
  // upstream_unavailable — worth one later retry, not a reconnect.
  if (
    outcome.status === "needs_reauth" ||
    outcome.reason === "no_refresh_token" ||
    outcome.reason === "refresh_refused"
  ) {
    return { ok: false, code: "reconnect_required" };
  }
  return { ok: false, code: "upstream_unavailable" };
}
