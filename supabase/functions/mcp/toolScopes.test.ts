import { assertEquals } from "jsr:@std/assert@1";
import {
  missingScope,
  TOOL_SCOPES,
  NOT_YET_GRANTABLE_SCOPES,
  type ScopeGrant,
} from "./toolScopes.ts";

// The scopes a token is granted today: the five the authorization server
// offers by default, and the only ones an OAuth token can hold.
const DEFAULT_SCOPES = [
  "accounts:read",
  "posts:read",
  "posts:write",
  "media:write",
  "webhooks:manage",
];

function granted(...scopes: string[]): ScopeGrant {
  return { kind: "granted", scopes: new Set(scopes) };
}

const ALL: ScopeGrant = { kind: "all" };

// The source of index.ts, read from disk, so the scope table and the server
// that uses it cannot drift apart.
async function readIndexSource(): Promise<string> {
  return Deno.readTextFile(new URL("./index.ts", import.meta.url));
}

// Every tool name index.ts registers.
function registeredTools(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/register\("([a-z_]+)"/g)].map((match) => match[1]),
    ),
  ];
}

Deno.test("an API-key grant holds every scope, so no tool is missing one", () => {
  for (const tool of Object.keys(TOOL_SCOPES)) {
    assertEquals(missingScope(ALL, tool), null, tool);
  }
});

Deno.test("a granted posts:write covers cancel_scheduled_post but not get_media", () => {
  const grant = granted("posts:write");

  assertEquals(missingScope(grant, "cancel_scheduled_post"), null);
  assertEquals(missingScope(grant, "reschedule_post"), null);
  assertEquals(missingScope(grant, "retry_failed_post"), null);
  assertEquals(missingScope(grant, "delete_post"), null);
  assertEquals(missingScope(grant, "get_media"), "posts:read");
});

Deno.test("a grant of the five default scopes still misses the comment and message scopes", () => {
  const grant = granted(...DEFAULT_SCOPES);

  assertEquals(missingScope(grant, "hide_comment"), "comments:write");
  assertEquals(missingScope(grant, "reply_to_message"), "messages:write");
});

Deno.test("a token without the read scopes may not read comments or messages", () => {
  const grant = granted(...DEFAULT_SCOPES);

  assertEquals(missingScope(grant, "list_comments"), "comments:read");
  assertEquals(missingScope(grant, "list_messages"), "messages:read");

  assertEquals(missingScope(ALL, "list_comments"), null);
  assertEquals(missingScope(ALL, "list_messages"), null);
});

Deno.test("an older tool needs a scope too, so an empty grant may not run it", () => {
  assertEquals(missingScope(granted(), "create_post"), "posts:write");
  assertEquals(missingScope(granted(), "list_accounts"), "accounts:read");
});

Deno.test("an empty grant misses the scope of every tool", () => {
  const grant = granted();

  for (const [tool, scope] of Object.entries(TOOL_SCOPES)) {
    assertEquals(missingScope(grant, tool), scope, tool);
  }
});

Deno.test("a tool nobody classified is refused over OAuth", () => {
  assertEquals(missingScope(granted(), "no_such_tool"), "unclassified");
});

Deno.test("the comment and message scopes are advertised but cannot be granted yet", () => {
  assertEquals(NOT_YET_GRANTABLE_SCOPES.has("comments:write"), true);
  assertEquals(NOT_YET_GRANTABLE_SCOPES.has("messages:write"), true);
  assertEquals(NOT_YET_GRANTABLE_SCOPES.has("comments:read"), true);
  assertEquals(NOT_YET_GRANTABLE_SCOPES.has("messages:read"), true);
});

Deno.test("a scope that can be granted is not in the not-yet-grantable set", () => {
  for (const scope of DEFAULT_SCOPES) {
    assertEquals(NOT_YET_GRANTABLE_SCOPES.has(scope), false, scope);
  }
});

Deno.test("every scope that cannot be granted yet is the scope of a tool", () => {
  const toolScopes = new Set(Object.values(TOOL_SCOPES));

  for (const scope of NOT_YET_GRANTABLE_SCOPES) {
    assertEquals(toolScopes.has(scope), true, scope);
  }
});

Deno.test("every tool registered in index.ts has a scope", async () => {
  const registered = registeredTools(await readIndexSource());

  for (const tool of registered) {
    assertEquals(tool in TOOL_SCOPES, true, tool);
  }

  for (const tool of Object.keys(TOOL_SCOPES)) {
    assertEquals(registered.includes(tool), true, tool);
  }
});

Deno.test("every tool registered in index.ts checks its scope first", async () => {
  const source = await readIndexSource();

  for (const tool of registeredTools(source)) {
    const check = `refuseUngranted({ admin }, { userId: ownerId, tool: "${tool}", grant })`;
    assertEquals(source.includes(check), true, tool);
  }
});

Deno.test("a token holding the default scopes can run every tool except the not-yet-grantable ones", () => {
  const grant = granted(...DEFAULT_SCOPES);

  for (const [tool, scope] of Object.entries(TOOL_SCOPES)) {
    if (NOT_YET_GRANTABLE_SCOPES.has(scope)) continue;
    assertEquals(missingScope(grant, tool), null, tool);
  }
});

Deno.test("a token missing a scope is refused for the tools that need it", () => {
  const grant = granted("posts:read");

  assertEquals(missingScope(grant, "create_post"), "posts:write");
  assertEquals(missingScope(grant, "delete_webhook"), "webhooks:manage");
  assertEquals(missingScope(grant, "upload_media"), "media:write");
  assertEquals(missingScope(grant, "list_accounts"), "accounts:read");
  assertEquals(missingScope(grant, "list_posts"), null);
});

Deno.test("an unclassified tool is refused over OAuth and allowed for an API key", () => {
  const grant = granted("posts:read");

  assertEquals(missingScope(grant, "not_a_tool"), "unclassified");
  assertEquals(missingScope(ALL, "not_a_tool"), null);
});
