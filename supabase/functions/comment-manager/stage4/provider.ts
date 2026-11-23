// Stage 4 provider operations.
//
// Every operation is a single HTTP request with a 15 second timeout. There is
// NO retry of any kind, including on 401. The shared `callNative` keeps its
// one-time 401 refresh-and-resend for legacy callers; Stage 4 writes use this
// module, because the shared path reports a network failure as the same
// `upstream` class whether or not the request left the process.
//
// The module is built from injected ports (`fetcher`, `clock`) so it is
// testable without Supabase or Google. It performs NO grant, health or
// `needs_reauth` mutation and never calls `dropGrantedScope`.

import type { YouTubeCommentAccount } from "../../_shared/youtubeComments.ts";
import { classifyGoogleError } from "../../_shared/youtubeApiErrors.ts";

const DATA_API = "https://www.googleapis.com/youtube/v3";

export const PROVIDER_TIMEOUT_MS = 15_000;

export type Stage4ProviderClass =
  | "http_4xx"
  | "http_5xx"
  | "network"
  | "timeout"
  | "none";

export type Stage4ProviderResult =
  | { kind: "success"; status: number; body: unknown }
  | { kind: "refused"; status: number; providerClass: "http_4xx"; reason: string; body: unknown }
  | { kind: "indeterminate"; providerClass: Exclude<Stage4ProviderClass, "none">; status?: number };

export interface Stage4ProviderDeps {
  fetcher: typeof fetch;
  clock?: () => number;
}

function makeUrl(path: string, query: Record<string, string>): string {
  return `${DATA_API}/${path}?${new URLSearchParams(query)}`;
}

async function singleRequest(
  deps: Stage4ProviderDeps,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  query: Record<string, string>,
  body: unknown,
  token: string,
): Promise<Stage4ProviderResult> {
  const url = makeUrl(path, query);
  let response: Response;
  try {
    response = await deps.fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error";
    if (/aborted|timeout/i.test(message)) {
      return { kind: "indeterminate", providerClass: "timeout" };
    }
    return { kind: "indeterminate", providerClass: "network" };
  }

  const status = response.status;
  let parsed: unknown = null;
  if (status !== 204) {
    parsed = await response.json().catch(() => null);
  }

  if (status >= 200 && status < 300) {
    // Moderation: only 204 is acceptance. Any other 2xx is indeterminate.
    return { kind: "success", status, body: parsed };
  }

  // A 4xx without a Google error envelope is indeterminate, not a refusal.
  if (status >= 400 && status < 500) {
    const reason = (parsed as { error?: { message?: string } } | null)?.error?.message;
    const hasEnvelope = Array.isArray((parsed as { error?: { errors?: unknown[] } } | null)?.error?.errors);
    if (!hasEnvelope) {
      return { kind: "indeterminate", providerClass: "http_4xx", status };
    }
    const kind = classifyGoogleError(status, parsed);
    const reasonCode = mapReason(kind, parsed);
    return { kind: "refused", status, providerClass: "http_4xx", reason: reasonCode, body: parsed };
  }

  // Any 5xx is indeterminate, with or without an envelope.
  return { kind: "indeterminate", providerClass: "http_5xx", status };
}

function mapReason(kind: string, body: unknown): string {
  const errors = (body as { error?: { errors?: Array<{ reason?: string }> } } | null)?.error?.errors;
  const reason = Array.isArray(errors) ? errors[0]?.reason : undefined;
  if (reason === "commentsDisabled") return "comments_disabled";
  // Text-shape refusals are draft problems, not upstream ones: the interface
  // keeps the draft and reports them inline (spec 11, `invalid_text`).
  if (reason === "commentTextTooLong" || reason === "commentTextRequired"
    || reason === "invalidCommentMetadata" || reason === "invalidCustomEmoji") {
    return "invalid_text";
  }
  // The specific 403 account reason outranks the generic forbidden class,
  // because the interface states it differently (per account, not per request).
  if (reason === "ineligibleAccount") return "ineligible_account";
  if (kind === "scope_missing") return "scope_missing";
  if (kind === "quota") return "quota";
  if (kind === "unauthorized") return "unauthorized_provider";
  if (kind === "not_found") return "not_found_provider";
  if (kind === "forbidden") return "forbidden";
  return "upstream";
}

export interface ProviderAccount {
  id: string;
  platform_user_id: string;
  access_token: string;
}

function accountToCommentAccount(account: ProviderAccount): YouTubeCommentAccount {
  return {
    id: account.id,
    platform: "youtube",
    auth_provider: "native",
    access_token: account.access_token,
    platform_user_id: account.platform_user_id,
  };
}

export async function listUploads(
  deps: Stage4ProviderDeps,
  account: ProviderAccount,
  token: string,
  args: { pageToken?: string },
): Promise<Stage4ProviderResult> {
  const playlistId = account.platform_user_id.startsWith("UC")
    ? `UU${account.platform_user_id.slice(2)}`
    : account.platform_user_id;
  const query: Record<string, string> = {
    part: "snippet",
    playlistId,
    maxResults: "25",
  };
  if (args.pageToken) query.pageToken = args.pageToken;
  return singleRequest(deps, "GET", "playlistItems", query, undefined, token);
}

export async function listThreadsPage(
  deps: Stage4ProviderDeps,
  account: ProviderAccount,
  token: string,
  args: { videoId?: string; moderationStatus: "published" | "heldForReview"; pageToken?: string },
): Promise<Stage4ProviderResult> {
  const query: Record<string, string> = {
    part: "snippet,replies",
    order: "time",
    textFormat: "plainText",
    maxResults: "20",
    moderationStatus: args.moderationStatus,
  };
  if (args.videoId) query.videoId = args.videoId;
  if (args.pageToken) query.pageToken = args.pageToken;
  // When no videoId is given, scope to the channel via allThreadsRelatedToChannelId.
  if (!args.videoId) query.allThreadsRelatedToChannelId = account.platform_user_id;
  return singleRequest(deps, "GET", "commentThreads", query, undefined, token);
}

export async function listRepliesPage(
  deps: Stage4ProviderDeps,
  token: string,
  args: { parentId: string; pageToken?: string },
): Promise<Stage4ProviderResult> {
  const query: Record<string, string> = {
    part: "snippet",
    parentId: args.parentId,
    maxResults: "50",
    textFormat: "plainText",
  };
  if (args.pageToken) query.pageToken = args.pageToken;
  return singleRequest(deps, "GET", "comments", query, undefined, token);
}

export async function readVideo(
  deps: Stage4ProviderDeps,
  token: string,
  videoId: string,
): Promise<Stage4ProviderResult> {
  return singleRequest(deps, "GET", "videos", { part: "snippet", id: videoId }, undefined, token);
}

export async function readComment(
  deps: Stage4ProviderDeps,
  token: string,
  commentId: string,
): Promise<Stage4ProviderResult> {
  return singleRequest(deps, "GET", "comments", { part: "snippet", id: commentId }, undefined, token);
}

export async function insertThread(
  deps: Stage4ProviderDeps,
  token: string,
  args: { channelId: string; videoId: string; text: string },
): Promise<Stage4ProviderResult> {
  return singleRequest(deps, "POST", "commentThreads", { part: "snippet" }, {
    snippet: {
      channelId: args.channelId,
      videoId: args.videoId,
      topLevelComment: { snippet: { textOriginal: args.text } },
    },
  }, token);
}

export async function insertReply(
  deps: Stage4ProviderDeps,
  token: string,
  args: { parentId: string; text: string },
): Promise<Stage4ProviderResult> {
  return singleRequest(deps, "POST", "comments", { part: "snippet" }, {
    snippet: { parentId: args.parentId, textOriginal: args.text },
  }, token);
}

export async function updateComment(
  deps: Stage4ProviderDeps,
  token: string,
  args: { commentId: string; text: string },
): Promise<Stage4ProviderResult> {
  // comments.update is a PUT; a POST to this path is comments.insert.
  return singleRequest(deps, "PUT", "comments", { part: "snippet" }, {
    id: args.commentId,
    snippet: { textOriginal: args.text },
  }, token);
}

export async function setModerationStatus(
  deps: Stage4ProviderDeps,
  token: string,
  args: { commentId: string; status: "published" | "heldForReview" | "rejected"; banAuthor: boolean },
): Promise<Stage4ProviderResult> {
  const query: Record<string, string> = {
    id: args.commentId,
    moderationStatus: args.status,
  };
  if (args.banAuthor) query.banAuthor = "true";
  return singleRequest(deps, "POST", "comments/setModerationStatus", query, undefined, token);
}

export { accountToCommentAccount };
export type { YouTubeCommentAccount };
