import { z } from "npm:zod@3.23.8";
import { fetchWithTimeout } from "./request-timeout.ts";
import {
  creatorCapabilitiesFromTikTok,
  type TikTokCreatorCapabilities,
} from "./tiktokPublishPolicy.ts";

const TIKTOK_TIMEOUT_MS = 10_000;
const CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const STATUS_FETCH_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

const POSTING_BLOCKED_REASONS: Record<string, string> = {
  spam_risk_too_many_posts: "You've reached your TikTok daily posting limit. Try again later.",
  spam_risk_user_banned_from_posting: "TikTok is blocking new posts from this account.",
  reached_active_user_cap: "TikTok is temporarily limiting new posts. Try again later.",
  user_posting_banned: "TikTok is blocking new posts from this account.",
};

const TOKEN_INVALID_CODES = new Set(["access_token_invalid", "scope_not_authorized"]);

const PUBLISH_STATUSES = [
  "PROCESSING_UPLOAD",
  "PROCESSING_DOWNLOAD",
  "SEND_TO_USER_INBOX",
  "PUBLISH_COMPLETE",
  "FAILED",
] as const;

export type CreatorInfo = {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
  postingBlocked: boolean;
  postingBlockedReason: string | null;
};

export type CreatorLookup =
  | { kind: "ok"; creator: CreatorInfo; capabilities: TikTokCreatorCapabilities }
  | {
    kind: "blocked";
    creator: CreatorInfo;
    capabilities: TikTokCreatorCapabilities | null;
  }
  | { kind: "token_invalid" }
  | { kind: "unavailable" };

export type PublishFetch =
  | { kind: "pending" }
  | { kind: "complete"; providerPostId: string | null }
  | { kind: "failed"; reason: string; providerPostId: string | null }
  | { kind: "unavailable"; code: "TOKEN_INVALID" | "PROVIDER_UNAVAILABLE" };

const ErrorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
});

const CreatorEnvelope = z.object({
  data: z.unknown().optional(),
  error: ErrorSchema.optional(),
});

const StatusEnvelope = z.object({
  data: z.object({
    status: z.enum(PUBLISH_STATUSES),
    fail_reason: z.string().nullish(),
    publicaly_available_post_id: z.array(z.string()).nullish(),
  }).optional(),
  error: ErrorSchema.optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function creatorFromData(
  data: unknown,
  capabilities: TikTokCreatorCapabilities | null,
  postingBlocked: boolean,
  postingBlockedReason: string | null,
  fallbackUsername: string | null,
  fallbackAvatar: string | null,
): CreatorInfo {
  const row = isRecord(data) ? data : null;
  const username = nonEmpty(row?.creator_username) ?? fallbackUsername ?? "";
  return {
    nickname: nonEmpty(row?.creator_nickname) ?? fallbackUsername ?? username,
    username,
    avatarUrl: nonEmpty(row?.creator_avatar_url) ?? fallbackAvatar,
    privacyLevelOptions: capabilities ? [...capabilities.privacyLevelOptions] : [],
    commentDisabled: capabilities ? capabilities.commentDisabled : false,
    duetDisabled: capabilities ? capabilities.duetDisabled : false,
    stitchDisabled: capabilities ? capabilities.stitchDisabled : false,
    maxVideoPostDurationSec: capabilities ? capabilities.maxVideoPostDurationSec : 0,
    postingBlocked,
    postingBlockedReason,
  };
}

async function postTikTok(
  fetcher: typeof fetch,
  url: string,
  accessToken: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, TIKTOK_TIMEOUT_MS, fetcher);
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

export async function queryCreatorInfo(
  fetcher: typeof fetch,
  accessToken: string,
  fallbackUsername: string | null,
  fallbackAvatar: string | null,
): Promise<CreatorLookup> {
  let payload: unknown;
  try {
    payload = await postTikTok(fetcher, CREATOR_INFO_URL, accessToken, {});
  } catch {
    return { kind: "unavailable" };
  }
  const parsed = CreatorEnvelope.safeParse(payload);
  if (!parsed.success) return { kind: "unavailable" };

  const errorCode = parsed.data.error?.code;
  const capabilities = creatorCapabilitiesFromTikTok(parsed.data.data ?? null);
  if (errorCode && errorCode !== "ok") {
    if (TOKEN_INVALID_CODES.has(errorCode)) return { kind: "token_invalid" };
    const reason = POSTING_BLOCKED_REASONS[errorCode];
    if (reason) {
      return {
        kind: "blocked",
        capabilities,
        creator: creatorFromData(
          parsed.data.data,
          capabilities,
          true,
          reason,
          fallbackUsername,
          fallbackAvatar,
        ),
      };
    }
    return { kind: "unavailable" };
  }
  if (!capabilities) return { kind: "unavailable" };
  return {
    kind: "ok",
    capabilities,
    creator: creatorFromData(
      parsed.data.data,
      capabilities,
      false,
      null,
      fallbackUsername,
      fallbackAvatar,
    ),
  };
}

export async function fetchPublishStatus(
  fetcher: typeof fetch,
  accessToken: string,
  publishId: string,
): Promise<PublishFetch> {
  let payload: unknown;
  try {
    payload = await postTikTok(fetcher, STATUS_FETCH_URL, accessToken, { publish_id: publishId });
  } catch {
    return { kind: "unavailable", code: "PROVIDER_UNAVAILABLE" };
  }
  const parsed = StatusEnvelope.safeParse(payload);
  if (!parsed.success) return { kind: "unavailable", code: "PROVIDER_UNAVAILABLE" };
  const errorCode = parsed.data.error?.code;
  if (errorCode && errorCode !== "ok") {
    return {
      kind: "unavailable",
      code: TOKEN_INVALID_CODES.has(errorCode) ? "TOKEN_INVALID" : "PROVIDER_UNAVAILABLE",
    };
  }
  const data = parsed.data.data;
  if (!data) return { kind: "unavailable", code: "PROVIDER_UNAVAILABLE" };
  if (data.status === "PUBLISH_COMPLETE") {
    return {
      kind: "complete",
      providerPostId: data.publicaly_available_post_id?.[0] ?? null,
    };
  }
  if (data.status === "FAILED") {
    const reason = data.fail_reason;
    return {
      kind: "failed",
      reason: reason && reason.length > 0 ? reason : "TikTok could not publish this post.",
      providerPostId: data.publicaly_available_post_id?.[0] ?? null,
    };
  }
  return { kind: "pending" };
}
