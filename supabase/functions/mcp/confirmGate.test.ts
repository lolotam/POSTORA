import { assertEquals } from "jsr:@std/assert@1";
import {
  auditSchemaRejection,
  confirmField,
  recordMcpRefusal,
  refuseUnconfirmed,
  type ConfirmRefusal,
} from "./confirmGate.ts";

interface FakeCall {
  method: string;
  args: unknown[];
}

interface FakeQueryBuilder {
  select(columns: string): FakeQueryBuilder;
  eq(column: string, value: unknown): FakeQueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
  insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
}

interface FakeAdminOptions {
  insertError?: { message: string } | null;
  throwOn?: "insert" | null;
}

// A fake admin that records every call the gate makes. Nothing here talks to
// a database or to the network. The query methods are there so that a lookup
// the gate must no longer perform would show up in the recorded calls.
function createFakeAdmin(options: FakeAdminOptions = {}) {
  const calls: FakeCall[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];

  const admin = {
    from(table: string): FakeQueryBuilder {
      calls.push({ method: "from", args: [table] });
      const builder: FakeQueryBuilder = {
        select(columns: string) {
          calls.push({ method: "select", args: [columns] });
          return builder;
        },
        eq(column: string, value: unknown) {
          calls.push({ method: "eq", args: [column, value] });
          return builder;
        },
        async maybeSingle() {
          calls.push({ method: "maybeSingle", args: [] });
          return { data: null, error: null };
        },
        async insert(row: Record<string, unknown>) {
          calls.push({ method: "insert", args: [row] });
          if (options.throwOn === "insert") throw new Error("database is down");
          inserts.push({ table, row });
          return { error: options.insertError ?? null };
        },
      };
      return builder;
    },
  };

  return { admin, calls, inserts };
}

// The owner the edge resolved before the tool ran. The gate never resolves
// an owner itself: it is given the id and writes the row under it.
const OWNER_ID = "user-42";

const EXPECTED_REFUSAL: ConfirmRefusal = {
  code: "CONFIRMATION_REQUIRED",
  message: "Set confirm: true to run this action.",
};

Deno.test("the confirm field takes any value, so the handler refuses and records it", () => {
  assertEquals(confirmField.safeParse(true).success, true);
  assertEquals(confirmField.safeParse(false).success, true);
  assertEquals(confirmField.safeParse(undefined).success, true);
  assertEquals(confirmField.safeParse("true").success, true);
  assertEquals(confirmField.safeParse(null).success, true);
});

Deno.test("a confirmed call is allowed and touches no database", async () => {
  const { admin, calls } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: true },
  );

  assertEquals(refusal, null);
  assertEquals(calls, []);
});

Deno.test("a missing confirm is refused and the refusal is recorded", async () => {
  const { admin, calls, inserts } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);

  // The owner is the one the edge resolved. The gate reads no profile: an
  // unauthenticated caller never reaches it.
  assertEquals(calls.map((call) => call.method), ["from", "insert"]);
  assertEquals(calls[0].args, ["system_logs"]);

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row, {
    source: "mcp",
    category: "edge",
    level: "warn",
    message: "delete_comment refused: CONFIRMATION_REQUIRED",
    user_id: OWNER_ID,
    metadata: {
      tool: "delete_comment",
      code: "CONFIRMATION_REQUIRED",
    },
  });

  const metadata = inserts[0].row.metadata as Record<string, unknown>;
  assertEquals(Object.keys(metadata).sort(), ["code", "tool"]);

  // The arguments are not in the row.
  assertEquals("args" in metadata, false);
  assertEquals("arguments" in metadata, false);
  assertEquals("api_key" in inserts[0].row, false);
});

Deno.test("the refusal is recorded under the owner the edge resolved", async () => {
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: "another-owner", tool: "hide_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, "another-owner");
});

Deno.test("confirm: false is refused and recorded like a missing confirm", async () => {
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "cancel_scheduled_post", confirm: false },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "cancel_scheduled_post",
    code: "CONFIRMATION_REQUIRED",
  });
});

Deno.test('confirm: "true" (a string) is refused and recorded', async () => {
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: "true" },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
  });
});

Deno.test("confirm: null is refused and recorded", async () => {
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: null },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
  });
});

Deno.test("a failed log insert still refuses and never throws", async () => {
  const { admin, inserts } = createFakeAdmin({ insertError: { message: "insert failed" } });

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
});

Deno.test("a throwing log insert still refuses and never throws", async () => {
  const { admin } = createFakeAdmin({ throwOn: "insert" });

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
});

Deno.test("recordMcpRefusal writes one row naming the tool and the code, and nothing else", async () => {
  const { admin, calls, inserts } = createFakeAdmin();

  await recordMcpRefusal(
    { admin },
    { userId: OWNER_ID, tool: "reply_to_message", code: "INVALID_MESSAGE" },
  );

  // The owner comes from the edge. The gate reads no profile.
  assertEquals(calls.map((call) => call.method), ["from", "insert"]);
  assertEquals(calls[0].args, ["system_logs"]);

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row, {
    source: "mcp",
    category: "edge",
    level: "warn",
    message: "reply_to_message refused: INVALID_MESSAGE",
    user_id: OWNER_ID,
    metadata: {
      tool: "reply_to_message",
      code: "INVALID_MESSAGE",
    },
  });

  const metadata = inserts[0].row.metadata as Record<string, unknown>;
  assertEquals(Object.keys(metadata).sort(), ["code", "tool"]);

  // The arguments are not in the row.
  assertEquals("args" in metadata, false);
  assertEquals("arguments" in metadata, false);
  assertEquals("api_key" in inserts[0].row, false);
});

Deno.test("a failed insert in recordMcpRefusal does not throw", async () => {
  const { admin, inserts } = createFakeAdmin({ insertError: { message: "insert failed" } });

  let thrown: unknown = null;
  try {
    await recordMcpRefusal(
      { admin },
      { userId: OWNER_ID, tool: "reply_to_message", code: "INVALID_MESSAGE" },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, null);
  assertEquals(inserts.length, 1);
});

Deno.test("a throwing insert in recordMcpRefusal does not throw", async () => {
  const { admin } = createFakeAdmin({ throwOn: "insert" });

  let thrown: unknown = null;
  try {
    await recordMcpRefusal(
      { admin },
      { userId: OWNER_ID, tool: "reply_to_message", code: "INVALID_MESSAGE" },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, null);
});

// ── the schema rejection ───────────────────────────────────────────────────────

// The framework validates the arguments against the tool's input schema before
// the handler runs, so a call that does not fit the schema never reaches the
// handler and never reaches the confirmation gate either. The refusal it
// answers with is the only trace of such a call, and it has to leave a row.

const INVALID_PARAMS = -32602;

Deno.test("a schema rejection of a tool call is recorded as a refusal", async () => {
  const { admin, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: {
        method: "tools/call",
        params: {
          name: "reply_to_message",
          arguments: { social_account_id: "account-1", message: "hello there" },
        },
      },
    },
  );

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "reply_to_message",
    code: "INVALID_PARAMS",
  });

  const metadata = inserts[0].row.metadata as Record<string, unknown>;
  assertEquals(Object.keys(metadata).sort(), ["code", "tool"]);

  // The arguments are not in the row.
  const serialized = JSON.stringify(inserts[0].row);
  assertEquals(serialized.includes("arguments"), false);
  assertEquals(serialized.includes("hello there"), false);
  assertEquals(serialized.includes("account-1"), false);
});

Deno.test("a schema rejection is recorded under the owner the edge resolved", async () => {
  const { admin, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: "another-owner",
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: {
        method: "tools/call",
        params: { name: "reply_to_message", arguments: {} },
      },
    },
  );

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.user_id, "another-owner");
});

Deno.test("a schema rejection of a method that is not a tool call is not recorded", async () => {
  const { admin, calls, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: { method: "tools/list", params: { name: "reply_to_message" } },
    },
  );

  // Nothing is recorded and nothing is read: this is not a rejected tool call.
  assertEquals(inserts.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("an error that is not a schema rejection is not recorded", async () => {
  const { admin, calls, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: { code: -32601, message: "Method not found" },
      rpcRequest: {
        method: "tools/call",
        params: { name: "reply_to_message", arguments: {} },
      },
    },
  );

  assertEquals(inserts.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("an error that is not an error object is not recorded", async () => {
  const { admin, calls, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: "invalid params",
      rpcRequest: {
        method: "tools/call",
        params: { name: "reply_to_message", arguments: {} },
      },
    },
  );

  assertEquals(inserts.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("a tool name that is not a tool name is recorded as unknown", async () => {
  const cases: { name: string; label: string }[] = [
    { name: "Reply_To_Message", label: "a name that is not lowercase" },
    { name: "reply-to-message", label: "a name that is not a word" },
    { name: "", label: "an empty name" },
    { name: "a".repeat(65), label: "a name that is too long" },
  ];

  for (const testCase of cases) {
    const { admin, inserts } = createFakeAdmin();

    await auditSchemaRejection(
      { admin },
      {
        userId: OWNER_ID,
        error: { code: INVALID_PARAMS, message: "Invalid params" },
        rpcRequest: {
          method: "tools/call",
          params: { name: testCase.name, arguments: {} },
        },
      },
    );

    // The row names no tool rather than a tool that does not exist.
    assertEquals(inserts.length, 1, testCase.label);
    assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
      tool: "unknown",
      code: "INVALID_PARAMS",
    }, testCase.label);
  }
});

Deno.test("a rejected tool call that names no tool is recorded as unknown", async () => {
  const { admin, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: { method: "tools/call", params: { arguments: {} } },
    },
  );

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "unknown",
    code: "INVALID_PARAMS",
  });
});

Deno.test("the auditor never throws, whatever the database does", async () => {
  const { admin } = createFakeAdmin({ throwOn: "insert" });

  let thrown: unknown = null;
  try {
    await auditSchemaRejection(
      { admin },
      {
        userId: OWNER_ID,
        error: { code: INVALID_PARAMS, message: "Invalid params" },
        rpcRequest: {
          method: "tools/call",
          params: { name: "reply_to_message", arguments: {} },
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, null);
});
