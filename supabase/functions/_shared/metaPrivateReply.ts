// The one genuinely new Meta capability behind Comment Workflow: a *private reply*, which
// answers a public comment with a direct message and so opens a DM thread with someone who
// never messaged first. Meta allows exactly ONE per comment, within 7 days of the comment, so
// callers must send once and never retry — a second attempt can only be refused, and the
// refusal is indistinguishable from a real failure.
//
// The host/id pair comes from getSendCredentials, the same resolution the ordinary DM path
// uses: a direct-login ("business_login") Instagram account sends as itself through
// graph.instagram.com, while a Page-backed Instagram account and a Facebook Page both send
// through the linked Page on graph.facebook.com. Stating that split here again is how the
// two would drift.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { callGraph, type CommentActionResult, failure } from "./commentActions.ts";
import { getSendCredentials, type SocialAccountForMessaging } from "./messengerCredentials.ts";

// The comment paths carry fewer columns than SocialAccountForMessaging demands (notably a
// nullable token), so this states the structural minimum and the token is narrowed below
// before the account is handed on. Widening a field on an `extends` would not type-check.
export interface PrivateReplyAccount {
  id: string;
  user_id: string;
  platform: string;
  access_token: string | null;
  platform_user_id?: string | null;
  platform_username?: string | null;
  ig_auth_type?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

function toMessagingAccount(account: PrivateReplyAccount, token: string): SocialAccountForMessaging {
  return {
    id: account.id,
    user_id: account.user_id,
    platform: account.platform,
    platform_user_id: String(account.platform_user_id || ""),
    platform_username: account.platform_username ?? null,
    ig_auth_type: account.ig_auth_type ?? null,
    account_metadata: account.account_metadata ?? null,
    access_token: token,
  };
}

export async function sendPrivateReply(
  admin: any,
  account: PrivateReplyAccount,
  commentId: string,
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<CommentActionResult> {
  const token = account.access_token;
  if (!token) {
    console.warn(JSON.stringify({
      event: "comment_workflow.private_reply_no_token",
      platform: account.platform,
      account_id: account.id,
      comment_id: commentId,
    }));
    return { success: false, error: "The account has no access token. Reconnect it in Profiles." };
  }

  let credentials: { graphBase: string; pageId: string; pageToken: string };
  try {
    credentials = await getSendCredentials(admin, toMessagingAccount(account, token));
  } catch (error) {
    // getSendCredentials throws NO_LINKED_PAGE_MATCH for a Page-backed Instagram account whose
    // Page is gone. That is a reconnect prompt, not an unreachable upstream, so it is reported
    // rather than swallowed — and logged, because a rule that silently never fires is the
    // failure mode this feature is most likely to hit in production.
    const message = (error as Error)?.message || "Could not resolve messaging credentials.";
    console.warn(JSON.stringify({
      event: "comment_workflow.private_reply_no_credentials",
      platform: account.platform,
      account_id: account.id,
      comment_id: commentId,
      error_code: message.split(":")[0],
    }));
    return { success: false, error: message };
  }

  const outcome = await callGraph(
    fetcher,
    `${credentials.graphBase}/${encodeURIComponent(credentials.pageId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text },
        access_token: credentials.pageToken,
      }),
    },
    "Meta rejected the private reply.",
  );

  if (!outcome.ok) {
    // The message text never reaches the log; only the platform's own complaint does.
    console.warn(JSON.stringify({
      event: "comment_workflow.private_reply_failed",
      platform: account.platform,
      account_id: account.id,
      comment_id: commentId,
      error: outcome.failure.error,
      upstream_unavailable: outcome.failure.upstreamUnavailable === true,
    }));
    return outcome.failure;
  }

  // Meta answers a private reply with { recipient_id, message_id }. A 200 carrying neither is
  // not a send — treating it as one is how a silent non-delivery gets recorded as `sent`.
  const messageId = outcome.data?.message_id ? String(outcome.data.message_id) : "";
  if (!messageId) return failure(outcome.data, "Meta accepted the private reply but returned no message id.");
  return { success: true, platform_comment_id: messageId };
}
