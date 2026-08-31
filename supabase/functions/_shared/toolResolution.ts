// Which connectors one conversation may call, and what happens when two of
// them claim the same function name.
//
// ai-agent-reply loads tools under the service role, so RLS is not evaluated
// and tenancy has to be structural: the caller scopes both queries by user_id,
// and this module then narrows that set to the ONE account the conversation
// belongs to. Until PR-5 that narrowing did not exist -- every tool the user
// owned was offered to every account's agent, so one login's Facebook page
// answered customers out of another page's store.
//
// Kept pure and dependency-free so the rule can be tested without an Edge
// Runtime, the same shape as knowledgeVisibility.ts on the retrieval side.

export interface ResolvableTool {
  id: string;
  name: string;
  description: string;
  url: string;
  secret: string | null;
  admin_only: boolean;
  scope: "account" | "all_accounts";
  social_account_id: string | null;
  connector_type: string;
}

export interface ToolAccountLink {
  tool_id: string;
  social_account_id: string;
}

export interface DroppedDuplicate {
  name: string;
  kept_tool_id: string;
  dropped_tool_id: string;
}

export interface ToolResolution {
  tools: ResolvableTool[];
  droppedDuplicates: DroppedDuplicate[];
}

// How specific a claim on this account is. A collision resolves in favour of
// the higher number, which is the same ordering scope='account' already
// encodes against 'all_accounts': the more deliberate configuration wins.
const OWNED = 2;
const LINKED = 1;
const INHERITED = 0;

function specificity(
  tool: ResolvableTool,
  linkedToolIds: Set<string>,
  accountId: string | null,
): number | null {
  if (accountId && tool.social_account_id === accountId) return OWNED;
  if (linkedToolIds.has(tool.id)) return LINKED;
  if (tool.scope === "all_accounts") return INHERITED;
  return null;
}

/**
 * The connectors this account may call, with name collisions resolved.
 *
 * `accountId` may be null, or an id that matches nothing — the sandbox passes
 * the literal "test" when a caller names no account. Both degrade to the
 * all_accounts corpus rather than throwing: an exception here would kill a
 * reply to a real customer over a tool list.
 *
 * Only links already filtered to this account should be passed in; the caller
 * scopes that query by user_id, which is the structural tenancy check that
 * replaces RLS under the service role.
 */
export function resolveToolsForAccount(
  tools: ResolvableTool[],
  links: ToolAccountLink[],
  accountId: string | null,
): ToolResolution {
  const linkedToolIds = new Set(
    links
      .filter((link) => accountId !== null && link.social_account_id === accountId)
      .map((link) => link.tool_id),
  );

  const visible: Array<{ tool: ResolvableTool; rank: number }> = [];
  for (const tool of tools) {
    const rank = specificity(tool, linkedToolIds, accountId);
    if (rank !== null) visible.push({ tool, rank });
  }

  // Sorted before the collision pass so the winner does not depend on the order
  // the database happened to return, and so two identical calls build the same
  // tools array -- it is part of the prompt, and churn there defeats caching.
  visible.sort((a, b) => (a.tool.name === b.tool.name
    ? b.rank - a.rank || a.tool.id.localeCompare(b.tool.id)
    : a.tool.name.localeCompare(b.tool.name)));

  const byName = new Map<string, ResolvableTool>();
  const droppedDuplicates: DroppedDuplicate[] = [];
  for (const { tool } of visible) {
    const kept = byName.get(tool.name);
    if (!kept) {
      byName.set(tool.name, tool);
      continue;
    }
    // §12.3 layer 2. The write-time refusal in set_ai_agent_tool_accounts
    // cannot cover a rename that happens after the link exists, so the loser is
    // dropped HERE rather than handed to the model. Two functions sharing one
    // name is behaviour no provider defines, and the Map this replaces silently
    // kept whichever row came last.
    droppedDuplicates.push({
      name: tool.name,
      kept_tool_id: kept.id,
      dropped_tool_id: tool.id,
    });
  }

  return { tools: [...byName.values()], droppedDuplicates };
}
