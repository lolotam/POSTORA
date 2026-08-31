import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type SharingAdminClient,
  parseSetToolAccountsInput,
  setToolAccounts,
  ToolSharingError,
} from "./toolSharing.ts";

const OWNER = "user-1";
const OTHER = "user-2";

type Row = Record<string, unknown> & { id: string };

/**
 * Stands in for the service-role client at the database boundary, in the
 * register of sourceVisibility.test.ts: reads answer from `rows`, the RPC
 * seam records what was delegated.
 */
function fakeAdmin(
  seed: Row[],
  rpcResult: { error: { message: string; code?: string } | null } = { error: null },
) {
  const rows: Row[] = seed.map((row) => ({ ...row }));
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const matching = (table: string, filters: Record<string, unknown>) =>
    rows.filter((row) =>
      row.__table === table &&
      Object.entries(filters).every(([column, value]) =>
        value && typeof value === "object" && "__in" in (value as Record<string, unknown>)
          ? ((value as { __in: unknown[] }).__in.includes(row[column]))
          : row[column] === value
      )
    );

  const builder = (table: string, filters: Record<string, unknown>) => ({
    select: () => builder(table, filters),
    eq: (column: string, value: unknown) => builder(table, { ...filters, [column]: value }),
    in: (column: string, values: unknown[]) =>
      builder(table, { ...filters, [column]: { __in: values } }),
    maybeSingle: () => Promise.resolve({ data: matching(table, filters)[0] ?? null, error: null }),
    then: (
      onfulfilled: (value: { data: Array<Record<string, unknown>> | null; error: unknown }) => unknown,
      onrejected: (reason: unknown) => unknown,
    ) =>
      Promise.resolve({ data: matching(table, filters), error: null }).then(onfulfilled, onrejected),
  });

  return {
    rpcCalls,
    from: (table: string) => builder(table, {}),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return { data: null, error: rpcResult.error };
    },
  } as unknown as SharingAdminClient & { rpcCalls: Array<{ name: string; args: Record<string, unknown> }> };
}

function body(overrides: Record<string, unknown> = {}) {
  return { action: "set_tool_accounts", tool_id: "tool-1", social_account_ids: ["acc-1"], ...overrides };
}

const OWNED: Row[] = [
  { __table: "ai_agent_tools", id: "tool-1", user_id: OWNER, name: "woocommerce_store" },
  { __table: "social_accounts", id: "acc-1", user_id: OWNER },
  { __table: "social_accounts", id: "acc-2", user_id: OWNER },
  { __table: "social_accounts", id: "acc-other", user_id: OTHER },
];

Deno.test("the parse refuses a missing tool_id, a non-array list, or non-string ids", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["tool_id absent", { tool_id: undefined }],
    ["tool_id empty", { tool_id: "" }],
    ["tool_id wrong type", { tool_id: 7 }],
    ["ids not an array", { social_account_ids: "acc-1" }],
    ["ids with a non-string entry", { social_account_ids: ["acc-1", 3] }],
    ["ids with an empty entry", { social_account_ids: ["acc-1", ""] }],
  ];
  for (const [label, overrides] of cases) {
    const full: Record<string, unknown> = body(overrides);
    if (overrides.tool_id === undefined) delete full.tool_id;
    let caught: unknown = null;
    try {
      parseSetToolAccountsInput(full);
    } catch (error) {
      caught = error;
    }
    assertEquals(caught instanceof ToolSharingError, true, `case: ${label}`);
    if (caught instanceof ToolSharingError) assertEquals(caught.status, 400, `case: ${label}`);
  }
});

Deno.test("an omitted list means 'shared with no one' and duplicates are collapsed", () => {
  const { toolId, socialAccountIds } = parseSetToolAccountsInput({ tool_id: "tool-1" });
  assertEquals(toolId, "tool-1");
  assertEquals(socialAccountIds, []);

  const deduped = parseSetToolAccountsInput(
    body({ social_account_ids: ["acc-1", "acc-1", "acc-2"] }),
  );
  assertEquals(deduped.socialAccountIds, ["acc-1", "acc-2"]);
});

Deno.test("a tool the caller does not own is a 404 before the RPC is reached", async () => {
  const admin = fakeAdmin(OWNED);
  const error = await assertRejects(
    () =>
      setToolAccounts(admin, { userId: OWNER, input: parseSetToolAccountsInput(body({ tool_id: "tool-x" })) }),
    ToolSharingError,
  );
  assertEquals(error.status, 404);
  assertEquals(admin.rpcCalls.length, 0);
});

Deno.test("an account the caller does not own is a 403 naming the refusal, not the id", async () => {
  const admin = fakeAdmin(OWNED);
  const error = await assertRejects(
    () =>
      setToolAccounts(admin, {
        userId: OWNER,
        input: parseSetToolAccountsInput(body({ social_account_ids: ["acc-1", "acc-other"] })),
      }),
    ToolSharingError,
  );
  assertEquals(error.status, 403);
  // Which id was foreign is not the caller's business to learn.
  assertEquals(error.message.includes("acc-other"), false);
  assertEquals(admin.rpcCalls.length, 0);
});

Deno.test("a link that would collide surfaces the RPC's own message, not [object Object]", async () => {
  // §12.3 layer 1: set_ai_agent_tool_accounts refuses a share that would
  // give an account two enabled tools of one name, naming both. The raw
  // PostgrestError is a plain object -- rethrowing it renders as
  // "[object Object]" in both the client response and the system log.
  const collisionMessage =
    'Sharing would give an account two enabled connectors named "woocommerce_store": ' +
    "account acc-9 already resolves enabled connector 'woocommerce_store' (tool tool-2). " +
    "Rename one of them and share again.";
  const admin = fakeAdmin(OWNED, {
    error: { message: collisionMessage, code: "P0001" },
  });
  const error = await assertRejects(
    () =>
      setToolAccounts(admin, {
        userId: OWNER,
        input: parseSetToolAccountsInput(body({ social_account_ids: ["acc-1", "acc-2"] })),
      }),
    Error,
  );
  assertEquals(error.message, collisionMessage);
});

Deno.test("a clean share delegates to set_ai_agent_tool_accounts with the caller's id", async () => {
  const admin = fakeAdmin(OWNED);
  await setToolAccounts(admin, {
    userId: OWNER,
    input: parseSetToolAccountsInput(body({ social_account_ids: ["acc-1", "acc-2"] })),
  });
  assertEquals(admin.rpcCalls.length, 1);
  assertEquals(admin.rpcCalls[0].name, "set_ai_agent_tool_accounts");
  assertEquals(admin.rpcCalls[0].args, {
    p_user_id: OWNER,
    p_tool_id: "tool-1",
    p_social_account_ids: ["acc-1", "acc-2"],
  });
});
