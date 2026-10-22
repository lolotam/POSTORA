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
// A tool may also need a scope only for SOME of the calls made to it.
// create_post always writes a post, so it always needs posts:write, and it
// always needs media:write as well: its schema is .passthrough(), so it can
// upload media inline through several fields, and a deny-list over open input
// lets every field it does not name slip through. The media scope is required
// for every call (fail closed) and is not guessed from field names. A
// webhook_url registers a callback that receives the post's results, and that
// is webhooks:manage. The webhook check fails closed as well: the n8n-api
// create-post handler stores whatever webhook_url it is given, so any carried
// value needs the scope, not only a string that looks like a URL.
// argumentScopes names the scopes a call needs because of its arguments, so
// what a call needs depends on what the call carries.
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
  // create_post always needs posts:write AND media:write: it can upload
  // media inline through several fields of a passthrough schema, so the
  // media scope is required for every call (fail closed) and is not guessed
  // from field names. Only the webhook part depends on the arguments the
  // call carries, and it fails closed on any webhook_url the call carries.
  // See argumentScopes.
  create_post: ["posts:write", "media:write"],
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
 * Whether a webhook_url carries anything that registers a callback.
 *
 * The n8n-api create-post handler stores whatever webhook_url it is handed:
 * `if (webhook_url) { metadata.webhook_url = webhook_url; }`, so a truthy
 * array or object registers a callback exactly as a string does. The check
 * therefore fails closed and asks for the scope for every carried value.
 *
 * Only the values that carry nothing at all are left out: nothing there
 * (undefined), null, false, 0, and a string that is empty after trimming.
 */
function carriesWebhookUrl(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) {
    return false;
  }
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/**
 * The extra scopes a call needs because of its arguments.
 *
 * A tool may need a scope only for some of the calls made to it:
 *
 * - create_post needs webhooks:manage when it carries a webhook_url: that
 *   registers a callback which receives the post's results, and registering
 *   a callback is webhook management. The n8n-api create-post handler reads
 *   only webhook_url for callbacks, and it stores whatever webhook_url it is
 *   given, so the check fails closed on any carried value: an array or an
 *   object registers a callback as well as a string does.
 *
 * The media scope create_post needs is NOT decided here. Its schema is
 * .passthrough(), so it can upload media inline through several fields, and a
 * deny-list over open input lets every upload field it does not name slip
 * through. The media scope is therefore required for every call and lives in
 * TOOL_SCOPES.
 *
 * The arguments are untrusted input, so they are read defensively: arguments
 * that are not an object carry nothing at all.
 *
 * Any other tool needs no extra scope today.
 */
export function argumentScopes(tool: string, args: unknown): string[] {
  if (tool !== "create_post") return [];
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];

  const call = args as Record<string, unknown>;
  const scopes: string[] = [];

  // A webhook_url registers a callback that receives the post's results, and
  // the n8n-api create-post handler stores whatever webhook_url it is given,
  // whatever its type. The check therefore fails closed: any carried value
  // needs the scope, and only a value that carries nothing at all does not.
  const webhookUrl = call.webhook_url;
  if (carriesWebhookUrl(webhookUrl)) {
    scopes.push("webhooks:manage");
  }

  return scopes;
}

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
 *
 * The scopes the table names are checked first and the scopes the arguments
 * call for (see argumentScopes) after them: the table says what the tool
 * always needs, and the arguments say what this call adds on top of that.
 * Arguments that are not passed are not read, so a call whose arguments were
 * not handed over is judged on the table alone.
 */
export function missingScope(
  grant: ScopeGrant,
  tool: string,
  args?: unknown,
): string | null {
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

  // The scopes this call needs because of the arguments it carries.
  for (const scope of argumentScopes(tool, args)) {
    if (!grant.scopes.has(scope)) return scope;
  }

  return null;
}
