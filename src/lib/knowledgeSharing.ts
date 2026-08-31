// Which accounts a knowledge source is shared with, and what a single checkbox
// toggle should write.
//
// The database already models this: a source is readable by an account when
// `visibility = 'shared'` OR an ai_knowledge_source_accounts row links them
// (migration 20260828180000). set_ai_knowledge_source_visibility REPLACES the
// whole link set in one transaction, so every toggle has to send the complete
// desired set -- not a delta. Getting that wrong strips a source from every
// other agent, which is why the decision lives in a pure, tested module rather
// than inline in the component.
//
// Since the connector sharing work (spec §12.2) the mechanics live in
// accountSharing.ts, shared with AI agent connectors; knowledgeSharing keeps
// the knowledge-flavoured signatures and delegates. knowledgeSharing.test.ts
// pins that delegation to the original behaviour -- if these wrappers drift,
// that file is what says so.
//
// The companion predicate in knowledgeVisibility.ts answers "can this account
// read it"; this module answers "who can, and what changes when the user
// clicks". They must stay consistent: shared means every account there too.

import type { SourceAccountLink, VisibilityScopedSource } from "./knowledgeVisibility";
import {
  accountLabel,
  agentAccounts,
  effectiveSharingIds,
  nextSharedAccountIds,
  type SharingAccount,
} from "./accountSharing";

export { accountLabel, agentAccounts, type SharingAccount } from "./accountSharing";

function sourceLinkIds(sourceId: string, links: SourceAccountLink[]): string[] {
  return links.filter((link) => link.source_id === sourceId).map((link) => link.social_account_id);
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
  return effectiveSharingIds({
    entityId: source.id,
    allAccounts: source.visibility === "shared",
    linkedAccountIds: sourceLinkIds(source.id, links),
    accounts,
  });
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
  return {
    visibility: "restricted",
    social_account_ids: nextSharedAccountIds({
      entityId: source.id,
      allAccounts: source.visibility === "shared",
      linkedAccountIds: sourceLinkIds(source.id, links),
      accounts,
      accountId,
      checked,
    }),
  };
}
