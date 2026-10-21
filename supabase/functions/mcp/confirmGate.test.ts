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
  profile?: { id: string } | null;
  lookupError?: { message: string } | null;
  insertError?: { message: string } | null;
  throwOn?: "maybeSingle" | "insert" | null;
}

// A fake admin that records every call the gate makes. Nothing here talks to
// a database or to the network.
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
          if (options.throwOn === "maybeSingle") throw new Error("database is down");
          if (options.lookupError) return { data: null, error: options.lookupError };
          return { data: options.profile ?? null, error: null };
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

// The key is hashed exactly like the API hashes it before looking the owner
// up: sha256Hex(apiKey) against profiles.api_key_hash.
const sha256Hex = async (_text: string): Promise<string> => "hashed-placeholder";

const CALLER_PLACEHOLDER = "placeholder-caller";

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
  const { admin, calls } = createFakeAdmin({ profile: { id: "user-1" } });

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "delete_comment", confirm: true },
  );

  assertEquals(refusal, null);
  assertEquals(calls, []);
});

Deno.test("a missing confirm is refused and the refusal is recorded", async () => {
  const { admin, calls, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);

  // The owner is resolved the way the API resolves an API key.
  assertEquals(calls.map((call) => call.method), [
    "from",
    "select",
    "eq",
    "maybeSingle",
    "from",
    "insert",
  ]);
  assertEquals(calls[0].args, ["profiles"]);
  assertEquals(calls[1].args, ["id"]);
  assertEquals(calls[2].args, ["api_key_hash", "hashed-placeholder"]);

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row, {
    source: "mcp",
    category: "edge",
    level: "warn",
    message: "delete_comment refused: CONFIRMATION_REQUIRED",
    user_id: "user-42",
    metadata: {
      tool: "delete_comment",
      code: "CONFIRMATION_REQUIRED",
      owner_resolved: true,
    },
  });

  const metadata = inserts[0].row.metadata as Record<string, unknown>;
  assertEquals(Object.keys(metadata).sort(), ["code", "owner_resolved", "tool"]);

  // The arguments, the key and its hash are not in the row.
  const serialized = JSON.stringify(inserts[0].row);
  assertEquals(serialized.includes(CALLER_PLACEHOLDER), false);
  assertEquals(serialized.includes("hashed-placeholder"), false);
  assertEquals("args" in metadata, false);
  assertEquals("arguments" in metadata, false);
  assertEquals("api_key" in inserts[0].row, false);
});

Deno.test("confirm: false is refused and recorded like a missing confirm", async () => {
  const { admin, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "cancel_scheduled_post", confirm: false },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, "user-42");
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "cancel_scheduled_post",
    code: "CONFIRMATION_REQUIRED",
    owner_resolved: true,
  });
});

Deno.test('confirm: "true" (a string) is refused and recorded', async () => {
  const { admin, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "delete_comment", confirm: "true" },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, "user-42");
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
    owner_resolved: true,
  });
});

Deno.test("confirm: null is refused and recorded", async () => {
  const { admin, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "delete_comment", confirm: null },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, "user-42");
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
    owner_resolved: true,
  });
});

Deno.test("an unknown owner is refused and still writes a row without an owner", async () => {
  const { admin, calls, inserts } = createFakeAdmin({ profile: null });

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "hide_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);

  // The refusal leaves a trace even without an owner.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, null);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "hide_comment",
    code: "CONFIRMATION_REQUIRED",
    owner_resolved: false,
  });
  assertEquals(calls.map((call) => call.method), [
    "from",
    "select",
    "eq",
    "maybeSingle",
    "from",
    "insert",
  ]);
});

Deno.test("a failed owner lookup is refused and still writes a row without an owner", async () => {
  const { admin, inserts } = createFakeAdmin({ lookupError: { message: "database is down" } });

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);

  // The refusal leaves a trace even without an owner.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, null);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
    owner_resolved: false,
  });
});

Deno.test("a failed log insert still refuses and never throws", async () => {
  const { admin, inserts } = createFakeAdmin({
    profile: { id: "user-42" },
    insertError: { message: "insert failed" },
  });

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
});

Deno.test("a throwing log insert still refuses and never throws", async () => {
  const { admin } = createFakeAdmin({ profile: { id: "user-42" }, throwOn: "insert" });

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
});

Deno.test("a throwing database client refuses instead of throwing", async () => {
  const { admin, inserts } = createFakeAdmin({ throwOn: "maybeSingle" });

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);

  // The thrown lookup costs the row its owner, not the row itself.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, null);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
    owner_resolved: false,
  });
});

Deno.test("a throwing hash refuses instead of throwing and still writes a row", async () => {
  const { admin, inserts } = createFakeAdmin({ profile: { id: "user-42" } });
  const throwingHash = async (_text: string): Promise<string> => {
    throw new Error("hashing is unavailable");
  };

  const refusal = await refuseUnconfirmed(
    { admin, sha256Hex: throwingHash },
    { apiKey: CALLER_PLACEHOLDER, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);

  // The owner was never resolved, so the row is written without one.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, null);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
    owner_resolved: false,
  });
});

Deno.test("recordMcpRefusal writes one row naming the tool and the code, and nothing else", async () => {
  const { admin, calls, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

  await recordMcpRefusal(
    { admin, sha256Hex },
    { apiKey: CALLER_PLACEHOLDER, tool: "reply_to_message", code: "INVALID_MESSAGE" },
  );

  // The owner is resolved the way the API resolves an API key.
  assertEquals(calls.map((call) => call.method), [
    "from",
    "select",
    "eq",
    "maybeSingle",
    "from",
    "insert",
  ]);
  assertEquals(calls[0].args, ["profiles"]);
  assertEquals(calls[2].args, ["api_key_hash", "hashed-placeholder"]);

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row, {
    source: "mcp",
    category: "edge",
    level: "warn",
    message: "reply_to_message refused: INVALID_MESSAGE",
    user_id: "user-42",
    metadata: {
      tool: "reply_to_message",
      code: "INVALID_MESSAGE",
      owner_resolved: true,
    },
  });

  const metadata = inserts[0].row.metadata as Record<string, unknown>;
  assertEquals(Object.keys(metadata).sort(), ["code", "owner_resolved", "tool"]);

  // The arguments, the key and its hash are not in the row.
  const serialized = JSON.stringify(inserts[0].row);
  assertEquals(serialized.includes(CALLER_PLACEHOLDER), false);
  assertEquals(serialized.includes("hashed-placeholder"), false);
});

Deno.test("a failed insert in recordMcpRefusal does not throw", async () => {
  const { admin, inserts } = createFakeAdmin({
    profile: { id: "user-42" },
    insertError: { message: "insert failed" },
  });

  let thrown: unknown = null;
  try {
    await recordMcpRefusal(
      { admin, sha256Hex },
      { apiKey: CALLER_PLACEHOLDER, tool: "reply_to_message", code: "INVALID_MESSAGE" },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, null);
  assertEquals(inserts.length, 1);
});

// ── the schema rejection ───────────────────────────────────────────────────────

// The framework validates the arguments against the tool's input schema before
// the handler runs, so a call that does not fit the schema never reaches the
// handler and never reaches the confirmation gate either. The refusal it
// answers with is the only trace of such a call, and it has to leave a row.

const INVALID_PARAMS = -32602;

Deno.test("a schema rejection of a tool call is recorded as a refusal", async () => {
  const { admin, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

  await auditSchemaRejection(
    { admin, sha256Hex },
    {
      apiKey: CALLER_PLACEHOLDER,
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
  assertEquals(inserts[0].row.user_id, "user-42");
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "reply_to_message",
    code: "INVALID_PARAMS",
    owner_resolved: true,
  });

  const metadata = inserts[0].row.metadata as Record<string, unknown>;
  assertEquals(Object.keys(metadata).sort(), ["code", "owner_resolved", "tool"]);

  // The arguments are not in the row, and neither are the key and its hash.
  const serialized = JSON.stringify(inserts[0].row);
  assertEquals(serialized.includes("arguments"), false);
  assertEquals(serialized.includes("hello there"), false);
  assertEquals(serialized.includes("account-1"), false);
  assertEquals(serialized.includes(CALLER_PLACEHOLDER), false);
  assertEquals(serialized.includes("hashed-placeholder"), false);
});

Deno.test("a schema rejection of a method that is not a tool call is not recorded", async () => {
  const { admin, calls, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

  await auditSchemaRejection(
    { admin, sha256Hex },
    {
      apiKey: CALLER_PLACEHOLDER,
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: { method: "tools/list", params: { name: "reply_to_message" } },
    },
  );

  // Nothing is recorded and nothing is read: this is not a rejected tool call.
  assertEquals(inserts.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("an error that is not a schema rejection is not recorded", async () => {
  const { admin, calls, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

  await auditSchemaRejection(
    { admin, sha256Hex },
    {
      apiKey: CALLER_PLACEHOLDER,
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
  const { admin, calls, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

  await auditSchemaRejection(
    { admin, sha256Hex },
    {
      apiKey: CALLER_PLACEHOLDER,
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
    const { admin, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

    await auditSchemaRejection(
      { admin, sha256Hex },
      {
        apiKey: CALLER_PLACEHOLDER,
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
      owner_resolved: true,
    }, testCase.label);
  }
});

Deno.test("a rejected tool call that names no tool is recorded as unknown", async () => {
  const { admin, inserts } = createFakeAdmin({ profile: { id: "user-42" } });

  await auditSchemaRejection(
    { admin, sha256Hex },
    {
      apiKey: CALLER_PLACEHOLDER,
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: { method: "tools/call", params: { arguments: {} } },
    },
  );

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "unknown",
    code: "INVALID_PARAMS",
    owner_resolved: true,
  });
});

Deno.test("a schema rejection whose owner cannot be resolved still writes a row", async () => {
  const { admin, inserts } = createFakeAdmin({ profile: null });

  await auditSchemaRejection(
    { admin, sha256Hex },
    {
      apiKey: CALLER_PLACEHOLDER,
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: {
        method: "tools/call",
        params: { name: "reply_to_message", arguments: {} },
      },
    },
  );

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.user_id, null);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "reply_to_message",
    code: "INVALID_PARAMS",
    owner_resolved: false,
  });
});

Deno.test("the auditor never throws, whatever the database does", async () => {
  const { admin } = createFakeAdmin({ throwOn: "maybeSingle" });

  let thrown: unknown = null;
  try {
    await auditSchemaRejection(
      { admin, sha256Hex },
      {
        apiKey: CALLER_PLACEHOLDER,
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
