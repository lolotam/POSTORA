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

export interface YouTubeCommentAccount {
  id: string;
  user_id: string;
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

async function nativeToken(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
): Promise<YouTubeResult<string>> {
  const now = deps.now?.() ?? Date.now();
  const expiresAt = account.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : 0;
  if (account.access_token && expiresAt - now > REFRESH_WINDOW_MS) {
    return { ok: true, value: account.access_token };
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
  return { ok: true, value: refreshed.access_token };
}

async function callNative(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  call: Call,
): Promise<YouTubeResult<any>> {
  const token = await nativeToken(account, deps);
  if (!token.ok) return token;
  const fetcher = deps.fetcher ?? fetch;
  const url = `${DATA_API}/${call.path}?${new URLSearchParams(call.query)}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${token.value}`,
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
  if (response.ok) return { ok: true, value: body };
  const kind = classifyGoogleError(response.status, body);
  if (kind === "scope_missing") {
    await dropGrantedScope(deps.admin, account.id, YOUTUBE_COMMENT_SCOPE);
  }
  const message = typeof body?.error?.message === "string"
    ? body.error.message
    : `YouTube returned ${response.status}.`;
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
  toolId: string,
): ConnectorCallMeta {
  return {
    workspaceId: account.workspace_id ?? "",
    connectionId: account.connection_id ?? null,
    socialAccountId: account.id,
    toolId,
    connectorType: "youtube",
    authStrategy: "composio_oauth",
    actionName: toolId,
    // The ledger's CHECK admits agent | partner | test | publish. Comment actions are none of
    // those; "publish" is the outbound-to-platform bucket until a "comment" source is added.
    source: "publish",
  };
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
  if (!account.connection_id || !account.workspace_id) {
    return fail(
      "unauthorized",
      "The Composio connection is inactive. Reconnect the channel in Profiles.",
    );
  }

  try {
    const data = await withConnectorCall(
      deps.admin,
      connectorCallMeta(account, call.composio.slug),
      async (signal) => {
        const lookup = await loadActiveConnection(
          deps.admin,
          account.connection_id!,
          account.workspace_id!,
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
  const query: Record<string, string> = {
    part: "snippet,replies",
    order: "time",
    textFormat: "plainText",
    maxResults: String(args.maxResults ?? 50),
  };
  if (args.channelId) query.allThreadsRelatedToChannelId = args.channelId;
  if (args.videoId) query.videoId = args.videoId;
  if (args.pageToken) query.pageToken = args.pageToken;

  const composioArguments: Record<string, unknown> = {
    part: "snippet,replies",
    order: "time",
    textFormat: "plainText",
    maxResults: args.maxResults ?? 50,
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
  const result = await callYouTube(account, deps, {
    method: "GET",
    path: "comments",
    query: {
      part: "snippet",
      parentId,
      maxResults: "100",
      textFormat: "plainText",
    },
    composio: {
      slug: "YOUTUBE_LIST_COMMENTS",
      arguments: {
        part: "snippet",
        parentId,
        maxResults: 100,
        textFormat: "plainText",
      },
    },
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: (Array.isArray(result.value?.items) ? result.value.items : []).map(
      parseComment,
    ),
  };
}

export async function replyToThread(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  parentId: string,
  text: string,
): Promise<YouTubeResult<{ id: string }>> {
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

async function commentAuthor(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  commentId: string,
): Promise<YouTubeResult<string | null>> {
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
  return item
    ? { ok: true, value: parseComment(item).authorChannelId }
    : fail("not_found", "That comment no longer exists.");
}

// comments.delete only works on the authenticated channel's own comments. For anyone else's
// comment the moderation status is the supported tool, so refuse locally with useful copy.
export async function deleteOwnComment(
  account: YouTubeCommentAccount,
  deps: YouTubeCommentsDeps,
  commentId: string,
): Promise<YouTubeResult<void>> {
  const author = await commentAuthor(account, deps, commentId);
  if (!author.ok) return author;
  if (!author.value || author.value !== account.platform_user_id) {
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
