import { isDirectInstagramAccount } from "./messengerCredentials.ts";

const GRAPH_API_VERSION = "v22.0";
const FACEBOOK_GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const INSTAGRAM_GRAPH = `https://graph.instagram.com/${GRAPH_API_VERSION}`;
const THREADS_GRAPH = "https://graph.threads.net/v1.0";

export interface CommentActionAccount {
  platform: string;
  access_token: string | null;
  platform_user_id?: string | null;
  ig_auth_type?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface CommentActionResult {
  success: boolean;
  platform_comment_id?: string;
  error?: string;
}

type Fetcher = typeof fetch;

function metaBase(account: CommentActionAccount): string {
  return isDirectInstagramAccount(account) ? INSTAGRAM_GRAPH : FACEBOOK_GRAPH;
}

async function readJson(response: Response): Promise<any> {
  return await response.json().catch(() => ({ error: { message: response.statusText } }));
}

// error_user_msg first: Meta writes it for humans ("This comment was deleted") while
// message is the developer string ("(#100) Object does not exist"). The comment manager
// surfaces whichever one lands here straight to the user.
function failure(data: any, fallback: string): CommentActionResult {
  return {
    success: false,
    error: data?.error?.error_user_msg || data?.error?.message || data?.error || fallback,
  };
}

function requireToken(account: CommentActionAccount): string | CommentActionResult {
  return account.access_token || { success: false, error: "The account has no access token. Reconnect it in Profiles." };
}

export async function replyToComment(account: CommentActionAccount, commentId: string, message: string, fetcher: Fetcher = fetch): Promise<CommentActionResult> {
  const token = requireToken(account);
  if (typeof token !== "string") return token;
  if (account.platform === "threads") return replyOnThreads(account, token, commentId, message, fetcher);

  const response = await fetcher(`${metaBase(account)}/${encodeURIComponent(commentId)}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, access_token: token }),
  });
  const data = await readJson(response);
  if (!response.ok || data?.error) return failure(data, "Meta rejected the reply.");
  return { success: true, platform_comment_id: String(data.id) };
}

async function replyOnThreads(account: CommentActionAccount, token: string, replyToId: string, text: string, fetcher: Fetcher): Promise<CommentActionResult> {
  const userId = encodeURIComponent(String(account.platform_user_id || ""));
  const container = await fetcher(`${THREADS_GRAPH}/${userId}/threads`, {
    method: "POST",
    body: new URLSearchParams({ media_type: "TEXT", reply_to_id: replyToId, text, access_token: token }),
  });
  const containerData = await readJson(container);
  if (!container.ok || containerData?.error || !containerData?.id) return failure(containerData, "Threads rejected the reply container.");

  const publish = await fetcher(`${THREADS_GRAPH}/${userId}/threads_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: String(containerData.id), access_token: token }),
  });
  const publishData = await readJson(publish);
  if (!publish.ok || publishData?.error || !publishData?.id) return failure(publishData, "Threads rejected the reply publish.");
  return { success: true, platform_comment_id: String(publishData.id) };
}

export async function hideComment(account: CommentActionAccount, commentId: string, hide: boolean, fetcher: Fetcher = fetch): Promise<CommentActionResult> {
  const token = requireToken(account);
  if (typeof token !== "string") return token;

  if (account.platform === "threads") {
    const response = await fetcher(`${THREADS_GRAPH}/${encodeURIComponent(commentId)}/manage_reply`, {
      method: "POST",
      body: new URLSearchParams({ hide: String(hide), access_token: token }),
    });
    const data = await readJson(response);
    if (!response.ok || data?.error) return failure(data, "Threads rejected the hide request.");
    return { success: true, platform_comment_id: commentId };
  }

  // Instagram comment objects take `hide`; Facebook ones take `is_hidden`.
  const param = account.platform === "instagram" ? "hide" : "is_hidden";
  const response = await fetcher(`${metaBase(account)}/${encodeURIComponent(commentId)}?${param}=${hide}&access_token=${encodeURIComponent(token)}`, { method: "POST" });
  const data = await readJson(response);
  if (!response.ok || data?.error) return failure(data, "Meta rejected the hide request.");
  return { success: true, platform_comment_id: commentId };
}

export async function deleteComment(account: CommentActionAccount, commentId: string, fetcher: Fetcher = fetch): Promise<CommentActionResult> {
  if (account.platform === "threads") {
    return { success: false, error: "Threads does not allow deleting other users' replies; use hide instead." };
  }
  const token = requireToken(account);
  if (typeof token !== "string") return token;
  const response = await fetcher(`${metaBase(account)}/${encodeURIComponent(commentId)}?access_token=${encodeURIComponent(token)}`, { method: "DELETE" });
  const data = await readJson(response);
  if (!response.ok || data?.error) return failure(data, "Meta rejected the delete request.");
  return { success: true, platform_comment_id: commentId };
}
