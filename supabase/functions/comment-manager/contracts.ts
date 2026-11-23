// The Stage 4 contract — the Zod layer the Edge function validates with.
//
// The pure types and constants live in `contractTypes.ts` (no imports) so the
// browser shares them without following a Deno-only dependency; this file
// adds the strict schemas. One Zod schema per action with STRICT keys: a body
// that carries `banAuthor`, `user_id` or `channel_id` fails validation
// instead of being ignored. Identity never comes from the body.

import { z } from "https://esm.sh/zod@3.25.76";

export * from "./contractTypes.ts";

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
    /**
     * The draft text the browser still holds, when it holds one. With it the
     * edit observation can distinguish `requested_text_observed` from
     * `different_text_observed`; without it the observation is
     * `unavailable`. Never stored, never logged.
     */
    text: text.optional(),
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
