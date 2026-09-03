import { isTokenExpired } from "@/lib/tokenUtils";
import { COMMENT_WORKFLOW_PLATFORMS, type CommentWorkflowPlatform } from "./rule";

/**
 * Which accounts a funnel may be bound to, and on which platform.
 *
 * A funnel acts through the account's stored token: it replies publicly and, on Meta, sends one
 * private message. An account flagged `needs_reauth` has no working token, so a funnel bound to
 * it would match comments and then fail every send — the worst outcome, because the pool would
 * show it as live. `useSocialAccounts` already filters `is_active` server-side; the flag is
 * checked here too so this predicate stands on its own wherever it is reused.
 */

/** The fields this module reads. Deliberately narrower than `SocialAccount`. */
export interface SelectableAccount {
  id: string;
  platform: string;
  platform_username: string | null;
  avatar_url: string | null;
  is_active: boolean;
  needs_reauth: boolean | null;
  token_expires_at: string | null;
}

/**
 * `is_active && !needs_reauth` is the test the partner-key picker applies
 * (`GeneratePartnerKeyDialog`), and expiry is checked alongside it because `needs_reauth` is set
 * by the health cron, not at the moment a token dies: between the two an account is unusable and
 * unflagged. A null expiry means the token does not expire (Facebook page tokens), and
 * `isTokenExpired` already reads it that way.
 */
export function isAccountConnected(account: SelectableAccount): boolean {
  return account.is_active && !account.needs_reauth && !isTokenExpired(account.token_expires_at);
}

/**
 * The accounts to offer for one platform.
 *
 * `keepId` is the account an existing funnel is already bound to. It stays in the list even once
 * it needs reconnecting, because a Select whose value matches no item renders blank — the rule
 * would look like it had lost its account rather than like the account had gone stale.
 */
export function connectedAccountsFor<T extends SelectableAccount>(
  accounts: readonly T[],
  platform: CommentWorkflowPlatform | "",
  keepId?: string | null,
): T[] {
  if (!platform) return [];
  return accounts.filter(
    (account) =>
      account.platform === platform && (isAccountConnected(account) || account.id === keepId),
  );
}

/** How many usable accounts each platform has, for the counts on the platform tiles. */
export function connectedCountByPlatform(
  accounts: readonly SelectableAccount[],
): Record<CommentWorkflowPlatform, number> {
  const counts = { facebook: 0, instagram: 0, threads: 0 };
  for (const account of accounts) {
    const platform = account.platform as CommentWorkflowPlatform;
    if (COMMENT_WORKFLOW_PLATFORMS.includes(platform) && isAccountConnected(account)) {
      counts[platform] += 1;
    }
  }
  return counts;
}

/**
 * How many accounts on this platform were left out for needing reconnection.
 *
 * Shown as a line under the picker: an account vanishing with no explanation reads as data loss,
 * and the fix — reconnect it on Profiles — is not guessable from an empty list.
 */
export function reconnectNeededCount(
  accounts: readonly SelectableAccount[],
  platform: CommentWorkflowPlatform | "",
  keepId?: string | null,
): number {
  if (!platform) return 0;
  // `keepId` is excluded for the same reason `connectedAccountsFor` keeps it: it is on screen,
  // so counting it as left out would contradict the list right above the line.
  return accounts.filter(
    (account) =>
      account.platform === platform && !isAccountConnected(account) && account.id !== keepId,
  ).length;
}

const ACCOUNT_NOUN: Record<CommentWorkflowPlatform, string> = {
  facebook: "page",
  instagram: "account",
  threads: "account",
};

/** Spelled out rather than assembled, so the article and the noun stay right together. */
const ACCOUNT_PLACEHOLDER: Record<CommentWorkflowPlatform, string> = {
  facebook: "Choose a Facebook page",
  instagram: "Choose an Instagram account",
  threads: "Choose a Threads account",
};

export function accountPlaceholder(platform: CommentWorkflowPlatform): string {
  return ACCOUNT_PLACEHOLDER[platform];
}

/** "page" / "pages" for the reconnect line, so Facebook does not read as "accounts". */
export function accountNoun(platform: CommentWorkflowPlatform, count: number): string {
  return count === 1 ? ACCOUNT_NOUN[platform] : `${ACCOUNT_NOUN[platform]}s`;
}
