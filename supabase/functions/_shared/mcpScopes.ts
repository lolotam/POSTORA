// The scopes that are advertised but cannot be granted yet.
//
// The authorization server metadata names them, so a client may ask for them,
// but no token can be granted them until the consent screen that could show
// them ships after the frontend freeze. mcp-oauth strips them at /authorize,
// and the MCP tools that need them answer 403 over OAuth until then.
//
// Both functions import this one set, so the two deployed functions cannot
// drift apart.

export const NOT_YET_GRANTABLE_SCOPES: ReadonlySet<string> = new Set([
  "comments:read",
  "messages:read",
  "comments:write",
  "messages:write",
]);
