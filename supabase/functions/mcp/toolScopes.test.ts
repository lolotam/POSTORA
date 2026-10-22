import { assertEquals } from "jsr:@std/assert@1";
import {
  argumentScopes,
  missingScope,
  TOOL_SCOPES,
  NOT_YET_GRANTABLE_SCOPES,
  UNCLASSIFIED_TOOL,
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

// Every tool name index.ts registers. A tool name may carry digits, so the
// pattern holds them too.
function registeredTools(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/register\("([a-z0-9_]+)"/g)].map((match) => match[1]),
    ),
  ];
}

// The scopes a tool needs. A tool mapped to an array needs ALL of them.
function scopesFor(tool: string): string[] {
  const required: string | readonly string[] | undefined = TOOL_SCOPES[tool];
  if (required === undefined) return [];
  return typeof required === "string" ? [required] : [...required];
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

  for (const tool of Object.keys(TOOL_SCOPES)) {
    const scopes = scopesFor(tool);
    assertEquals(scopes.length > 0, true, tool);
    // A tool that needs several scopes is refused for the first one it is
    // missing.
    assertEquals(missingScope(grant, tool), scopes[0], tool);
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
  const toolScopes = new Set(
    Object.keys(TOOL_SCOPES).flatMap((tool) => scopesFor(tool)),
  );

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
    // The tool's own block: from its register(...) call to the next one, or
    // to the end of the source when it is the last tool. The scope check
    // only counts when it sits in this block, not somewhere else in the file.
    const start = source.indexOf(`register("${tool}",`);
    assertEquals(start !== -1, true, `${tool}: it has no register(...) call`);
    const nextRegister = source.indexOf('register("', start + 1);
    const block = source.slice(
      start,
      nextRegister === -1 ? source.length : nextRegister,
    );

    // The check has to be in the tool's own handler. A tool whose scope
    // depends on its arguments passes them on, so the check may end in
    // `grant })` or in `grant, args })`.
    const handlerAt = block.indexOf("handler: async");
    assertEquals(handlerAt !== -1, true, `${tool}: it has no handler`);
    const rest = block.slice(handlerAt);

    const checks = [
      `refuseUngranted({ admin }, { userId: ownerId, tool: "${tool}", grant })`,
      `refuseUngranted({ admin }, { userId: ownerId, tool: "${tool}", grant, args })`,
    ];
    const checkAt = Math.min(
      ...checks.map((check) => {
        const at = rest.indexOf(check);
        return at === -1 ? Number.MAX_SAFE_INTEGER : at;
      }),
    );
    assertEquals(
      checkAt !== Number.MAX_SAFE_INTEGER,
      true,
      `${tool}: its handler does not check the scope`,
    );

    // And it has to come first: before the tool calls the API, and before
    // the confirmation check.
    const workAt = rest.indexOf("callN8n(");
    if (workAt !== -1) {
      assertEquals(
        checkAt < workAt,
        true,
        `${tool}: it checks the scope after it calls the API`,
      );
    }

    const confirmAt = rest.indexOf("refuseUnconfirmed(");
    if (confirmAt !== -1) {
      assertEquals(
        checkAt < confirmAt,
        true,
        `${tool}: it checks the scope after the confirmation check`,
      );
    }

    // And the check has to be ENFORCED: the refusal has to end the call
    // before the tool does anything else. Calling the check is not enough:
    // a check whose result is ignored lets the tool run anyway.
    //
    // The text that follows the check's own statement: from the end of the
    // line the check sits on.
    const afterCheck = rest.slice(checkAt);
    const statementEnd = afterCheck.indexOf("\n");
    assertEquals(
      statementEnd !== -1,
      true,
      `${tool}: its scope check is not a statement of its own`,
    );
    const afterStatement = afterCheck.slice(statementEnd + 1).trimStart();
    assertEquals(
      afterStatement.startsWith("if (scopeRefusal) return fail(403, scopeRefusal);"),
      true,
      `${tool}: it does not return the scope refusal`,
    );
  }
});

Deno.test("a token holding the default scopes can run every tool except the not-yet-grantable ones", () => {
  const grant = granted(...DEFAULT_SCOPES);

  for (const tool of Object.keys(TOOL_SCOPES)) {
    // A tool that needs a scope that cannot be granted yet is refused. A
    // tool that needs several scopes is refused only when one of them is
    // missing, so generate_image runs on the default grant: it holds both
    // posts:write and media:write.
    const blocked = scopesFor(tool).some((scope) =>
      NOT_YET_GRANTABLE_SCOPES.has(scope)
    );
    if (blocked) continue;
    assertEquals(missingScope(grant, tool), null, tool);
  }
});

Deno.test("generate_image needs media:write as well as posts:write", () => {
  const grant = granted("posts:write");

  // The image is saved to the media library, so posts:write alone is not
  // enough: the grant is missing media:write.
  assertEquals(missingScope(grant, "generate_image"), "media:write");
});

Deno.test("a grant that holds both of generate_image's scopes may run it", () => {
  const grant = granted("posts:write", "media:write");

  assertEquals(missingScope(grant, "generate_image"), null);
});

Deno.test("create_post needs only posts:write when it carries no media", () => {
  const grant = granted("posts:write");

  // A text-only post writes no media, so it needs no media:write.
  assertEquals(missingScope(grant, "create_post", { caption: "hi" }), null);

  // media_file_ids reuses files that are already in the media library, so
  // it writes nothing there either.
  assertEquals(missingScope(grant, "create_post", { media_file_ids: ["x"] }), null);
});

Deno.test("create_post needs media:write when it carries media to upload", () => {
  const grant = granted("posts:write");

  // The media lands in the media library, so posts:write alone is not
  // enough: the grant is missing media:write.
  assertEquals(
    missingScope(grant, "create_post", { media_urls: ["https://a"] }),
    "media:write",
  );

  // A list field may arrive as text instead of as an array.
  assertEquals(
    missingScope(grant, "create_post", { media_urls: "https://a" }),
    "media:write",
  );

  assertEquals(
    missingScope(grant, "create_post", { media_base64: ["abc"] }),
    "media:write",
  );
});

Deno.test("create_post needs no media:write when its media list is empty", () => {
  const grant = granted("posts:write");

  // An empty list uploads nothing, so there is no media write to gate.
  assertEquals(missingScope(grant, "create_post", { media_urls: [] }), null);
  assertEquals(missingScope(grant, "create_post", { media_urls: "  " }), null);
});

Deno.test("create_post needs media:write when it carries a single media_url", () => {
  const grant = granted("posts:write");

  // The API accepts a single media_url as well as a list of media_urls, and
  // it uploads either one inline, so it writes to the media library exactly
  // like media_urls does: posts:write alone is not enough.
  assertEquals(
    missingScope(grant, "create_post", { media_url: "https://a" }),
    "media:write",
  );

  // An empty media_url carries nothing, so there is no media write to gate.
  assertEquals(missingScope(grant, "create_post", { media_url: "" }), null);
});

Deno.test("create_post needs webhooks:manage when it carries a webhook_url", () => {
  // A webhook_url registers a callback that receives the post's results,
  // and that is webhook management.
  const grant = granted("posts:write", "media:write");
  assertEquals(
    missingScope(grant, "create_post", { webhook_url: "https://hook" }),
    "webhooks:manage",
  );

  const all = granted("posts:write", "media:write", "webhooks:manage");
  assertEquals(
    missingScope(all, "create_post", { webhook_url: "https://hook" }),
    null,
  );
});

Deno.test("an API-key grant runs create_post whatever its arguments carry", () => {
  assertEquals(missingScope(ALL, "create_post", { caption: "hi" }), null);
  assertEquals(missingScope(ALL, "create_post", { media_urls: ["https://a"] }), null);
  assertEquals(missingScope(ALL, "create_post", { webhook_url: "https://hook" }), null);
});

Deno.test("only create_post has scopes that depend on its arguments", () => {
  assertEquals(argumentScopes("list_posts", { media_urls: ["x"] }), []);
  assertEquals(argumentScopes("create_post", { media_urls: ["https://a"] }), ["media:write"]);
  assertEquals(
    argumentScopes("create_post", {
      media_urls: ["https://a"],
      webhook_url: "https://hook",
    }),
    ["media:write", "webhooks:manage"],
  );
});

Deno.test("a tool nobody classified is refused with the unclassified sentinel", () => {
  const grant = granted("posts:read");

  assertEquals(missingScope(grant, "not_a_registered_tool"), UNCLASSIFIED_TOOL);
  assertEquals(missingScope(ALL, "not_a_registered_tool"), null);
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
