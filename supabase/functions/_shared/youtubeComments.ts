// One door for every YouTube comment call, for both auth providers. Native rows carry Google
// refresh tokens; Composio rows carry no token and execute a pinned tool whose `data` is
// Google's response body. That common response shape lets both providers share one parser.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type ComposioClient,
  composioClientFromEnv,
} from "./composioClient.ts";
import { loadActiveConnection } from "./composioConnections.ts";
import { composioBinding } from "./connectorRegistry.ts";
import {
  type ConnectorCallMeta,
  ConnectorRefusal,
  resolveWorkspaceForCall,
  withConnectorCall,
} from "./connectorTelemetry.ts";
import {
  refreshYouTubeToken,
  YouTubeInvalidGrantError,
} from "./social-auth.ts";
import {
  classifyComposioError,
  classifyGoogleError,
  type YouTubeErrorClass,
} from "./youtubeApiErrors.ts";
import { YOUTUBE_COMMENT_SCOPE } from "./youtubeCommentCapability.ts";
import {
  dropGrantedScope,
  recordGrantedScopes,
} from "./youtubeGrantedScopes.ts";

const DATA_API = "https://www.googleapis.com/youtube/v3";
const REFRESH_WINDOW_MS = 30 * 60 * 1000;
const CALL_TIMEOUT_MS = 15_000;
const COMPOSIO_TIMEOUT_MS = 20_000;
const NATIVE_THREAD_PAGE = 50;
// Composio relays Google's body verbatim and the client refuses anything over COMPOSIO_BODY_CAP
// (64 KB). Measured 2026-09-04 on a live channel: 50 threads with replies is 72 KB, 20 is 33 KB.
const COMPOSIO_THREAD_PAGE = 20;

export interface YouTubeCommentAccount {
  id: string;
  user_id?: string;
  platform: string;
  auth_provider?: string | null;
  access_token: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  platform_user_id?: string | null;
  connection_id?: string | null;
  workspace_id?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface YouTubeCommentsDeps {
  admin: any;
  fetcher?: typeof fetch;
  composio?: ComposioClient | null;
  now?: () => number;
}

export type YouTubeResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: YouTubeErrorClass; message: string };

export interface YouTubeCommentItem {
  id: string;
  // The Google item this was parsed from (a comment, or the whole commentThread for a thread),
  // kept so the inbox stores what arrived rather than this normalized view.
  raw: unknown;
  videoId: string;
  parentId: string | null;
  text: string;
  authorChannelId: string | null;
  authorName: string;
  authorAvatar: string | null;
  publishedAt: string;
  likeCount: number;
  moderationStatus: string | null;
}

export interface YouTubeThreadItem extends YouTubeCommentItem {
  totalReplyCount: number;
  replies: YouTubeCommentItem[];
}

interface Call {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query: Record<string, string>;
  body?: unknown;
  composio: { slug: string; arguments: Record<string, unknown> };
}

export function defaultYouTubeDeps(): YouTubeCommentsDeps {
  return {
    admin: createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    ),
    composio: composioClientFromEnv(),
  };
}

function fail(
  kind: YouTubeErrorClass,
  message: string,
): YouTubeResult<never> {
  return { ok: false, kind, message };
}

interface NativeToken {
  token: string;
  // True when this call minted the token, so a 401 that follows is not retried with another refresh.
  refreshed: boolean;
}

async function nativeToken(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  options: { force?: boolean } = {},
): Promise<YouTubeResult<NativeToken>> {
  const now = deps.now?.() ?? Date.now();
  const expiresAt = account.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : 0;
  if (
    !options.force && account.access_token &&
    expiresAt - now > REFRESH_WINDOW_MS
  ) {
    return {
      ok: true,
      value: { token: account.access_token, refreshed: false },
    };
  }

  // No refresh token is a permanent state, not a transient one: refreshYouTubeToken would
  // return null here, which reads as "temporarily unavailable" and would keep the poller
  // counting failures instead of telling the user to reconnect.
  if (!account.refresh_token) {
    return fail(
      "unauthorized",
      "The YouTube connection has no refresh token. Reconnect the channel in Profiles.",
    );
  }

  let refreshed;
  try {
    refreshed = await refreshYouTubeToken(account as any);
  } catch (error) {
    if (!(error instanceof YouTubeInvalidGrantError)) throw error;
    await deps.admin.from("social_accounts").update({
      needs_reauth: true,
      last_refresh_error: "YouTube refresh failed: invalid_grant",
      updated_at: new Date().toISOString(),
    }).eq("id", account.id);
    return fail(
      "unauthorized",
      "The YouTube connection expired. Reconnect the channel in Profiles.",
    );
  }
  if (!refreshed) {
    return fail(
      "upstream",
      "YouTube token refresh is temporarily unavailable. Try again.",
    );
  }

  await deps.admin.from("social_accounts").update({
    access_token: refreshed.access_token,
    token_expires_at: new Date(now + refreshed.expires_in * 1000).toISOString(),
    needs_reauth: false,
    failure_count: 0,
    last_refresh_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", account.id);
  await recordGrantedScopes(deps.admin, account.id, refreshed.scope);
  account.access_token = refreshed.access_token;
  return {
    ok: true,
    value: { token: refreshed.access_token, refreshed: true },
  };
}

async function sendNative(
  fetcher: typeof fetch,
  call: Call,
  token: string,
): Promise<YouTubeResult<{ status: number; body: any }>> {
  const url = `${DATA_API}/${call.path}?${new URLSearchParams(call.query)}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error";
    return fail("upstream", `Could not reach YouTube: ${message}`);
  }
  const body = response.status === 204
    ? null
    : await response.json().catch(() => null);
  return { ok: true, value: { status: response.status, body } };
}

async function callNative(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  call: Call,
): Promise<YouTubeResult<any>> {
  const fetcher = deps.fetcher ?? fetch;
  let token = await nativeToken(account, deps);
  if (!token.ok) return token;
  let sent = await sendNative(fetcher, call, token.value.token);
  if (!sent.ok) return sent;

  // A 401 on a token this call did not just mint means the stored token was revoked or
  // expired early: refresh once and retry the same request. Retrying is safe for mutating
  // calls too, since a 401 is rejected at Google's auth gate before anything executes. A
  // second 401 falls through to the classifier as unauthorized.
  if (sent.value.status === 401 && !token.value.refreshed) {
    token = await nativeToken(account, deps, { force: true });
    if (!token.ok) return token;
    sent = await sendNative(fetcher, call, token.value.token);
    if (!sent.ok) return sent;
  }

  const { status, body } = sent.value;
  if (status >= 200 && status < 300) return { ok: true, value: body };
  const kind = classifyGoogleError(status, body);
  if (kind === "scope_missing") {
    await dropGrantedScope(deps.admin, account.id, YOUTUBE_COMMENT_SCOPE);
  }
  const message = typeof body?.error?.message === "string"
    ? body.error.message
    : `YouTube returned ${status}.`;
  return fail(kind, message);
}

// A tool that ran but failed upstream. It is thrown inside withConnectorCall so the connector
// ledger records failure, then translated back into the adapter's provider-neutral result.
class YouTubeToolFailure extends Error {
  readonly code: string;

  constructor(readonly kind: YouTubeErrorClass, message: string) {
    super(message);
    this.name = "YouTubeToolFailure";
    this.code = kind;
  }
}

function connectorCallMeta(
  account: YouTubeCommentAccount,
  workspaceId: string,
  actionName: string,
): ConnectorCallMeta {
  return {
    workspaceId,
    connectionId: account.connection_id ?? null,
    socialAccountId: account.id,
    // Deliberately no toolId: connector_call_logs.tool_id is a uuid FK to
    // ai_agent_tools, and this path has no agent tool row -- it polls a
    // channel on a cron. Passing the Composio slug here is what made every
    // insert fail with `invalid input syntax for type uuid` from the moment
    // the poll shipped; the slug's home is action_name, which is text.
    connectorType: "youtube",
    authStrategy: "composio_oauth",
    actionName,
    // The ledger's CHECK admits agent | partner | test | publish. Comment actions are none of
    // those; "publish" is the outbound-to-platform bucket until a "comment" source is added.
    source: "publish",
  };
}

// social_accounts.workspace_id is nullable, but connector_call_logs.workspace_id is a
// NOT NULL uuid: the `?? ""` this replaced made every ledger insert for an
// unbackfilled account throw `invalid input syntax for type uuid: ""`, which
// recordConnectorCall swallowed — blinding the ledger for all callers from
// 2026-09-03 until this fix. Spec §4.3: the account's workspace when known,
// else the owner's personal workspace.
async function workspaceForLedger(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
): Promise<string> {
  if (account.workspace_id) return account.workspace_id;
  if (!account.user_id) throw new Error("workspace_unresolved");
  return await resolveWorkspaceForCall(deps.admin, { userId: account.user_id });
}

async function callComposio(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  call: Call,
): Promise<YouTubeResult<any>> {
  const binding = composioBinding("youtube");
  if (!deps.composio || !binding) {
    return fail("upstream", "Composio is not configured.");
  }
  if (!account.connection_id) {
    return fail(
      "unauthorized",
      "The Composio connection is inactive. Reconnect the channel in Profiles.",
    );
  }

  // Resolved, not taken from the row: a null workspace_id must still produce a
  // real workspace for the ledger, and the connection lookup below runs against
  // the same resolved id. workspace_unresolved (no personal workspace either)
  // is caught by the block below and reported, never thrown past this adapter.
  let workspaceId: string;
  try {
    workspaceId = await workspaceForLedger(account, deps);
  } catch (error) {
    // AGENTS.md rule 4: a refusal that writes nothing anywhere is invisible,
    // and the ledger cannot hold this one -- workspace_id is the very field
    // that could not be resolved.
    console.error(
      `[youtube-comments] workspace unresolved for account ${account.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return fail(
      "upstream",
      "Could not resolve the workspace for this channel. Try again.",
    );
  }

  try {
    const data = await withConnectorCall(
      deps.admin,
      connectorCallMeta(account, workspaceId, call.composio.slug),
      async (signal) => {
        const lookup = await loadActiveConnection(
          deps.admin,
          account.connection_id!,
          workspaceId,
        );
        if (!lookup.ok) throw new ConnectorRefusal(lookup.code);
        const executed = await deps.composio!.executeTool({
          slug: call.composio.slug,
          version: binding.toolkitVersion,
          workspaceId: lookup.connection.workspaceId,
          connectedAccountId: lookup.connection.composioConnectedAccountId,
          arguments: call.composio.arguments,
          signal,
        });
        if (!executed.successful) {
          throw new YouTubeToolFailure(
            classifyComposioError(executed.error),
            executed.error || "Composio call failed.",
          );
        }
        return executed.data;
      },
      { timeoutMs: COMPOSIO_TIMEOUT_MS },
    );
    return { ok: true, value: data };
  } catch (error) {
    if (error instanceof YouTubeToolFailure) {
      return fail(error.kind, error.message);
    }
    if (error instanceof ConnectorRefusal) {
      return fail("unauthorized", `Composio connection: ${error.code}`);
    }
    const message = error instanceof Error
      ? error.message
      : "Composio call failed.";
    return fail("upstream", message);
  }
}

async function callYouTube(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  call: Call,
): Promise<YouTubeResult<any>> {
  return account.auth_provider === "composio"
    ? callComposio(account, deps, call)
    : callNative(account, deps, call);
}

function parseComment(item: any): YouTubeCommentItem {
  const snippet = item?.snippet ?? {};
  return {
    id: String(item?.id ?? ""),
    raw: item,
    videoId: String(snippet.videoId ?? ""),
    parentId: snippet.parentId ? String(snippet.parentId) : null,
    text: String(snippet.textOriginal ?? snippet.textDisplay ?? ""),
    authorChannelId: snippet.authorChannelId?.value
      ? String(snippet.authorChannelId.value)
      : null,
    authorName: String(snippet.authorDisplayName ?? "Unknown"),
    authorAvatar: snippet.authorProfileImageUrl
      ? String(snippet.authorProfileImageUrl)
      : null,
    publishedAt: String(snippet.publishedAt ?? new Date().toISOString()),
    likeCount: Number(snippet.likeCount ?? 0),
    moderationStatus: snippet.moderationStatus
      ? String(snippet.moderationStatus)
      : null,
  };
}

function parseThread(item: any): YouTubeThreadItem {
  const top = parseComment(
    item?.snippet?.topLevelComment ?? { id: item?.id, snippet: {} },
  );
  return {
    ...top,
    id: String(item?.id ?? top.id),
    raw: item,
    videoId: String(item?.snippet?.videoId ?? top.videoId),
    totalReplyCount: Number(item?.snippet?.totalReplyCount ?? 0),
    replies: Array.isArray(item?.replies?.comments)
      ? item.replies.comments.map(parseComment)
      : [],
  };
}

export async function listThreads(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  args: {
    channelId?: string;
    videoId?: string;
    pageToken?: string;
    maxResults?: number;
  },
): Promise<
  YouTubeResult<{ items: YouTubeThreadItem[]; nextPageToken: string | null }>
> {
  const maxResults = args.maxResults ??
    (account.auth_provider === "composio" ? COMPOSIO_THREAD_PAGE : NATIVE_THREAD_PAGE);
  const query: Record<string, string> = {
    part: "snippet,replies",
    order: "time",
    textFormat: "plainText",
    maxResults: String(maxResults),
  };
  if (args.channelId) query.allThreadsRelatedToChannelId = args.channelId;
  if (args.videoId) query.videoId = args.videoId;
  if (args.pageToken) query.pageToken = args.pageToken;

  const composioArguments: Record<string, unknown> = {
    part: "snippet,replies",
    order: "time",
    textFormat: "plainText",
    maxResults,
  };
  if (args.channelId) {
    composioArguments.allThreadsRelatedToChannelId = args.channelId;
  }
  if (args.videoId) composioArguments.videoId = args.videoId;
  if (args.pageToken) composioArguments.pageToken = args.pageToken;

  const result = await callYouTube(account, deps, {
    method: "GET",
    path: "commentThreads",
    query,
    composio: {
      slug: "YOUTUBE_LIST_COMMENT_THREADS",
      arguments: composioArguments,
    },
  });
  if (!result.ok) return result;
  const items = Array.isArray(result.value?.items)
    ? result.value.items.map(parseThread)
    : [];
  return {
    ok: true,
    value: {
      items,
      nextPageToken: result.value?.nextPageToken
        ? String(result.value.nextPageToken)
        : null,
    },
  };
}

export async function listReplies(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  parentId: string,
): Promise<YouTubeResult<YouTubeCommentItem[]>> {
  const result = await listYouTubeRepliesPage(account, deps, { parentId, maxResults: 100 });
  return result.ok ? { ok: true, value: result.value.items } : result;
}

export async function listYouTubeRepliesPage(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  args: { parentId: string; maxResults: number; pageToken?: string },
): Promise<YouTubeResult<{ items: YouTubeCommentItem[]; nextPageToken: string | null }>> {
  const result = await callYouTube(account, deps, {
    method: "GET",
    path: "comments",
    query: {
      part: "snippet",
      parentId: args.parentId,
      maxResults: String(args.maxResults),
      textFormat: "plainText",
      ...(args.pageToken ? { pageToken: args.pageToken } : {}),
    },
    composio: {
      slug: "YOUTUBE_LIST_COMMENTS",
      arguments: {
        part: "snippet",
        parentId: args.parentId,
        maxResults: args.maxResults,
        textFormat: "plainText",
        ...(args.pageToken ? { pageToken: args.pageToken } : {}),
      },
    },
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      items: (Array.isArray(result.value?.items) ? result.value.items : []).map(parseComment),
      nextPageToken: result.value?.nextPageToken ? String(result.value.nextPageToken) : null,
    },
  };
}

// YouTube nests one level: comments.insert accepts only a top-level comment as parentId, so a
// reply aimed at a reply is posted against that reply's parent. The lookup costs 1 quota unit
// on top of the insert's 50.
export async function replyToThread(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  commentId: string,
  text: string,
): Promise<YouTubeResult<{ id: string }>> {
  const snippet = await commentSnippet(account, deps, commentId);
  if (!snippet.ok) return snippet;
  const parentId = snippet.value.parentId ?? commentId;
  const result = await callYouTube(account, deps, {
    method: "POST",
    path: "comments",
    query: { part: "snippet" },
    body: { snippet: { parentId, textOriginal: text } },
    composio: {
      slug: "YOUTUBE_CREATE_COMMENT_REPLY",
      arguments: { parentId, textOriginal: text },
    },
  });
  if (!result.ok) return result;
  const id = result.value?.id ?? result.value?.response_data?.id;
  return id
    ? { ok: true, value: { id: String(id) } }
    : fail("upstream", "YouTube did not return the reply id.");
}

export async function setModerationStatus(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  commentId: string,
  status: "published" | "heldForReview" | "rejected",
): Promise<YouTubeResult<void>> {
  const result = await callYouTube(account, deps, {
    method: "POST",
    path: "comments/setModerationStatus",
    query: { id: commentId, moderationStatus: status },
    composio: {
      slug: "YOUTUBE_SET_COMMENT_MODERATION_STATUS",
      arguments: { id: commentId, moderationStatus: status },
    },
  });
  return result.ok ? { ok: true, value: undefined } : result;
}

// One comments.list?id= call (1 unit) answering the two facts an action needs about its
// target: who wrote it, and whether it is itself a reply.
export async function getYouTubeComment(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  commentId: string,
): Promise<
  YouTubeResult<YouTubeCommentItem>
> {
  const result = await callYouTube(account, deps, {
    method: "GET",
    path: "comments",
    query: { part: "snippet", id: commentId },
    composio: {
      slug: "YOUTUBE_LIST_COMMENTS",
      arguments: { part: "snippet", id: commentId },
    },
  });
  if (!result.ok) return result;
  const item = Array.isArray(result.value?.items)
    ? result.value.items[0]
    : null;
  if (!item) return fail("not_found", "That comment no longer exists.");
  const parsed = parseComment(item);
  return {
    ok: true,
    value: parsed,
  };
}

const commentSnippet = getYouTubeComment;

// comments.delete only works on the authenticated channel's own comments. For anyone else's
// comment the moderation status is the supported tool, so refuse locally with useful copy.
export async function deleteOwnComment(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  commentId: string,
): Promise<YouTubeResult<void>> {
  const snippet = await commentSnippet(account, deps, commentId);
  if (!snippet.ok) return snippet;
  const author = snippet.value.authorChannelId;
  if (!author || author !== account.platform_user_id) {
    return fail(
      "forbidden",
      "YouTube only lets you delete your own comments — hide it instead.",
    );
  }
  const result = await callYouTube(account, deps, {
    method: "DELETE",
    path: "comments",
    query: { id: commentId },
    composio: { slug: "YOUTUBE_DELETE_COMMENT", arguments: { id: commentId } },
  });
  return result.ok ? { ok: true, value: undefined } : result;
}

/** Deletes an uploaded video. Native (Google OAuth) connections only: callers must not pass a Composio row. */
export async function deleteYouTubeVideo(account: YouTubeCommentAccount, deps: YouTubeCommentsDeps, videoId: string): Promise<YouTubeResult<{ id: string }>> {
  const result = await callNative(account, deps, { method: "DELETE", path: "videos", query: { id: videoId }, composio: { slug: "", arguments: {} } });
  if (!result.ok) return result;
  return { ok: true, value: { id: videoId } };
}

export async function videoTitles(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  videoIds: string[],
): Promise<
  YouTubeResult<Map<string, { title: string; thumbnail: string | null }>>
> {
  const titles = new Map<
    string,
    { title: string; thumbnail: string | null }
  >();
  if (videoIds.length === 0) return { ok: true, value: titles };
  const ids = videoIds.slice(0, 50);
  const result = await callYouTube(account, deps, {
    method: "GET",
    path: "videos",
    query: { part: "snippet", id: ids.join(",") },
    composio: {
      slug: "YOUTUBE_GET_VIDEO_DETAILS_BATCH",
      arguments: { id: ids, parts: ["snippet"] },
    },
  });
  if (!result.ok) return result;
  for (
    const item of Array.isArray(result.value?.items) ? result.value.items : []
  ) {
    titles.set(String(item.id), {
      title: String(item?.snippet?.title ?? ""),
      thumbnail: item?.snippet?.thumbnails?.default?.url ?? null,
    });
  }
  return { ok: true, value: titles };
}

// search.list costs 100 units; the uploads playlist (UU + the channel id without UC) lists
// the same videos, newest first, for one unit.
export function uploadsPlaylistId(channelId: string): string {
  return channelId.startsWith("UC") ? `UU${channelId.slice(2)}` : channelId;
}

export async function listChannelVideos(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  channelId: string,
): Promise<
  YouTubeResult<Array<{ id: string; title: string; publishedAt: string }>>
> {
  const playlistId = uploadsPlaylistId(channelId);
  const result = await callYouTube(account, deps, {
    method: "GET",
    path: "playlistItems",
    query: { part: "snippet", playlistId, maxResults: "25" },
    composio: {
      slug: "YOUTUBE_LIST_PLAYLIST_ITEMS",
      arguments: { playlistId, part: "snippet", maxResults: 25 },
    },
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: (Array.isArray(result.value?.items) ? result.value.items : []).map(
      (item: any) => ({
        id: String(item?.snippet?.resourceId?.videoId ?? ""),
        title: String(item?.snippet?.title ?? ""),
        publishedAt: String(item?.snippet?.publishedAt ?? ""),
      }),
    ).filter((video: { id: string }) => video.id),
  };
}
