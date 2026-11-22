// The Stage 4 contract.
//
// One Zod schema per action, with STRICT keys: a body that carries
// `banAuthor`, `user_id` or `channel_id` fails validation instead of being
// ignored. Identity never comes from the body.
//
// The schemas are shared with the interface: `src/features/youtube-comments`
// imports the types from here, so the two sides cannot drift.

import { z } from "https://esm.sh/zod@3.25.76";

export const STAGE4_ACTIONS = [
  "youtube_stage4_capabilities",
  "youtube_video_page",
  "youtube_thread_page",
  "youtube_reply_page",
  "youtube_create_thread",
  "youtube_reply",
  "youtube_edit_comment",
  "youtube_ban_confirmation",
  "youtube_moderate_comment",
  "youtube_operation_status",
] as const;

export type Stage4Action = (typeof STAGE4_ACTIONS)[number];

export const STAGE4_CAPABILITIES = ["read", "held", "write", "ban"] as const;
export type Stage4Capability = (typeof STAGE4_CAPABILITIES)[number];

export const STAGE4_LISTS = ["published", "heldForReview"] as const;
export type Stage4List = (typeof STAGE4_LISTS)[number];

export const STAGE4_MODERATION_STATUSES = [
  "published",
  "heldForReview",
  "rejected",
] as const;
export type Stage4ModerationStatus = (typeof STAGE4_MODERATION_STATUSES)[number];

/**
 * The stable refusal reasons. The interface owns the English and Arabic copy
 * for each of them; the server never returns provider text, SQL text or a
 * raw provider object.
 */
export const STAGE4_REASONS = [
  "invalid_request",
  "unauthorized",
  "service_role_not_allowed",
  "rate_limited",
  "not_found",
  "provider_unsupported",
  "account_not_connected",
  "account_needs_reauth",
  "capability_off",
  "prerequisite_missing",
  "account_not_admitted",
  "tile_disabled",
  "rollout_missing",
  "rollout_invalid",
  "settings_unavailable",
  "invalid_handle",
  "expired_handle",
  "cross_context",
  "video_not_owned",
  "target_not_verified",
  "target_not_owned",
  "target_missing_author",
  "comment_text_required",
  "comment_text_too_long",
  "invalid_text",
  "conflict",
  "possible_duplicate",
  "recently_posted",
  "already_recorded",
  "binding_changed",
  "capability_denied",
  "ban_confirmation_required",
  "ban_confirmation_invalid",
  "ban_confirmation_expired",
  "ban_confirmation_mismatch",
  "comments_disabled",
  "scope_missing",
  "quota",
  "unauthorized_provider",
  "forbidden",
  "ineligible_account",
  "not_found_provider",
  "upstream",
  "indeterminate",
  "upstream_inconsistent",
] as const;
export type Stage4Reason = (typeof STAGE4_REASONS)[number];

/** The provider classes a receipt may carry. A 5xx is NEVER a refusal. */
export const STAGE4_PROVIDER_CLASSES = [
  "http_4xx",
  "http_5xx",
  "network",
  "timeout",
  "none",
] as const;
export type Stage4ProviderClass = (typeof STAGE4_PROVIDER_CLASSES)[number];

const accountId = z.string().uuid();
const operationId = z.string().uuid();
const videoId = z.string().min(1).max(128);
const text = z.string().min(1).max(10000);
const handle = z.string().min(1).max(4000);
const cursor = z.string().min(1).max(4000);

export const capabilitiesSchema = z
  .object({
    action: z.literal("youtube_stage4_capabilities"),
    social_account_id: accountId,
  })
  .strict();

export const videoPageSchema = z
  .object({
    action: z.literal("youtube_video_page"),
    social_account_id: accountId,
    cursor: cursor.optional(),
  })
  .strict();

export const threadPageSchema = z
  .object({
    action: z.literal("youtube_thread_page"),
    social_account_id: accountId,
    video_id: videoId,
    list: z.enum(STAGE4_LISTS),
    cursor: cursor.optional(),
  })
  .strict();

export const replyPageSchema = z
  .object({
    action: z.literal("youtube_reply_page"),
    social_account_id: accountId,
    parent_handle: handle,
    cursor: cursor.optional(),
  })
  .strict();

export const createThreadSchema = z
  .object({
    action: z.literal("youtube_create_thread"),
    social_account_id: accountId,
    video_id: videoId,
    text,
    operation_id: operationId,
  })
  .strict();

export const replySchema = z
  .object({
    action: z.literal("youtube_reply"),
    social_account_id: accountId,
    target_handle: handle,
    text,
    operation_id: operationId,
  })
  .strict();

export const editCommentSchema = z
  .object({
    action: z.literal("youtube_edit_comment"),
    social_account_id: accountId,
    target_handle: handle,
    text,
    operation_id: operationId,
  })
  .strict();

export const banConfirmationSchema = z
  .object({
    action: z.literal("youtube_ban_confirmation"),
    social_account_id: accountId,
    target_handle: handle,
    operation_id: operationId,
  })
  .strict();

export const moderateCommentSchema = z
  .object({
    action: z.literal("youtube_moderate_comment"),
    social_account_id: accountId,
    target_handle: handle,
    status: z.enum(STAGE4_MODERATION_STATUSES),
    operation_id: operationId,
    ban_confirmation: handle.optional(),
  })
  .strict();

export const operationStatusSchema = z
  .object({
    action: z.literal("youtube_operation_status"),
    social_account_id: accountId,
    operation_id: operationId,
  })
  .strict();

export const stage4RequestSchema = z.discriminatedUnion("action", [
  capabilitiesSchema,
  videoPageSchema,
  threadPageSchema,
  replyPageSchema,
  createThreadSchema,
  replySchema,
  editCommentSchema,
  banConfirmationSchema,
  moderateCommentSchema,
  operationStatusSchema,
]);

export type Stage4Request = z.infer<typeof stage4RequestSchema>;

/** The action that decides which capability gates it. */
export const STAGE4_ACTION_CAPABILITY: Record<Stage4Action, Stage4Capability | null> = {
  youtube_stage4_capabilities: null,
  youtube_video_page: "read",
  youtube_thread_page: "read",
  youtube_reply_page: "read",
  youtube_create_thread: "write",
  youtube_reply: "write",
  youtube_edit_comment: "write",
  youtube_ban_confirmation: "ban",
  youtube_moderate_comment: "write",
  youtube_operation_status: null,
};

/** The action that decides whether the Held list may be read. */
export const STAGE4_ACTION_REQUIRES_HELD: Partial<Record<Stage4Action, true>> = {
  youtube_thread_page: true,
};

export interface Stage4CapabilityState {
  allowed: boolean;
  reason: Stage4Reason | null;
}

export interface Stage4CapabilitiesPayload {
  account_id: string;
  capabilities: Record<Stage4Capability, Stage4CapabilityState>;
}

export interface Stage4VideoRow {
  id: string;
  title: string;
  published_at: string | null;
  thumbnail_url: string | null;
}

export interface Stage4VideoPagePayload {
  account_id: string;
  channel_id: string;
  items: Stage4VideoRow[];
  next_cursor: string | null;
}

export interface Stage4CommentRow {
  handle: string;
  kind: "thread" | "reply";
  comment_id: string;
  thread_id: string;
  video_id: string;
  canonical_parent_id: string;
  author_channel_id: string | null;
  author_name: string;
  author_avatar_url: string | null;
  text: string;
  published_at: string;
  like_count: number;
  moderation_status: string | null;
  is_own: boolean;
}

export interface Stage4ThreadPagePayload {
  account_id: string;
  channel_id: string;
  video_id: string;
  list: Stage4List;
  items: Stage4CommentRow[];
  next_cursor: string | null;
  /** How many rows were dropped because their chain was inconsistent. */
  inconsistent_count: number;
}

export interface Stage4ReplyPagePayload {
  account_id: string;
  channel_id: string;
  parent_handle: string;
  items: Stage4CommentRow[];
  next_cursor: string | null;
  inconsistent_count: number;
}

export interface Stage4ReceiptPayload {
  operation_id: string;
  action: "create_thread" | "reply" | "edit" | "moderate";
  state: "claimed" | "dispatched" | "confirmed" | "refused" | "indeterminate";
  reason: Stage4Reason | null;
  provider_class: Stage4ProviderClass | null;
  moderation_status: Stage4ModerationStatus | null;
  ban_requested: boolean;
  result_thread_id: string | null;
  result_comment_id: string | null;
  binding_generation: number;
  channel_id: string;
}

export interface Stage4BanConfirmationPayload {
  confirmation: string;
  expires_in_seconds: number;
  author_channel_id: string;
  author_name: string;
}

export interface Stage4OperationStatusPayload extends Stage4ReceiptPayload {
  /** The edit observation. It never changes the receipt and never claims causation. */
  observation: "requested_text_observed" | "different_text_observed" | "unavailable" | null;
  observed_text: string | null;
}
