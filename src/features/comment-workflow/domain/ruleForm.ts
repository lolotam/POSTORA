import {
  type CommentWorkflowMatchType,
  type CommentWorkflowPlatform,
  type CommentWorkflowRuleInput,
  supportsPrivateReply,
} from "./rule";

/**
 * Turns what the form holds into what the database accepts, or into the reasons it would not.
 *
 * Every rule here mirrors a CHECK constraint on `comment_workflow_rules`. The database is the
 * authority — this exists so a mistake reads as "Add at least one keyword" rather than as a
 * raw constraint name, and so blank entries are stripped before they can be stored. Where the
 * two could drift, the constraint wins and the user sees a toast; that is the safe direction.
 */
export interface RuleFormValues {
  socialAccountId: string;
  platform: CommentWorkflowPlatform | "";
  name: string;
  scope: "all" | "post";
  targetPostId: string;
  matchType: CommentWorkflowMatchType;
  keywords: string[];
  publicReplies: string[];
  dmMessage: string;
  mediaFileId: string | null;
  sendOncePerUser: boolean;
  isActive: boolean;
}

/** Instagram's private-reply limit, the stricter of the two, so one number covers both. */
export const DM_MAX_CHARS = 1000;
/**
 * Room held back for the download link when a file is attached.
 *
 * The link is appended to the message at send time, after two newlines, so a message written
 * to the full limit would post an over-limit body and Meta would refuse every private reply the
 * workflow ever made. A Supabase signed URL runs to roughly 250 characters and the origin is
 * rewritten, so this reserves a generous margin rather than a measured one.
 */
export const DM_LINK_RESERVE_CHARS = 320;

/** The characters actually available for copy, given whether a file rides along. */
export function dmCharacterBudget(hasAttachment: boolean): number {
  return hasAttachment ? DM_MAX_CHARS - DM_LINK_RESERVE_CHARS : DM_MAX_CHARS;
}
export const NAME_MAX_CHARS = 120;
export const MAX_PUBLIC_REPLIES = 5;

export type RuleFormErrors = Partial<Record<keyof RuleFormValues, string>>;

// A STRING discriminant, not a boolean one. This project compiles with `strict: false`
// (tsconfig.app.json), and without strictNullChecks TypeScript will not narrow a union on a
// `true | false` field — `if (!result.ok)` leaves both halves in play and reading `.errors`
// is a compile error. A string literal narrows regardless.
export type ValidationResult =
  | { status: "valid"; input: CommentWorkflowRuleInput }
  | { status: "invalid"; errors: RuleFormErrors };

export const EMPTY_RULE_FORM: RuleFormValues = {
  socialAccountId: "",
  platform: "",
  name: "",
  scope: "all",
  targetPostId: "",
  matchType: "exact",
  keywords: [],
  publicReplies: [""],
  dmMessage: "",
  mediaFileId: null,
  sendOncePerUser: true,
  isActive: true,
};

export function validateRuleForm(values: RuleFormValues): ValidationResult {
  const errors: RuleFormErrors = {};

  const name = values.name.trim();
  const keywords = values.keywords.map((keyword) => keyword.trim()).filter(Boolean);
  const publicReplies = values.publicReplies.map((reply) => reply.trim()).filter(Boolean);

  // Threads carries no private message, and the database refuses one. Dropping it here rather
  // than erroring means switching a rule from Instagram to Threads is a platform change, not a
  // form to repair.
  const canDm = supportsPrivateReply(values.platform);
  const dmMessage = canDm ? values.dmMessage.trim() || null : null;
  const mediaFileId = canDm && dmMessage ? values.mediaFileId : null;

  if (!values.socialAccountId || !values.platform) errors.socialAccountId = "Choose an account.";
  if (!name) errors.name = "Give the workflow a name.";
  else if (name.length > NAME_MAX_CHARS) errors.name = `Keep the name under ${NAME_MAX_CHARS} characters.`;

  if (values.scope === "post" && !values.targetPostId.trim()) {
    errors.targetPostId = "Pick a post, or switch to all posts.";
  }

  if (values.matchType !== "any" && keywords.length === 0) {
    errors.keywords = "Add at least one keyword.";
  }

  if (publicReplies.length > MAX_PUBLIC_REPLIES) {
    errors.publicReplies = `Up to ${MAX_PUBLIC_REPLIES} public replies.`;
  } else if (publicReplies.length === 0 && !dmMessage) {
    errors.publicReplies = canDm
      ? "Add a public reply or a private message — a workflow has to do something."
      : "Add a public reply.";
  }

  const budget = dmCharacterBudget(canDm && !!values.mediaFileId);
  if (canDm && values.dmMessage.trim().length > budget) {
    errors.dmMessage = budget === DM_MAX_CHARS
      ? `Private messages are limited to ${DM_MAX_CHARS} characters.`
      : `With a file attached, keep the message under ${budget} characters — the download link needs the rest.`;
  }

  // Not merely tidiness: the file travels as a link inside the message text, so with no
  // message there is nothing to carry it, and the database says the same.
  if (canDm && values.mediaFileId && !dmMessage) {
    errors.dmMessage = "A file needs a private message to travel in.";
  }

  if (Object.keys(errors).length > 0) return { status: "invalid", errors };

  return {
    status: "valid",
    input: {
      social_account_id: values.socialAccountId,
      platform: values.platform as CommentWorkflowPlatform,
      name,
      target_post_id: values.scope === "post" ? values.targetPostId.trim() : null,
      match_type: values.matchType,
      keywords: values.matchType === "any" ? [] : keywords,
      public_replies: publicReplies,
      dm_message: dmMessage,
      media_file_id: mediaFileId,
      send_once_per_user: values.sendOncePerUser,
      // Carried through rather than forced true: editing a paused workflow must not restart it.
      is_active: values.isActive,
    },
  };
}
