import { assertEquals } from "jsr:@std/assert@1";
import {
  missingScope,
  NEW_TOOL_SCOPES,
  NOT_YET_GRANTABLE_SCOPES,
  type ScopeGrant,
} from "./toolScopes.ts";

// The scopes the authorization server advertised before this change: the five
// an OAuth token can actually be granted today.
const OLD_SCOPES = [
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

Deno.test("an API-key grant holds every scope, so no tool is missing one", () => {
  for (const tool of Object.keys(NEW_TOOL_SCOPES)) {
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

Deno.test("a grant of the five old scopes still misses the comment and message scopes", () => {
  const grant = granted(...OLD_SCOPES);

  assertEquals(missingScope(grant, "hide_comment"), "comments:write");
  assertEquals(missingScope(grant, "reply_to_message"), "messages:write");
});

Deno.test("an older tool is not gated, so even an empty grant may run it", () => {
  assertEquals(missingScope(granted(), "create_post"), null);
  assertEquals(missingScope(granted(), "list_accounts"), null);
});

Deno.test("an empty grant misses the scope of every gated tool", () => {
  const grant = granted();

  assertEquals(missingScope(grant, "cancel_scheduled_post"), "posts:write");
  assertEquals(missingScope(grant, "retry_failed_post"), "posts:write");
  assertEquals(missingScope(grant, "delete_post"), "posts:write");
  assertEquals(missingScope(grant, "check_account_health"), "accounts:read");
  assertEquals(missingScope(grant, "suggest_best_times"), "posts:read");
  assertEquals(missingScope(grant, "reply_to_comment"), "comments:write");
});

Deno.test("a tool that does not exist is not gated", () => {
  assertEquals(missingScope(granted(), "no_such_tool"), null);
});

Deno.test("the comment and message scopes are advertised but cannot be granted yet", () => {
  assertEquals(NOT_YET_GRANTABLE_SCOPES.has("comments:write"), true);
  assertEquals(NOT_YET_GRANTABLE_SCOPES.has("messages:write"), true);
});

Deno.test("a scope that can be granted is not in the not-yet-grantable set", () => {
  for (const scope of OLD_SCOPES) {
    assertEquals(NOT_YET_GRANTABLE_SCOPES.has(scope), false, scope);
  }
});

Deno.test("every scope that cannot be granted yet is the scope of a gated tool", () => {
  const gatedScopes = new Set(Object.values(NEW_TOOL_SCOPES));

  for (const scope of NOT_YET_GRANTABLE_SCOPES) {
    assertEquals(gatedScopes.has(scope), true, scope);
  }
});
