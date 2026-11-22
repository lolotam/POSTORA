/**
 * Shared policy for the native YouTube resumable upload path.
 *
 * Four things live here because more than one module needs them and they must
 * not drift:
 *
 * 1. The stable public reason codes. A caller (the dashboard, the n8n node,
 *    the reconciler) matches on these, so they never carry provider text.
 * 2. The redaction applied to anything that reaches a log line or a stored
 *    error column. Provider bodies and exception messages can contain the
 *    resumable session URL, which carries the upload credential.
 * 3. The media egress policy. A video is read back from storage or a CDN, and
 *    that read is a network call the attacker could aim at an internal host.
 * 4. The credential policy. The publish path and the continuation have to
 *    agree on which access token may be sent to the provider.
 */

import { publicSupabaseUrl } from "../_shared/publicSupabaseUrl.ts";

/**
 * Stable, machine-readable outcomes.
 *
 * These strings are part of the contract: they are stored on the session row,
 * returned to the dashboard, and matched by the n8n node. Provider text never
 * appears in one of them.
 */
export const YOUTUBE_UPLOAD_REASON = {
  /** The provider accepted the upload and returned a video id. */
  completed: "youtube_upload_completed",
  /** The upload is incomplete but the same provider session can carry it on. */
  resumable: "youtube_upload_resumable",
  /** Nothing was ever sent to the provider. A fresh session is safe. */
  unsent: "youtube_upload_unsent",
  /** The provider may hold a video but Postora cannot prove which one. */
  reconcile: "youtube_upload_reconcile_required",
  /** The provider session expired. A video may exist and cannot be resumed. */
  expired: "youtube_upload_expired",
  /** The provider refused the upload in a way that will not change on retry. */
  rejected: "youtube_upload_rejected",
  quota_exceeded: "youtube_upload_quota_exceeded",
  /** The provider did not answer in a way that can be classified. */
  unknown: "youtube_upload_unknown",
  /** Another worker holds the session lease. */
  lease_conflict: "youtube_upload_lease_conflict",
  /** The post has a newer processing attempt than this session belongs to. */
  stale_attempt: "youtube_upload_stale_attempt",
  /** The post was edited, cancelled or superseded while the upload ran. */
  superseded: "youtube_upload_superseded",
  /** The attempt was cancelled before a video could exist. */
  cancelled: "youtube_upload_cancelled",
  /** The connected account can no longer be used to publish. */
  account_unusable: "youtube_upload_account_unusable",
  /**
   * The account was disconnected while the upload was in flight.
   *
   * The upload ended because the account went away, not because the provider
   * refused it. A video may exist: the account is gone, so nothing can be
   * checked, and the row carries the marker that says so.
   */
  account_disconnected: "youtube_upload_account_disconnected",
  /** The media file is missing, replaced, or not owned by this owner. */
  media_unavailable: "youtube_upload_media_unavailable",
  /**
   * The media host could not be read.
   *
   * It is a separate code from `media_unavailable` because the two mean
   * different things to the customer: one is "the file is gone", the other is
   * "the host did not answer".
   */
  media_read_failed: "youtube_upload_media_read_failed",
  media_range_required: "youtube_upload_media_range_required",
  /** The media lives on a host outside the approved egress policy. */
  media_origin_not_approved: "youtube_upload_media_origin_not_approved",
  /** No session exists for this post and account. */
  not_found: "youtube_upload_not_found",
  /**
   * The session has no provider session of its own.
   *
   * A continuation may open one for a newly admitted upload when no bytes
   * were submitted. It cannot replace a session after a video may exist.
   */
  session_not_open: "youtube_upload_session_not_open",
  /**
   * The post was already published to this channel.
   *
   * A receipt is the proof that the provider holds a video FOR ONE ATTEMPT.
   * A later attempt of the same post is a different publication, and the
   * channel already holds a video of this post.
   */
  already_published: "youtube_upload_already_published",
  /**
   * A legacy, inert session whose post has no proven D3 declarations. The
   * upload has not sent a byte, so it is safe to refuse rather than invent the
   * creator's answers to resume it.
   */
  declaration_required: "youtube_upload_declaration_required",
} as const;

export type YoutubeUploadReason = (typeof YOUTUBE_UPLOAD_REASON)[keyof typeof YOUTUBE_UPLOAD_REASON];

/**
 * The public sentence for each reason code.
 *
 * The text is stable too, but the code is what callers match on. A reason that
 * needs the user to act says so plainly instead of implying a retry is safe.
 */
const PUBLIC_MESSAGE: Record<YoutubeUploadReason, string> = {
  [YOUTUBE_UPLOAD_REASON.completed]: "The YouTube video was uploaded.",
  [YOUTUBE_UPLOAD_REASON.resumable]:
    "The YouTube upload is not finished yet and will continue shortly.",
  [YOUTUBE_UPLOAD_REASON.unsent]: "The YouTube upload did not start and can be retried.",
  [YOUTUBE_UPLOAD_REASON.reconcile]:
    "YouTube may have a video from this upload but Postora cannot confirm which one. " +
    "Check your YouTube channel and contact support before retrying.",
  [YOUTUBE_UPLOAD_REASON.expired]:
    "The YouTube upload session expired. YouTube may still have a video from it. " +
    "Check your channel before retrying.",
  [YOUTUBE_UPLOAD_REASON.rejected]: "YouTube refused this upload.",
  [YOUTUBE_UPLOAD_REASON.quota_exceeded]: "YouTube API quota exceeded. Try again tomorrow.",
  [YOUTUBE_UPLOAD_REASON.unknown]:
    "YouTube did not confirm the upload. It will be checked again shortly.",
  [YOUTUBE_UPLOAD_REASON.lease_conflict]: "Another worker is already uploading to YouTube.",
  [YOUTUBE_UPLOAD_REASON.stale_attempt]:
    "This upload belongs to an older attempt of the post and was not continued.",
  [YOUTUBE_UPLOAD_REASON.superseded]:
    "The post was changed while the YouTube upload was running, so the upload was stopped.",
  [YOUTUBE_UPLOAD_REASON.cancelled]: "The YouTube upload was cancelled.",
  [YOUTUBE_UPLOAD_REASON.account_unusable]:
    "The connected YouTube account can no longer publish. Reconnect it and retry.",
  [YOUTUBE_UPLOAD_REASON.account_disconnected]:
    "The YouTube account was disconnected before the upload finished. " +
    "YouTube may still have a video from it, so check your channel before retrying.",
  [YOUTUBE_UPLOAD_REASON.media_unavailable]:
    "The video for this post is no longer available in the media library.",
  [YOUTUBE_UPLOAD_REASON.media_read_failed]:
    "The video could not be read from the media host. Retry the publish.",
  [YOUTUBE_UPLOAD_REASON.media_range_required]:
    "This media host could not resume the upload in time. Check YouTube before retrying with a file from the media library.",
  [YOUTUBE_UPLOAD_REASON.media_origin_not_approved]:
    "The video is stored outside Postora's approved media hosts and cannot be uploaded safely.",
  [YOUTUBE_UPLOAD_REASON.not_found]: "No YouTube upload was found for this post.",
  [YOUTUBE_UPLOAD_REASON.session_not_open]:
    "No active YouTube upload session is available.",
  [YOUTUBE_UPLOAD_REASON.already_published]:
    "This post was already published to this YouTube channel. " +
    "Create a new post to publish a different video to the same channel.",
  [YOUTUBE_UPLOAD_REASON.declaration_required]:
    "Choose Yes or No for the audience and synthetic-media declarations before this YouTube upload can continue.",
};

/** The public message for a reason code. Unknown codes get a neutral message. */
export function youtubeUploadPublicMessage(reason: YoutubeUploadReason | string): string {
  return PUBLIC_MESSAGE[reason as YoutubeUploadReason] ?? "The YouTube upload could not be completed.";
}

/**
 * The reason a credential may not be sent to the provider, or null when it may.
 *
 * A token is good while it is still good. An expiry in the past means the
 * provider will refuse it, and that refusal says nothing about the video, so
 * the token is not sent. A token without an expiry is not known to be good,
 * and a token that is not known to be good is not used.
 *
 * The publish path and the continuation path share this rule, because a rule
 * that exists twice is a rule that will disagree. The publish path admits the
 * upload BEFORE the provider is contacted, so a credential it may not use has
 * to be refused before the admission: otherwise the pending row of an upload
 * that can never start is written first.
 */
export function youtubeCredentialRefusalReason(
  accessToken: string | null | undefined,
  tokenExpiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): YoutubeUploadReason | null {
  if (!accessToken || !tokenExpiresAt) return YOUTUBE_UPLOAD_REASON.account_unusable;
  const expiresAt = Date.parse(tokenExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return YOUTUBE_UPLOAD_REASON.account_unusable;
  return null;
}

/**
 * Removes the credential out of arbitrary text.
 *
 * A provider error can echo the request it refused, and the request carries
 * the session URI. The `upload_id` is what makes that URI a credential, so it
 * is the part that is taken out. The rest of the message is kept, because it
 * is what tells the customer what went wrong.
 */
export function redactResumableCredentials(text: string): string {
  return text.replace(/(upload_id=)[^&\s"'<>]+/gi, "$1***");
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const UPLOAD_ID_PATTERN = /(upload_id=)[^\s&"'<>)\]]+/gi;
const UPLOAD_TYPE_PATTERN = /(uploadType=)[^\s&"'<>)\]]+/gi;
const BEARER_PATTERN = /(bearer\s+)[^\s"'<>)\]]+/gi;
const TOKEN_FIELD_PATTERN =
  /(["']?(?:access_token|refresh_token|client_secret|api_key|token|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'<>,}]+)/gi;

/**
 * Removes credentials, session URLs and provider payloads from a string that
 * is about to be logged or stored.
 *
 * This is applied to exception messages and provider bodies, which are the two
 * places a resumable session URL can leak from: the provider echoes the
 * session URL in an error body, and a `fetch` failure carries the request URL
 * in its message.
 */
export function redactProviderText(value: unknown, maxLength = 500): string {
  const raw = typeof value === "string" ? value : value instanceof Error ? value.message : String(value ?? "");
  const redacted = raw.replace(URL_PATTERN, "[redacted-url]")
    .replace(UPLOAD_ID_PATTERN, "$1[redacted]")
    .replace(UPLOAD_TYPE_PATTERN, "$1[redacted]")
    .replace(BEARER_PATTERN, "$1[redacted]")
    .replace(TOKEN_FIELD_PATTERN, (match, field: string) => {
      const valueStart = match[field.length];
      const quote = valueStart === '"' || valueStart === "'" ? valueStart : "";
      return `${field}${quote}[redacted]${quote}`;
    });
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

/** Rebase only a signed Storage URL minted against this stack's internal origin. */
export function youtubeStorageReadUrl(
  value: string,
  internalBase = Deno.env.get("SUPABASE_URL") ?? "",
  publicBase = publicSupabaseUrl(),
): string {
  try {
    const source = new URL(value);
    const internal = new URL(internalBase);
    const target = new URL(publicBase);
    if (source.origin !== internal.origin || source.username || source.password ||
        !source.pathname.startsWith("/storage/v1/object/sign/") ||
        target.protocol !== "https:" || target.username || target.password) return value;
    return `${target.origin}${source.pathname}${source.search}`;
  } catch {
    return value;
  }
}

/**
 * Hosts Postora is willing to read a media file from.
 *
 * The list is built from the running configuration rather than hard-coded, so
 * a deployment that moves its storage or CDN keeps working. The storage host
 * comes from the public Supabase origin; the CDN origin comes from the admin-configured
 * `cdn_storage` setting.
 */
export function approvedMediaHosts(args: {
  supabaseUrl?: string | null;
  cdnOrigins?: Array<string | null | undefined>;
}): Set<string> {
  const hosts = new Set<string>();

  const addFromUrl = (value: string | null | undefined) => {
    if (typeof value !== "string" || value.trim().length === 0) return;
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== "https:") return;
      hosts.add(parsed.host.toLowerCase());
    } catch {
      // A malformed origin is not an origin.
    }
  };

  addFromUrl(args.supabaseUrl);
  for (const origin of args.cdnOrigins ?? []) addFromUrl(origin);

  // Cloudinary serves every delivery URL from one host.
  hosts.add("res.cloudinary.com");

  return hosts;
}

/**
 * Whether a media URL may be fetched.
 *
 * The check runs before any network I/O, so an unapproved host never receives
 * a request. Only HTTPS is allowed: a plain HTTP read could be redirected
 * into the private network from outside.
 */
export function isApprovedMediaUrl(url: string, hosts: Set<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  return hosts.has(parsed.host.toLowerCase());
}
