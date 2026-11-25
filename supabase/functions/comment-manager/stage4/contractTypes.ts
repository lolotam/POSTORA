// The Stage 4 contract — the pure types and constants.
//
// This file has NO imports so the browser bundle can share the contract with
// the Edge function without following a Deno-only dependency: it is the one
// authoritative definition (ARCHITECTURE 22), and `contracts.ts` layers the
// Zod schemas on top of it for the server side.

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
 * Whether Hold is offered, and accepted, for a comment that is already
 * published. Google's implementation guide says a comment that is `published`
 * or `rejected` cannot return to `heldForReview`, and a 204 would still be
 * recorded as confirmed while the comment stays public. Off until a rehearsal
 * on a real channel shows YouTube applies the transition; flipping this one
 * constant restores both the control and the handler's acceptance.
 */
export const STAGE4_HOLD_FROM_PUBLISHED = false;

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

export interface Stage4CapabilityState {
  allowed: boolean;
  reason: Stage4Reason | null;
}

export interface Stage4CapabilitiesPayload {
  account_id: string;
  capabilities: Record<Stage4Capability, Stage4CapabilityState>;
}

export type Stage4VideoVisibility = "public" | "unlisted" | "private";
export type Stage4VideoDateKind = "published" | "uploaded" | "premiered";

export interface Stage4VideoRow {
  id: string;
  title: string;
  published_at: string | null;
  thumbnail_url: string | null;
  description?: string | null;
  visibility?: Stage4VideoVisibility | null;
  date_kind?: Stage4VideoDateKind | null;
  duration_iso?: string | null;
  view_count?: number | null;
  comment_count?: number | null;
  is_short?: boolean | null;
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
  /** The channel binding these rows (and their handles and cursors) belong to; it changes on a reconnect. */
  binding_generation: number;
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
  binding_generation: number;
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
