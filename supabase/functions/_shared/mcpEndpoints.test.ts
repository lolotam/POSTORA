import { assertEquals } from "jsr:@std/assert@1";
import {
  endpointForMetadataPath,
  MCP_ENDPOINTS,
  metadataPathFor,
  PROTECTED_RESOURCE_METADATA_PATH,
  type McpEndpoint,
} from "./mcpEndpoints.ts";

const ENDPOINTS = Object.keys(MCP_ENDPOINTS) as McpEndpoint[];

Deno.test("every endpoint round-trips through its metadata path", () => {
  for (const endpoint of ENDPOINTS) {
    assertEquals(
      endpointForMetadataPath(metadataPathFor(endpoint)),
      endpoint,
      endpoint,
    );
  }

  // The full endpoint keeps the document it always had: the bare metadata
  // path, which is also the static file on the app origin.
  assertEquals(metadataPathFor("full"), "/.well-known/oauth-protected-resource");
  assertEquals(
    PROTECTED_RESOURCE_METADATA_PATH,
    "/.well-known/oauth-protected-resource",
  );
});

Deno.test("a metadata path that describes no endpoint maps to none", () => {
  const paths = [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/mcp/reader",
    "/.well-known/oauth-protected-resource/",
    "/.well-known/oauth-authorization-server",
    "",
  ];

  for (const path of paths) {
    assertEquals(endpointForMetadataPath(path), null, path);
  }
});
