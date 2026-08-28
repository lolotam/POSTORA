import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  listSourceAccounts,
  parseSetSourceVisibilityInput,
  type QueryBuilder,
  type QueryOutcome,
  setSourceVisibility,
  SourceVisibilityError,
} from "./sourceVisibility.ts";

const OWNER = "user-1";
const OTHER = "user-2";
const SOURCE = "source-1";

type FakeRow = Record<string, unknown>;

/**
 * Stands in for the Supabase client. The database is a system boundary: the
 * assertions are on what comes back for given filters and which arguments the
 * RPC receives, not on how the query builder was called. The builder is a
 * typed QueryBuilder (thenable) so both the maybeSingle() reads and the bare
 * select/eq reads can be awaited the way the module awaits them.
 */
function fakeAdmin(tables: Record<string, FakeRow[]>) {
  const reads: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];

  const builder = (table: string, filters: Record<string, unknown>): QueryBuilder => {
    const run = (): QueryOutcome => {
      reads.push({ table, filters });
      const rows = tables[table] || [];
      const match = rows.filter((row) =>
        Object.entries(filters).every(([column, value]) => {
          // `in` carries an array; a row matches when its value is a member.
          if (Array.isArray(value)) return value.includes(row[column]);
          return row[column] === value;
        })
      );
      return { data: match, error: null };
    };
    return {
      select: () => builder(table, filters),
      eq: (column: string, value: unknown) => builder(table, { ...filters, [column]: value }),
      in: (column: string, values: unknown[]) => builder(table, { ...filters, [column]: values }),
      maybeSingle: () => {
        const outcome = run();
        const rows = outcome.data as FakeRow[];
        return Promise.resolve<QueryOutcome>({ data: rows[0] ?? null, error: outcome.error });
      },
      then: (onFulfilled, onRejected) =>
        Promise.resolve(run()).then(onFulfilled, onRejected),
    };
  };

  return {
    reads,
    rpcs,
    from: (table: string) => builder(table, {}),
    rpc: (name: string, args: Record<string, unknown>): Promise<QueryOutcome> => {
      rpcs.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

// ---------------------------------------------------------------------------
// parseSetSourceVisibilityInput
// ---------------------------------------------------------------------------

Deno.test("parseSetSourceVisibilityInput accepts both modes", () => {
  assertEquals(parseSetSourceVisibilityInput({
    source_id: SOURCE,
    visibility: "shared",
  }), { sourceId: SOURCE, visibility: "shared", socialAccountIds: [] });

  assertEquals(parseSetSourceVisibilityInput({
    source_id: SOURCE,
    visibility: "restricted",
    social_account_ids: ["acc-1", "acc-2"],
  }), { sourceId: SOURCE, visibility: "restricted", socialAccountIds: ["acc-1", "acc-2"] });
});

Deno.test("parseSetSourceVisibilityInput keeps restricted with an empty list legal", () => {
  // The monotonic contract: "no account can read this" is a valid state, not
  // a synonym for shared. The empty list must reach the RPC as an empty
  // array, never as null or an omitted parameter.
  assertEquals(parseSetSourceVisibilityInput({
    source_id: SOURCE,
    visibility: "restricted",
    social_account_ids: [],
  }), { sourceId: SOURCE, visibility: "restricted", socialAccountIds: [] });
});

Deno.test("parseSetSourceVisibilityInput collapses duplicate account ids", () => {
  assertEquals(parseSetSourceVisibilityInput({
    source_id: SOURCE,
    visibility: "restricted",
    social_account_ids: ["acc-1", "acc-1"],
  }).socialAccountIds, ["acc-1"]);
});

Deno.test("parseSetSourceVisibilityInput refuses malformed input", async (t) => {
  const refused: Array<[string, Record<string, unknown> | null]> = [
    ["no body", null],
    ["missing source_id", { visibility: "shared" }],
    ["blank source_id", { source_id: "  ", visibility: "shared" }],
    ["unknown visibility", { source_id: SOURCE, visibility: "public" }],
    ["missing visibility", { source_id: SOURCE }],
    ["social_account_ids not an array", {
      source_id: SOURCE,
      visibility: "restricted",
      social_account_ids: "acc-1",
    }],
    ["a non-string account id", {
      source_id: SOURCE,
      visibility: "restricted",
      social_account_ids: [42],
    }],
  ];

  for (const [label, body] of refused) {
    await t.step(label, () => {
      assertThrows(() => parseSetSourceVisibilityInput(body), SourceVisibilityError);
    });
  }
});

// ---------------------------------------------------------------------------
// listSourceAccounts
// ---------------------------------------------------------------------------

Deno.test("listSourceAccounts reports visibility and the explicit links", async (t) => {
  await t.step("a shared source with no links", async () => {
    const admin = fakeAdmin({
      ai_knowledge_sources: [{ id: SOURCE, user_id: OWNER, visibility: "shared" }],
      ai_knowledge_source_accounts: [],
    });
    assertEquals(await listSourceAccounts(admin, { userId: OWNER, sourceId: SOURCE }), {
      visibility: "shared",
      socialAccountIds: [],
    });
  });

  await t.step("a restricted source with two links", async () => {
    const admin = fakeAdmin({
      ai_knowledge_sources: [{ id: SOURCE, user_id: OWNER, visibility: "restricted" }],
      ai_knowledge_source_accounts: [
        { source_id: SOURCE, social_account_id: "acc-1" },
        { source_id: SOURCE, social_account_id: "acc-2" },
        // A different source's link must not leak into this source's list.
        { source_id: "source-2", social_account_id: "acc-3" },
      ],
    });
    assertEquals(await listSourceAccounts(admin, { userId: OWNER, sourceId: SOURCE }), {
      visibility: "restricted",
      socialAccountIds: ["acc-1", "acc-2"],
    });
  });

  await t.step("a source the caller does not own", async () => {
    // Ownership is part of the read, not a filter the caller remembers to
    // send: the user_id equality is what makes somebody else's source
    // indistinguishable from a missing one.
    const admin = fakeAdmin({
      ai_knowledge_sources: [{ id: SOURCE, user_id: OTHER, visibility: "shared" }],
    });
    assertEquals(await listSourceAccounts(admin, { userId: OWNER, sourceId: SOURCE }), null);
  });
});

// ---------------------------------------------------------------------------
// setSourceVisibility
// ---------------------------------------------------------------------------

Deno.test("setSourceVisibility refuses a source the caller does not own", async () => {
  const admin = fakeAdmin({
    ai_knowledge_sources: [{ id: SOURCE, user_id: OTHER, visibility: "shared" }],
  });
  const error = await assertRejects(
    () =>
      setSourceVisibility(admin, {
        userId: OWNER,
        input: { sourceId: SOURCE, visibility: "restricted", socialAccountIds: ["acc-1"] },
      }),
    SourceVisibilityError,
    "Knowledge source not found",
  );
  assertEquals(error.status, 404);
  // Refused before any write was attempted.
  assertEquals(admin.rpcs.length, 0);
});

Deno.test("setSourceVisibility refuses an account id belonging to another user", async () => {
  const admin = fakeAdmin({
    ai_knowledge_sources: [{ id: SOURCE, user_id: OWNER, visibility: "shared" }],
    social_accounts: [
      { id: "acc-1", user_id: OWNER },
      // acc-2 belongs to somebody else.
      { id: "acc-2", user_id: OTHER },
    ],
  });
  const error = await assertRejects(
    () =>
      setSourceVisibility(admin, {
        userId: OWNER,
        input: {
          sourceId: SOURCE,
          visibility: "restricted",
          socialAccountIds: ["acc-1", "acc-2"],
        },
      }),
    SourceVisibilityError,
    "do not belong to the caller",
  );
  assertEquals(error.status, 403);
  // The whole call is rejected: neither visibility nor links were written.
  assertEquals(admin.rpcs.length, 0);
});

Deno.test("setSourceVisibility('restricted', []) is delegated, not reinterpreted", async () => {
  // An empty restricted list must reach the RPC as an empty array. Treating
  // it as shared here would resurrect the non-monotonic rule the migration
  // removes.
  const admin = fakeAdmin({
    ai_knowledge_sources: [{ id: SOURCE, user_id: OWNER, visibility: "shared" }],
  });
  await setSourceVisibility(admin, {
    userId: OWNER,
    input: { sourceId: SOURCE, visibility: "restricted", socialAccountIds: [] },
  });
  assertEquals(admin.rpcs, [{
    name: "set_ai_knowledge_source_visibility",
    args: {
      p_user_id: OWNER,
      p_source_id: SOURCE,
      p_visibility: "restricted",
      p_social_account_ids: [],
    },
  }]);
});

Deno.test("setSourceVisibility('shared') delegates with the caller's identity", async () => {
  const admin = fakeAdmin({
    ai_knowledge_sources: [{ id: SOURCE, user_id: OWNER, visibility: "restricted" }],
    social_accounts: [{ id: "acc-1", user_id: OWNER }],
  });
  await setSourceVisibility(admin, {
    userId: OWNER,
    input: { sourceId: SOURCE, visibility: "shared", socialAccountIds: ["acc-1"] },
  });
  assertEquals(admin.rpcs, [{
    name: "set_ai_knowledge_source_visibility",
    args: {
      p_user_id: OWNER,
      p_source_id: SOURCE,
      p_visibility: "shared",
      p_social_account_ids: ["acc-1"],
    },
  }]);
  // The shared branch ignores ids in the RPC (it deletes every link); they
  // are still ownership-checked here so a foreign id cannot ride along.
  const ownershipRead = admin.reads.find((read) => read.table === "social_accounts");
  assertEquals(ownershipRead?.filters.user_id, OWNER);
});

Deno.test("setSourceVisibility surfaces an RPC failure", async () => {
  const admin = fakeAdmin({
    ai_knowledge_sources: [{ id: SOURCE, user_id: OWNER, visibility: "shared" }],
    social_accounts: [{ id: "acc-1", user_id: OWNER }],
  });
  admin.rpc = () => Promise.resolve({ data: null, error: { message: "rpc exploded" } });
  await assertRejects(
    () =>
      setSourceVisibility(admin, {
        userId: OWNER,
        input: { sourceId: SOURCE, visibility: "restricted", socialAccountIds: ["acc-1"] },
      }),
    Error,
    "rpc exploded",
  );
});
