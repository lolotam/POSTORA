import { isDirectInstagramAccount } from "./messengerCredentials.ts";
import {
  defaultYouTubeDeps,
  deleteOwnComment,
  replyToThread,
  setModerationStatus,
  type YouTubeCommentAccount,
  type YouTubeCommentsDeps,
  type YouTubeResult,
} from "./youtubeComments.ts";

const GRAPH_API_VERSION = "v22.0";
// The two Graph hosts are exported because the post-delete adapter deletes
// through the same API: the Graph version and the host live here, so the
// delete cannot drift onto another version of the API than the comments use.
export const FACEBOOK_GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const INSTAGRAM_GRAPH = `https://graph.instagram.com/${GRAPH_API_VERSION}`;
export const THREADS_GRAPH = "https://graph.threads.net/v1.0";

export interface CommentActionAccount {
  id?: string;
  user_id?: string;
  platform: string;
  auth_provider?: string | null;
  access_token: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  platform_user_id?: string | null;
  connection_id?: string | null;
  workspace_id?: string | null;
  ig_auth_type?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface CommentActionResult {
  success: boolean;
  platform_comment_id?: string;
  error?: string;
  // Set only when the request never produced a platform response -- a timeout or transport
  // failure. Callers that map this onto HTTP need the distinction: a rejection is the
  // caller's problem to fix and carries a message worth showing, while an unreachable
  // upstream is ours and carries nothing.
  upstreamUnavailable?: boolean;
}

type Fetcher = typeof fetch;

// A hung Graph call would otherwise sit until the edge isolate's wall-clock limit kills it,
// which reaches the caller as a bare gateway error with no body at all.
const GRAPH_TIMEOUT_MS = 15_000;

function metaBase(account: CommentActionAccount): string {
  return isDirectInstagramAccount(account) ? INSTAGRAM_GRAPH : FACEBOOK_GRAPH;
}

// A Facebook comment object has no `/replies` edge: replying to a Facebook comment means
// posting a comment ON that comment. Instagram comment objects do have `/replies`. This
// splits on platform rather than on Graph host, because a Page-linked Instagram account is
// `platform === "instagram"` while still being served by graph.facebook.com, so it needs
// Instagram's edge on Facebook's host. Same per-platform split the hide action already makes
// between `hide` and `is_hidden`.
function replyEdge(account: CommentActionAccount): string {
  return account.platform === "instagram" ? "replies" : "comments";
}

async function readJson(response: Response): Promise<any> {
  return await response.json().catch(() => ({ error: { message: response.statusText } }));
}

// error_user_msg first: Meta writes it for humans ("This comment was deleted") while
// message is the developer string ("(#100) Object does not exist"). The comment manager
// surfaces whichever one lands here straight to the user.
export function failure(data: any, fallback: string): CommentActionResult {
  return {
    success: false,
    error: data?.error?.error_user_msg || data?.error?.message || data?.error || fallback,
  };
}

type GraphOutcome = { ok: true; data: any } | { ok: false; failure: CommentActionResult };

// Every platform call goes through here so the timeout, and the split between a rejection and
// an unreachable upstream, are stated once instead of at each of the five call sites.
export async function callGraph(fetcher: Fetcher, url: string, init: RequestInit, fallback: string): Promise<GraphOutcome> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
  } catch (error) {
    const name = (error as Error)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false,
      failure: {
        success: false,
        upstreamUnavailable: true,
        error: timedOut
          ? `The platform did not respond within ${GRAPH_TIMEOUT_MS / 1000}s.`
          : `Could not reach the platform: ${(error as Error)?.message || "network error"}`,
      },
    };
  }
  const data = await readJson(response);
  if (!response.ok || data?.error) return { ok: false, failure: failure(data, fallback) };
  return { ok: true, data };
}

function requireToken(account: CommentActionAccount): string | CommentActionResult {
  return account.access_token || { success: false, error: "The account has no access token. Reconnect it in Profiles." };
}

const META_PLATFORMS = new Set(["facebook", "instagram"]);

function unsupported(platform: string): CommentActionResult {
  return { success: false, error: `Comments are not supported on ${platform}.` };
}

function asYouTubeAccount(
  account: CommentActionAccount,
): YouTubeCommentAccount {
  return {
    id: account.id ?? "",
    user_id: account.user_id ?? "",
    ...account,
  } as YouTubeCommentAccount;
}

function fromYouTube<T>(
  result: YouTubeResult<T>,
  id: (value: T) => string,
): CommentActionResult {
  if (result.ok) {
    return { success: true, platform_comment_id: id(result.value) };
  }
  return {
    success: false,
    error: result.message,
    upstreamUnavailable: result.kind === "upstream",
  };
}

export async function replyToComment(account: CommentActionAccount, commentId: string, message: string, fetcher: Fetcher = fetch, youtubeDeps?: YouTubeCommentsDeps): Promise<CommentActionResult> {
  if (account.platform === "youtube") {
    return fromYouTube(
      await replyToThread(
        asYouTubeAccount(account),
        { ...(youtubeDeps ?? defaultYouTubeDeps()), fetcher },
        commentId,
        message,
      ),
      (value) => value.id,
    );
  }
  if (account.platform !== "threads" && !META_PLATFORMS.has(account.platform)) {
    return unsupported(account.platform);
  }
  const token = requireToken(account);
  if (typeof token !== "string") return token;
  if (account.platform === "threads") return replyOnThreads(account, token, commentId, message, fetcher);

  const outcome = await callGraph(
    fetcher,
    `${metaBase(account)}/${encodeURIComponent(commentId)}/${replyEdge(account)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, access_token: token }) },
    "Meta rejected the reply.",
  );
  if (!outcome.ok) return outcome.failure;
  return { success: true, platform_comment_id: String(outcome.data.id) };
}

// Production incident, 2026-08-23: an n8n reply failed with "media <container id> not found"
// from threads_publish, and publishing that same container by hand a minute later succeeded.
// Threads prepares a container asynchronously -- even a TEXT one -- and publishing before its
// status is FINISHED is refused as if the id did not exist. The in-app threads-reply function
// already polls for this; the n8n path did not.
const CONTAINER_POLL_MS = 1_500;
const CONTAINER_POLL_ATTEMPTS = 6;

async function waitForThreadsContainer(fetcher: Fetcher, containerId: string, token: string): Promise<GraphOutcome> {
  let last: GraphOutcome = { ok: true, data: { status: "IN_PROGRESS" } };
  for (let attempt = 0; attempt < CONTAINER_POLL_ATTEMPTS; attempt += 1) {
    last = await callGraph(
      fetcher,
      `${THREADS_GRAPH}/${encodeURIComponent(containerId)}?fields=status,error_message&access_token=${encodeURIComponent(token)}`,
      { method: "GET" },
      "Threads did not report the reply container's status.",
    );
    if (!last.ok) return last;
    const status = String(last.data?.status || "").toUpperCase();
    if (status === "FINISHED") return last;
    if (status === "ERROR" || status === "EXPIRED") {
      return { ok: false, failure: failure(last.data, `Threads reply container ${status}.`) };
    }
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_MS));
  }
  return { ok: false, failure: { success: false, error: "Threads did not finish preparing the reply in time. Try again." } };
}

async function replyOnThreads(account: CommentActionAccount, token: string, replyToId: string, text: string, fetcher: Fetcher): Promise<CommentActionResult> {
  const userId = encodeURIComponent(String(account.platform_user_id || ""));
  const container = await callGraph(
    fetcher,
    `${THREADS_GRAPH}/${userId}/threads`,
    { method: "POST", body: new URLSearchParams({ media_type: "TEXT", reply_to_id: replyToId, text, access_token: token }) },
    "Threads rejected the reply container.",
  );
  if (!container.ok) return container.failure;
  if (!container.data?.id) return failure(container.data, "Threads rejected the reply container.");

  const ready = await waitForThreadsContainer(fetcher, String(container.data.id), token);
  if (!ready.ok) return ready.failure;

  const publish = await callGraph(
    fetcher,
    `${THREADS_GRAPH}/${userId}/threads_publish`,
    { method: "POST", body: new URLSearchParams({ creation_id: String(container.data.id), access_token: token }) },
    "Threads rejected the reply publish.",
  );
  if (!publish.ok) return publish.failure;
  if (!publish.data?.id) return failure(publish.data, "Threads rejected the reply publish.");
  return { success: true, platform_comment_id: String(publish.data.id) };
}

export async function hideComment(account: CommentActionAccount, commentId: string, hide: boolean, fetcher: Fetcher = fetch, youtubeDeps?: YouTubeCommentsDeps): Promise<CommentActionResult> {
  if (account.platform === "youtube") {
    return fromYouTube(
      await setModerationStatus(
        asYouTubeAccount(account),
        { ...(youtubeDeps ?? defaultYouTubeDeps()), fetcher },
        commentId,
        hide ? "rejected" : "published",
      ),
      () => commentId,
    );
  }
  if (account.platform !== "threads" && !META_PLATFORMS.has(account.platform)) {
    return unsupported(account.platform);
  }
  const token = requireToken(account);
  if (typeof token !== "string") return token;

  if (account.platform === "threads") {
    const outcome = await callGraph(
      fetcher,
      `${THREADS_GRAPH}/${encodeURIComponent(commentId)}/manage_reply`,
      { method: "POST", body: new URLSearchParams({ hide: String(hide), access_token: token }) },
      "Threads rejected the hide request.",
    );
    if (!outcome.ok) return outcome.failure;
    return { success: true, platform_comment_id: commentId };
  }

  // Instagram comment objects take `hide`; Facebook ones take `is_hidden`.
  const param = account.platform === "instagram" ? "hide" : "is_hidden";
  const outcome = await callGraph(
    fetcher,
    `${metaBase(account)}/${encodeURIComponent(commentId)}?${param}=${hide}&access_token=${encodeURIComponent(token)}`,
    { method: "POST" },
    "Meta rejected the hide request.",
  );
  if (!outcome.ok) return outcome.failure;
  return { success: true, platform_comment_id: commentId };
}

export async function deleteComment(account: CommentActionAccount, commentId: string, fetcher: Fetcher = fetch, youtubeDeps?: YouTubeCommentsDeps): Promise<CommentActionResult> {
  if (account.platform === "youtube") {
    return fromYouTube(
      await deleteOwnComment(
        asYouTubeAccount(account),
        { ...(youtubeDeps ?? defaultYouTubeDeps()), fetcher },
        commentId,
      ),
      () => commentId,
    );
  }
  if (account.platform === "threads") {
    return { success: false, error: "Threads does not allow deleting other users' replies; use hide instead." };
  }
  if (!META_PLATFORMS.has(account.platform)) return unsupported(account.platform);
  const token = requireToken(account);
  if (typeof token !== "string") return token;
  const outcome = await callGraph(
    fetcher,
    `${metaBase(account)}/${encodeURIComponent(commentId)}?access_token=${encodeURIComponent(token)}`,
    { method: "DELETE" },
    "Meta rejected the delete request.",
  );
  if (!outcome.ok) return outcome.failure;
  return { success: true, platform_comment_id: commentId };
}
