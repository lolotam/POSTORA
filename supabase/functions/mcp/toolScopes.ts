// Which scope an MCP tool needs, and whether the caller's grant covers it.
//
// An API-key caller holds every scope: the key belongs to the owner and the
// owner may do everything the tools offer. An OAuth token holds only what it
// was granted at the consent screen, and a tool the token was not granted is
// refused before it runs.
//
// comments:write, messages:write, comments:read and messages:read are
// advertised in the authorization server metadata, but no token can be granted
// them yet: the consent screen that could show them ships after the frontend
// freeze. Over OAuth the comment and DM reads answer 403 until then, like the
// comment and DM writes.
// NOT_YET_GRANTABLE_SCOPES names them, so a refusal can tell the caller what
// to do instead of sending it to a reconnect that cannot produce the scope.
// The set itself lives in ../_shared/mcpScopes.ts, which the mcp-oauth
// function imports too, so the two deployed functions cannot drift apart.
//
// Enforcing scopes on every MCP tool is a separate follow-up. Only the tools
// listed in NEW_TOOL_SCOPES are gated here; the older tools are not gated in
// this change, and a tool that is not listed is never refused for a missing
// scope.

import { NOT_YET_GRANTABLE_SCOPES } from "../_shared/mcpScopes.ts";

export { NOT_YET_GRANTABLE_SCOPES };

/**
 * What the caller is allowed to do.
 *
 * - `{ kind: "all" }`: an API-key caller. It holds every scope.
 * - `{ kind: "granted", scopes }`: an OAuth token. It holds exactly the
 *   scopes it was granted.
 */
export type ScopeGrant =
  | { kind: "all" }
  | { kind: "granted"; scopes: ReadonlySet<string> };

// The scope each gated tool needs. A tool that is not listed here is not
// gated by scope in this change.
export const NEW_TOOL_SCOPES: Readonly<Record<string, string>> = {
  cancel_scheduled_post: "posts:write",
  reschedule_post: "posts:write",
  check_account_health: "accounts:read",
  suggest_best_times: "posts:read",
  get_media: "posts:read",
  reply_to_comment: "comments:write",
  hide_comment: "comments:write",
  delete_comment: "comments:write",
  reply_to_message: "messages:write",
  list_comments: "comments:read",
  list_messages: "messages:read",
};

/**
 * The scope the caller is missing for a tool, or null when the call may run.
 *
 * - an API-key grant holds every scope: null.
 * - a tool that is not gated: null.
 * - a tool that is gated and the grant holds its scope: null.
 * - a tool that is gated and the grant does not hold its scope: the scope
 *   that is missing, which is what the refusal names.
 */
export function missingScope(grant: ScopeGrant, tool: string): string | null {
  if (grant.kind === "all") return null;

  // The lookup is annotated, so a tool that is not in the table reads as
  // "no scope" instead of as a string that cannot be compared to undefined.
  const required: string | undefined = NEW_TOOL_SCOPES[tool];
  if (required === undefined) return null;

  if (grant.scopes.has(required)) return null;

  return required;
}
