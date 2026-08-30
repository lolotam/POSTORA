// Which accounts a knowledge source is shared with, and what a single checkbox
// toggle should write.
//
// The database already models this: a source is readable by an account when
// `visibility = 'shared'` OR an ai_knowledge_source_accounts row links them
// (migration 20260828180000). set_ai_knowledge_source_visibility REPLACES the
// whole link set in one transaction, so every toggle has to send the complete
// desired set -- not a delta. Getting that wrong strips a source from every
// other agent, which is why the decision lives here, pure and tested, rather
// than inline in the component.
//
// The companion predicate in knowledgeVisibility.ts answers "can this account
// read it"; this module answers "who can, and what changes when the user
// clicks". They must stay consistent: shared means every account there too.

import type { SourceAccountLink, VisibilityScopedSource } from "./knowledgeVisibility";

// The platforms that actually run an agent -- the same list as AiAgentPlatform
// in useAiAgentConfig. A TikTok or Pinterest account has no inbox and no agent,
// so a checkbox for it would promise retrieval that can never happen.
export const AGENT_SHARING_PLATFORMS = [
  "whatsapp",
  "facebook",
  "instagram",
  "threads",
] as const;

export interface SharingAccount {
  id: string;
  platform: string;
  platform_username: string | null;
  platform_user_id: string | null;
}

export function agentAccounts(accounts: SharingAccount[]): SharingAccount[] {
  return accounts.filter((account) =>
    (AGENT_SHARING_PLATFORMS as readonly string[]).includes(account.platform),
  );
}

/**
 * The accounts that can read this source today, expressed as ids the checkbox
 * strip can compare against.
 *
 * A shared source holds NO link rows, so its set is materialised from the agent
 * accounts. Reading the link table literally would render every box unchecked
 * for a source every agent can in fact read.
 *
 * Links pointing at an account with no agent are dropped. Such a link is not
 * removable from a strip that cannot draw it, and counting it would make a
 * fully-checked strip look partial.
 *
 * Returned in `accounts` order so a caller can compare two results directly.
 */
export function effectiveAccountIds(
  source: VisibilityScopedSource,
  accounts: SharingAccount[],
  links: SourceAccountLink[],
): string[] {
  const eligible = agentAccounts(accounts);
  if (source.visibility === "shared") return eligible.map((account) => account.id);
  const linked = new Set(
    links.filter((link) => link.source_id === source.id).map((link) => link.social_account_id),
  );
  return eligible.filter((account) => linked.has(account.id)).map((account) => account.id);
}

export interface SharingWrite {
  visibility: "restricted";
  social_account_ids: string[];
}

/**
 * What to send after one checkbox changes.
 *
 * Always 'restricted', never 'shared' -- including when the toggle happens to
 * leave every current account checked. 'shared' also covers accounts connected
 * LATER, and silently re-granting that from a checkbox would hand a brand
 * connected next month a document nobody chose to give it. An explicit link set
 * says exactly who was chosen; the strip renders identically either way.
 *
 * An empty result is legal and means the source is readable by no agent. The
 * RPC accepts it deliberately: it is how a source is retired without deleting
 * its chunks.
 */
export function nextSharing({
  source,
  accounts,
  links,
  accountId,
  checked,
}: {
  source: VisibilityScopedSource;
  accounts: SharingAccount[];
  links: SourceAccountLink[];
  accountId: string;
  checked: boolean;
}): SharingWrite {
  const current = new Set(effectiveAccountIds(source, accounts, links));
  if (checked) current.add(accountId);
  else current.delete(accountId);
  return {
    visibility: "restricted",
    social_account_ids: agentAccounts(accounts)
      .map((account) => account.id)
      .filter((id) => current.has(id)),
  };
}

/** Label for one account's checkbox: the handle if there is one, else its id. */
export function accountLabel(account: SharingAccount): string {
  return account.platform_username || account.platform_user_id || account.id;
}
