// Which scope an MCP tool needs, and whether the caller's grant covers it.
//
// An API-key caller holds every scope: the key belongs to the owner and the
// owner may do everything the tools offer. An OAuth token holds only what it
// was granted at the consent screen, and a tool the token was not granted is
// refused before it runs.
//
// Every tool needs a scope over OAuth. TOOL_SCOPES names the scope each tool
// needs, and a tool that is not in the table is refused as well: nobody
// classified it, so it may not run over OAuth. An API-key caller may still
// run it, because that key is the owner's own and the owner may do
// everything the tools offer.
//
// A tool may need more than one scope. generate_image spends AI quota AND
// writes the image to the media library, so it needs posts:write and
// media:write. An array in the table means the tool needs ALL of the scopes
// it names, and the refusal names the first one the grant does not hold.
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

// The sentinel a missing scope carries when the tool is not in the table at
// all. It is not a scope: no token can be granted it, and no reconnect can
// produce it, so a refusal that carries it may not tell the caller to
// reconnect.
export const UNCLASSIFIED_TOOL = "unclassified";

// The scope each tool needs. Every registered tool is in this table: a tool
// that is not is refused over OAuth instead of running ungated.
//
// A string is the one scope the tool needs. An array is every scope the tool
// needs: the tool may not run unless the grant holds all of them.
export const TOOL_SCOPES: Readonly<Record<string, string | readonly string[]>> = {
  list_accounts: "accounts:read",
  list_posts: "posts:read",
  get_post: "posts:read",
  create_post: "posts:write",
  upload_media: "media:write",
  list_webhooks: "webhooks:manage",
  register_webhook: "webhooks:manage",
  delete_webhook: "webhooks:manage",
  get_post_analytics: "posts:read",
  generate_caption: "posts:write",
  generate_hashtags: "posts:write",
  // It saves the image to the media library, so it needs media:write as well
  // as the posts:write its AI quota spends.
  generate_image: ["posts:write", "media:write"],
  cancel_scheduled_post: "posts:write",
  reschedule_post: "posts:write",
  retry_failed_post: "posts:write",
  delete_post: "posts:write",
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
 * - a tool that is not in the table: UNCLASSIFIED_TOOL, so a tool nobody
 *   classified is refused over OAuth instead of running ungated.
 * - a tool that is in the table and the grant holds every scope it needs:
 *   null.
 * - a tool that is in the table and the grant does not hold every scope it
 *   needs: the FIRST scope that is missing, which is what the refusal names.
 *   A tool that needs one scope behaves as it always did.
 */
export function missingScope(grant: ScopeGrant, tool: string): string | null {
  if (grant.kind === "all") return null;

  // The lookup is annotated, so a tool that is not in the table reads as
  // "no scope" instead of as a value that cannot be compared to undefined.
  const required: string | readonly string[] | undefined = TOOL_SCOPES[tool];
  if (required === undefined) return UNCLASSIFIED_TOOL;

  // A tool mapped to an array needs ALL of the scopes it names, so the first
  // one the grant does not hold is the one the refusal names.
  const scopes = typeof required === "string" ? [required] : required;
  for (const scope of scopes) {
    if (!grant.scopes.has(scope)) return scope;
  }

  return null;
}
