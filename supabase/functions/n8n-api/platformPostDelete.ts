// Deletes ONE already-published post on the platform that published it, through a
// registry of per-provider adapters. Instagram and TikTok expose no delete endpoint
// for published posts in their public APIs, so those posts stay on the platform and
// the caller is told to remove them in the app.
import {
  FACEBOOK_GRAPH,
  THREADS_GRAPH,
  callGraph,
} from "../_shared/commentActions.ts";
import {
  deleteYouTubeVideo,
  type YouTubeCommentAccount,
  type YouTubeCommentsDeps,
} from "../_shared/youtubeComments.ts";
import { fetchWithTimeout } from "../_shared/request-timeout.ts";

export type PlatformDeleteOutcome =
  | { outcome: "deleted"; note?: string }
  | { outcome: "kept_on_platform"; reason: string }
  | { outcome: "failed"; reason: string };

export interface PublishedPlatformPost {
  /** platform_posts.id -- the row this delete is about, used for the audit log only. */
  id: string;
  platform: string;
  platform_post_id: string | null;
  social_account_id: string | null;
  response_data: unknown;
}

export interface DeleteAccount {
  id: string;
  user_id: string;
  platform: string;
  access_token: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  auth_provider?: string | null;
  connection_id?: string | null;
  workspace_id?: string | null;
  platform_user_id?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface PlatformDeleteDeps {
  fetcher: typeof fetch;
  /** Lazy so tests and non-YouTube deletes never build a real Supabase client. */
  youtubeDeps: () => YouTubeCommentsDeps;
}

export const PROVIDER_TIMEOUT_MS = 15_000;

type Deleter = (
  platformPostId: string,
  row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
) => Promise<PlatformDeleteOutcome>;

function missingToken(): PlatformDeleteOutcome {
  return {
    outcome: "failed",
    reason: "The account has no access token. Reconnect it in Profiles and retry.",
  };
}

// A platform copy that is already gone is not a failure: the caller asked for it to
// be gone, and it is.
const ALREADY_GONE: PlatformDeleteOutcome = {
  outcome: "deleted",
  note: "Already removed on the platform.",
};

// A provider message can carry the request URL, and the Graph URL carries the access
// token. Nothing that reaches the log or the caller may contain one.
export function redactTokens(text: string): string {
  return text
    .replace(/access_token=[^\s&]*/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
}

// Facebook and Threads are the same Graph call against a different host, so the shape
// lives here once and each platform keeps its own name in the message it reports.
async function deleteViaGraph(
  graph: string,
  platformName: string,
  platformPostId: string,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  if (!account.access_token) return missingToken();
  const outcome = await callGraph(
    deps.fetcher,
    `${graph}/${encodeURIComponent(platformPostId)}?access_token=${encodeURIComponent(account.access_token)}`,
    { method: "DELETE" },
    `${platformName} rejected the delete request.`,
  );
  if (!outcome.ok) {
    // An unreachable platform has no message of its own: the transport error is the
    // only text there is, and it can carry the token.
    if (outcome.failure.upstreamUnavailable) {
      return { outcome: "failed", reason: `Could not reach ${platformName}. Try again.` };
    }
    return {
      outcome: "failed",
      reason: outcome.failure.error ?? `${platformName} rejected the delete request.`,
    };
  }
  // Graph answers a delete with {"success": true}; an explicit false is a refusal.
  if (outcome.data?.success === false) {
    return { outcome: "failed", reason: `${platformName} did not confirm the delete.` };
  }
  return { outcome: "deleted" };
}

async function deleteFacebook(
  platformPostId: string,
  _row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  return deleteViaGraph(FACEBOOK_GRAPH, "Facebook", platformPostId, account, deps);
}

async function deleteThreads(
  platformPostId: string,
  _row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  return deleteViaGraph(THREADS_GRAPH, "Threads", platformPostId, account, deps);
}

async function deleteYoutube(
  platformPostId: string,
  _row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  // A Composio connection has no Google credential of ours to call the Data API with.
  if (account.auth_provider === "composio") {
    return {
      outcome: "kept_on_platform",
      reason: "This YouTube channel is connected through Composio, which cannot delete videos through Postora. Delete it in YouTube Studio.",
    };
  }
  const result = await deleteYouTubeVideo(
    account as unknown as YouTubeCommentAccount,
    { ...deps.youtubeDeps(), fetcher: deps.fetcher },
    platformPostId,
  );
  // A video that is not there any more is already what the caller wanted.
  if (!result.ok && result.kind === "not_found") return ALREADY_GONE;
  if (!result.ok) return { outcome: "failed", reason: result.message };
  return { outcome: "deleted" };
}

async function deletePinterest(
  platformPostId: string,
  _row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  if (!account.access_token) return missingToken();
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `https://api.pinterest.com/v5/pins/${encodeURIComponent(platformPostId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${account.access_token}` },
      },
      PROVIDER_TIMEOUT_MS,
      deps.fetcher,
    );
  } catch {
    // No provider message: a transport error can carry the request URL, and the
    // Pinterest URL carries the token in its header.
    return { outcome: "failed", reason: "Could not reach Pinterest. Try again." };
  }
  if (response.status >= 200 && response.status < 300) return { outcome: "deleted" };
  // A pin that is not there any more is already what the caller wanted.
  if (response.status === 404) return ALREADY_GONE;
  const body = await response.json().catch(() => null) as { message?: unknown } | null;
  const detail = typeof body?.message === "string" ? body.message : "no message";
  return {
    outcome: "failed",
    reason: `Pinterest returned ${response.status}: ${detail}`,
  };
}

// One LinkedIn publish can land on several destinations (a personal feed and one or more
// organization pages), and every destination is its own ugcPost. The publish result
// keeps them all, so the delete has to walk them too.
function linkedinDestinationUrns(
  row: PublishedPlatformPost,
  platformPostId: string,
): string[] {
  const data = row.response_data as { destinations?: unknown } | null | undefined;
  const destinations = Array.isArray(data?.destinations) ? data.destinations : [];
  const urns: string[] = [];
  for (const entry of destinations) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { status?: unknown; post_id?: unknown };
    if (candidate.status !== "success") continue;
    const postId = typeof candidate.post_id === "string" ? candidate.post_id.trim() : "";
    if (!postId) continue;
    urns.push(postId);
  }
  return urns.length > 0 ? urns : [platformPostId];
}

async function deleteLinkedin(
  platformPostId: string,
  row: PublishedPlatformPost,
  account: DeleteAccount,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  if (!account.access_token) return missingToken();
  const urns = linkedinDestinationUrns(row, platformPostId);
  const failures: string[] = [];
  let deleted = 0;
  let alreadyGone = 0;
  for (const urn of urns) {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(urn)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${account.access_token}`,
            "X-Restli-Protocol-Version": "2.0.0",
          },
        },
        PROVIDER_TIMEOUT_MS,
        deps.fetcher,
      );
    } catch {
      failures.push(`${urn}: could not reach LinkedIn`);
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      deleted += 1;
      continue;
    }
    // A destination that is not there any more is already what the caller wanted.
    if (response.status === 404) {
      alreadyGone += 1;
      continue;
    }
    failures.push(`${urn}: LinkedIn returned ${response.status}`);
  }
  if (failures.length === 0) {
    return alreadyGone === urns.length ? ALREADY_GONE : { outcome: "deleted" };
  }
  return {
    outcome: "failed",
    reason: `Deleted ${deleted} of ${urns.length} LinkedIn destinations. ${failures.join("; ")}`,
  };
}

const DELETERS: Record<string, Deleter> = {
  facebook: deleteFacebook,
  threads: deleteThreads,
  youtube: deleteYoutube,
  pinterest: deletePinterest,
  linkedin: deleteLinkedin,
};

export async function deletePublishedPost(
  row: PublishedPlatformPost,
  account: DeleteAccount | null,
  deps: PlatformDeleteDeps,
): Promise<PlatformDeleteOutcome> {
  // Object.hasOwn, not a plain lookup: an inherited key ("constructor",
  // "toString") is not a deleter, and calling one would run the wrong code.
  const deleter = Object.hasOwn(DELETERS, row.platform) ? DELETERS[row.platform] : undefined;
  if (!deleter) {
    if (row.platform === "instagram") {
      return {
        outcome: "kept_on_platform",
        reason: "Instagram's API cannot delete published posts. Delete it in the Instagram app.",
      };
    }
    if (row.platform === "tiktok") {
      return {
        outcome: "kept_on_platform",
        reason: "TikTok's API cannot delete published videos. Delete it in the TikTok app.",
      };
    }
    return {
      outcome: "kept_on_platform",
      reason: `Postora cannot delete ${row.platform} posts on the platform yet. Delete it there directly.`,
    };
  }

  if (!row.platform_post_id) {
    return {
      outcome: "kept_on_platform",
      reason: "Postora has no platform post id for this result, so it cannot be deleted on the platform.",
    };
  }

  if (!account) {
    return {
      outcome: "kept_on_platform",
      reason: `The ${row.platform} account that published this post is no longer connected to Postora, so it cannot be deleted on the platform.`,
    };
  }

  try {
    const outcome = await deleter(row.platform_post_id, row, account, deps);
    if (outcome.outcome === "failed") {
      // The reason is the one text a provider controls, so it is redacted once here:
      // everything that leaves this function goes through this block.
      const reason = redactTokens(outcome.reason);
      // Ids and the reason only: a token must never reach the log.
      console.warn(
        `[n8n-api] posts/delete: ${row.platform} delete failed for platform_posts ${row.id}: ${reason}`,
      );
      return { outcome: "failed", reason };
    }
    return outcome;
  } catch (thrown) {
    // The name only: a provider message can carry a URL with a token in it.
    console.error(
      `[n8n-api] posts/delete: unexpected ${row.platform} delete error for platform_posts ${row.id}: ${thrown instanceof Error ? thrown.name : "unknown"}`,
    );
    return {
      outcome: "failed",
      reason: `Unexpected error while deleting on ${row.platform}.`,
    };
  }
}
