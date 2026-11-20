import type { YouTubeRefreshOutcome } from "../_shared/youtubeTokenRefresh.ts";
import type { YouTubeTokenResult } from "./handler.ts";

export function tokenResultFromOutcome(outcome: YouTubeRefreshOutcome): YouTubeTokenResult {
  if (outcome.ok) {
    // Only a token this call minted counts: a reused one may still be rejected and
    // then deserves its single forced refresh.
    return { ok: true, accessToken: outcome.accessToken, minted: outcome.status === "refreshed" };
  }
  if (outcome.status === "needs_reauth" || outcome.reason === "no_refresh_token") {
    return { ok: false, code: "reconnect_required" };
  }
  return { ok: false, code: "upstream_unavailable" };
}
