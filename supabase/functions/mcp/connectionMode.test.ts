import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  modeFromPath,
  toolAllowed,
  toolAnnotations,
  TOOL_POLICIES,
  type ConnectionMode,
} from "./connectionMode.ts";

const MODES: ConnectionMode[] = ["full", "read", "inbox"];

function kindOf(tool: string): string {
  return TOOL_POLICIES[tool].kind;
}

// The tools a connection in this mode is offered, the way buildServer in
// index.ts decides it.
function toolsForMode(mode: ConnectionMode): string[] {
  return Object.keys(TOOL_POLICIES).filter((tool) => toolAllowed(mode, tool));
}

Deno.test("each request path names its connection, or none", () => {
  const cases: [string, ConnectionMode | null][] = [
    ["/mcp", "full"],
    ["/functions/v1/mcp", "full"],
    ["/mcp/", "full"],
    ["/mcp/read", "read"],
    ["/mcp/read/", "read"],
    ["/mcp/inbox", "inbox"],
    ["/mcp/reader", null],
    ["/xmcp", null],
    ["/mcp/read/x", null],
    ["/functions/v1/mcp/read", "read"],
    ["/functions/v1/mcp/inbox/", "inbox"],
    ["/mcp/read/mcp", null],
    ["/functions/v1/mcp/read/mcp", null],
    ["/x/mcp/inbox", null],
    ["/v1/mcp", null],
    ["/", null],
    ["", null],
  ];

  for (const [path, expected] of cases) {
    assertEquals(modeFromPath(path), expected, path);
  }
});

Deno.test("a connection that reads other people's text never writes and never spends AI quota", () => {
  for (const mode of MODES) {
    const offered = toolsForMode(mode);
    const offersUntrusted = offered.some((tool) => kindOf(tool) === "untrusted_read");
    if (!offersUntrusted) continue;

    for (const tool of offered) {
      const kind = kindOf(tool);
      assertEquals(kind === "write" || kind === "ai", false, `${mode} offers ${tool}`);
    }
  }
});

Deno.test("the full connection does not offer the tools that return other people's text", () => {
  const offered = toolsForMode("full");

  assertEquals(offered.includes("list_comments"), false);
  assertEquals(offered.includes("list_messages"), false);
});

Deno.test("the full connection offers the publish, delete and AI tools", () => {
  const offered = toolsForMode("full");

  assertEquals(offered.includes("create_post"), true);
  assertEquals(offered.includes("delete_comment"), true);
  assertEquals(offered.includes("generate_image"), true);
});

Deno.test("the read connection offers the tools that return other people's text", () => {
  const offered = toolsForMode("read");

  assertEquals(offered.includes("list_comments"), true);
  assertEquals(offered.includes("list_messages"), true);
});

Deno.test("the read connection offers no interaction, write or AI tool", () => {
  for (const tool of toolsForMode("read")) {
    const kind = kindOf(tool);
    assertEquals(
      kind === "interaction" || kind === "write" || kind === "ai",
      false,
      tool,
    );
  }
});

Deno.test("the inbox connection offers public comment tools only", () => {
  const offered = toolsForMode("inbox").sort();

  assertEquals(offered, [
    "hide_comment",
    "list_accounts",
    "list_comments",
    "reply_to_comment",
  ]);
});

Deno.test("no connection offers DM reads together with any tool that sends or writes", () => {
  for (const mode of MODES) {
    const offered = toolsForMode(mode);
    if (!offered.includes("list_messages")) continue;

    for (const tool of offered) {
      const kind = kindOf(tool);
      assertEquals(
        kind === "interaction" || kind === "write" || kind === "ai",
        false,
        `${mode} offers ${tool}`,
      );
    }
  }
});

Deno.test("a tool nobody classified is not allowed in any mode", () => {
  for (const mode of MODES) {
    assertThrows(
      () => toolAllowed(mode, "no_such_tool"),
      Error,
      'No connection policy for MCP tool "no_such_tool"',
    );
  }
});

Deno.test("a tool nobody classified has no annotations", () => {
  assertThrows(
    () => toolAnnotations("no_such_tool"),
    Error,
    'No connection policy for MCP tool "no_such_tool"',
  );
});

Deno.test("a tool that only reads is marked read-only and never destructive", () => {
  for (const tool of Object.keys(TOOL_POLICIES)) {
    const policy = TOOL_POLICIES[tool];
    if (policy.kind !== "read" && policy.kind !== "untrusted_read") continue;

    assertEquals(policy.annotations.readOnlyHint, true, tool);
    assertEquals(policy.annotations.destructiveHint, false, tool);
  }
});

Deno.test("a tool that is not a read is never marked read-only", () => {
  for (const tool of Object.keys(TOOL_POLICIES)) {
    const policy = TOOL_POLICIES[tool];
    if (policy.kind === "read" || policy.kind === "untrusted_read") continue;

    assertEquals(policy.annotations.readOnlyHint, false, tool);
  }
});

Deno.test("a tool that changes existing state is marked destructive", () => {
  for (const tool of [
    "delete_comment",
    "delete_webhook",
    "cancel_scheduled_post",
    "hide_comment",
    "reschedule_post",
  ]) {
    assertEquals(TOOL_POLICIES[tool].annotations.destructiveHint, true, tool);
  }
});

Deno.test("index.ts registers every tool of the policy table", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

  const registered = [...source.matchAll(/register\("([a-z_]+)"/g)].map(
    (match) => match[1],
  );

  assertEquals(
    [...new Set(registered)].sort(),
    Object.keys(TOOL_POLICIES).sort(),
  );
});

Deno.test("index.ts registers no tool outside the register helper", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

  // The helper itself calls server.tool; it is the only call left, because a
  // tool registered outside it would skip the mode check.
  const directCalls = source.match(/server\.tool\(/g) ?? [];
  assertEquals(directCalls.length, 1);
  assertEquals(source.includes("server.tool(name,"), true);
});
