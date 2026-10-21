// The MCP endpoints Postora serves, and the OAuth protected-resource
// metadata that describes each of them.
//
// The same MCP server is mounted under three paths, and what a connection
// may do is decided by the path it was configured with:
//
//   /mcp       -> "full":  every tool except the ones that return other
//                          people's text
//   /mcp/read  -> "read":  the owner's own reads plus the tools that return
//                          other people's text
//   /mcp/inbox -> "inbox": list_comments, reply_to_comment and hide_comment:
//                          public material only
//
// Every endpoint therefore needs its own protected-resource metadata
// document: a client that was configured with /mcp/read must discover a
// `resource` that is /mcp/read, and a client that requires the advertised
// resource to equal the URL it holds aborts discovery otherwise. One
// document for all three endpoints would advertise /mcp to a client that
// was configured with /mcp/read, and the discovery would fail.
//
// This module is shared by the two functions that have to agree on the
// mapping: the `mcp` function names the metadata URL of the endpoint that
// was called, and the `mcp-oauth` function serves the documents
// themselves. A shared module is where that agreement belongs (ARCHITECTURE
// section 40): the code is used by two functions and carries no policy of
// its own.

export const MCP_ENDPOINTS = {
  full: "/mcp",
  read: "/mcp/read",
  inbox: "/mcp/inbox",
} as const;

export type McpEndpoint = keyof typeof MCP_ENDPOINTS;

export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * The metadata path (relative to the mcp-oauth function) that describes an
 * endpoint.
 *
 * The full endpoint keeps the document it always had, at the bare metadata
 * path. The other two are described by a document under it, named after the
 * endpoint, so no two endpoints can ever be described by the same document.
 */
export function metadataPathFor(endpoint: McpEndpoint): string {
  if (endpoint === "full") return PROTECTED_RESOURCE_METADATA_PATH;
  return `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_ENDPOINTS[endpoint]}`;
}

/**
 * The endpoint a metadata path describes, or null when it describes none.
 *
 * The match is exact: a path that merely starts with a metadata path
 * describes no endpoint, so a request for a document that does not exist
 * cannot be answered with the document of another endpoint.
 */
export function endpointForMetadataPath(path: string): McpEndpoint | null {
  for (const endpoint of Object.keys(MCP_ENDPOINTS) as McpEndpoint[]) {
    if (metadataPathFor(endpoint) === path) return endpoint;
  }
  return null;
}
