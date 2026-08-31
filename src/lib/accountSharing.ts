// Which accounts a shared thing reaches, and what one checkbox toggle should
// write — the generalised core of knowledgeSharing.ts.
//
// Two features use this module:
//   - knowledge sources (visibility shared/restricted + link rows), through
//     knowledgeSharing.ts, whose tests pin that delegation to identical
//     behaviour;
//   - AI agent connectors (scope account/all_accounts + ai_agent_tool_accounts
//     link rows), which add ONE difference: an owning account that is always
//     on. That difference is the `alwaysOnAccountId` parameter — not a fork.
//
// The write rule both features share: the server RPC REPLACES the whole link
// set in one transaction, so every toggle must send the complete desired list.
// A delta strips the entity from every other agent, which is why the decision
// lives here, pure and tested, rather than inline in a component.
//
// The always-on asymmetry (spec §12.2): the owning account resolves through
// ai_agent_tools.social_account_id, so it is always in the EFFECTIVE set —
// even with no link row — and never in the WRITTEN one. A link row for the
// owner would be a second, silently divergent source of one fact: the day the
// connector changed owners, a stale link would keep granting the old account.

// The platforms that actually run an agent -- the same list as AiAgentPlatform
// in useAiAgentConfig. A TikTok or Pinterest account has no inbox and no agent,
// so a checkbox for it would promise retrieval that can never happen.
const AGENT_SHARING_PLATFORMS = [
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

/** Label for one account's checkbox: the handle if there is one, else its id. */
export function accountLabel(account: SharingAccount): string {
  return account.platform_username || account.platform_user_id || account.id;
}

/**
 * The accounts that can reach this entity today, as checkbox-comparable ids.
 *
 * `allAccounts` is the "everyone, including accounts connected later" state;
 * such an entity holds NO link rows, so its set is materialised from the agent
 * accounts instead of read literally from the link table.
 *
 * Links pointing at an account with no agent are dropped: a link the strip
 * cannot draw is not removable from it, and counting it would make a
 * fully-checked strip look partial.
 *
 * `alwaysOnAccountId` (connectors) is added even when no link row names it.
 * Returned in `accounts` order so a caller can compare two results directly.
 */
export function effectiveSharingIds({
  entityId,
  allAccounts,
  linkedAccountIds,
  accounts,
  alwaysOnAccountId = null,
}: {
  entityId: string;
  allAccounts: boolean;
  /** every link id for this entity; filtering to THIS entity is the caller's
   *  choice of link shape, so the core stays shape-agnostic. */
  linkedAccountIds: string[];
  accounts: SharingAccount[];
  alwaysOnAccountId?: string | null;
}): string[] {
  const eligible = agentAccounts(accounts);
  if (allAccounts) return eligible.map((account) => account.id);
  // A membership set, then one pass in `accounts` order, so the always-on id
  // sits where its account sits rather than wherever it was inserted. An
  // owner outside the eligible list (impossible from the UI, which only
  // offers agent accounts) is still appended rather than dropped -- "always
  // on" is the invariant this parameter exists to keep.
  const linked = new Set(linkedAccountIds);
  const members = new Set(
    eligible.filter((account) => linked.has(account.id)).map((account) => account.id),
  );
  if (alwaysOnAccountId) members.add(alwaysOnAccountId);
  const ids = eligible.filter((account) => members.has(account.id)).map((account) => account.id);
  if (alwaysOnAccountId && !ids.includes(alwaysOnAccountId)) ids.push(alwaysOnAccountId);
  return ids;
}

/**
 * The complete id list to write after one checkbox changes — never a delta.
 *
 * Without `alwaysOnAccountId` the result is exactly the next effective set
 * (knowledge sources). With it (connectors), the owner is excluded: it
 * resolves through its own column, and a link for it would diverge from that
 * fact. An empty result is legal in both features; for connectors it means
 * "the owner only", which no strip can strand because the owner has no
 * checkbox to lose.
 */
export function nextSharedAccountIds({
  entityId,
  allAccounts,
  linkedAccountIds,
  accounts,
  accountId,
  checked,
  alwaysOnAccountId = null,
}: {
  entityId: string;
  allAccounts: boolean;
  linkedAccountIds: string[];
  accounts: SharingAccount[];
  accountId: string;
  checked: boolean;
  alwaysOnAccountId?: string | null;
}): string[] {
  const current = new Set(
    effectiveSharingIds({ entityId, allAccounts, linkedAccountIds, accounts, alwaysOnAccountId }),
  );
  if (checked) current.add(accountId);
  else current.delete(accountId);
  return agentAccounts(accounts)
    .map((account) => account.id)
    .filter((id) => current.has(id) && id !== alwaysOnAccountId);
}

/** Link shape for ai_agent_tool_accounts. */
export interface ToolAccountLink {
  tool_id: string;
  social_account_id: string;
}

/** The account-scoped half of an ai_agent_tools row the sharing model needs. */
export interface ScopedTool {
  id: string;
  scope: "account" | "all_accounts";
  social_account_id: string | null;
}

function toolLinkIds(toolId: string, links: ToolAccountLink[]): string[] {
  return links.filter((link) => link.tool_id === toolId).map((link) => link.social_account_id);
}

/** The accounts whose agents can use this connector: the owner, plus explicit
 *  shares, or every account when scope is 'all_accounts'. */
export function effectiveToolAccountIds(
  tool: ScopedTool,
  accounts: SharingAccount[],
  links: ToolAccountLink[],
): string[] {
  return effectiveSharingIds({
    entityId: tool.id,
    allAccounts: tool.scope === "all_accounts",
    linkedAccountIds: toolLinkIds(tool.id, links),
    accounts,
    alwaysOnAccountId: tool.social_account_id,
  });
}

/**
 * What set_tool_accounts should receive after one sharing checkbox changes:
 * the complete link list, owner excluded. Note this only edits links — a
 * scope='all_accounts' connector resolves for everyone regardless of links,
 * so callers must not offer a live strip for one.
 */
export function nextToolSharing({
  tool,
  accounts,
  links,
  accountId,
  checked,
}: {
  tool: ScopedTool;
  accounts: SharingAccount[];
  links: ToolAccountLink[];
  accountId: string;
  checked: boolean;
}): string[] {
  return nextSharedAccountIds({
    entityId: tool.id,
    allAccounts: tool.scope === "all_accounts",
    linkedAccountIds: toolLinkIds(tool.id, links),
    accounts,
    accountId,
    checked,
    alwaysOnAccountId: tool.social_account_id,
  });
}
