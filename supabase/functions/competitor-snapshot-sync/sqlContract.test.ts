/**
 * The production store and the production SQL, bound together.
 *
 * WHAT THIS SUITE IS
 *
 *   The store calls PostgreSQL functions by name and by argument name. A
 *   mismatch is not a compile error: it is a runtime failure, in
 *   production, on the first claim of the first job.
 *
 *   This suite runs the PRODUCTION store - the real module, not a copy -
 *   against the PRODUCTION migration file, and compares what the store
 *   sends with what the SQL declares. It closes the gap between the two
 *   halves of the contract that a SQL-only test cannot see: the SQL suite
 *   proves the function behaves, and this suite proves the caller asks for
 *   it correctly.
 *
 *   The result SHAPE is checked the same way: every key the store reads
 *   has to be a key the function actually returns.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCompetitorServiceStore,
  type CompetitorRpcCaller,
  type ServiceReadPort,
} from "./store.ts";

const testFilePath = fileURLToPath(import.meta.url);
const FUNCTIONS_ROOT = dirname(dirname(testFilePath));
const REPO_ROOT = dirname(dirname(FUNCTIONS_ROOT));
const MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20261029150000_competitor_collection_results.sql",
);

async function migrationText(): Promise<string> {
  return await Deno.readTextFile(MIGRATION);
}

/**
 * The parameter names of one function in the migration.
 *
 * The declaration is read, not assumed: the names come out of the file the
 * database will actually run.
 */
function declaredParameters(sql: string, functionName: string): string[] {
  const marker = `CREATE OR REPLACE FUNCTION public.${functionName}(`;
  const start = sql.indexOf(marker);
  assert(start >= 0, `the migration does not declare ${functionName}`);

  const body = sql.slice(start + marker.length);
  const end = body.indexOf(")\n");
  assert(end > 0, `the declaration of ${functionName} does not close`);

  const declaration = body.slice(0, end);
  const names: string[] = [];
  for (const part of declaration.split(",")) {
    const match = /^\s*(p_[a-z_]+)\s+/i.exec(part);
    if (match) names.push(match[1]!);
  }
  return names;
}

interface Recorded {
  name: string;
  args: Record<string, unknown>;
}

function recorder(responses: Record<string, unknown>): {
  calls: Recorded[];
  rpc: CompetitorRpcCaller;
} {
  const calls: Recorded[] = [];
  const rpc: CompetitorRpcCaller = async (name, args) => {
    calls.push({ name, args });
    return { data: responses[name] ?? null, error: null };
  };
  return { calls, rpc };
}

const noReads: ServiceReadPort = {
  async readOne() {
    return { data: null, error: null };
  },
  async readMany() {
    return { data: [], error: null };
  },
};

Deno.test("the store sends exactly the parameters the new SQL declares", async () => {
  const sql = await migrationText();

  const { calls, rpc } = recorder({
    list_due_competitor_collection_targets: [],
    persist_competitor_collection_result: {
      job_id: "5c1b0003-0000-4000-8000-000000000003",
      job_generation: 1,
      outcome: "completed",
      source: "official",
      watchlist_id: "c1000000-0000-4000-8000-000000000001",
      captured_on: "2026-10-29",
      written: 1,
      media_count: 0,
      captured_at: "2026-10-29T02:00:00+00:00",
    },
  });

  const store = createCompetitorServiceStore({ rpc, reads: noReads });

  await store.listDueTargets({
    limit: 50,
    cursor: { dueAt: "2026-10-01T00:00:00+00:00", id: "c1" },
  });

  await store.persistResult({
    jobId: "5c1b0003-0000-4000-8000-000000000003",
    claimToken: "t",
    jobGeneration: 1,
    payload: { outcome: "completed", source: "official", profile: { metrics: {} }, media: [] },
  });

  const dueCall = calls.find((call) => call.name === "list_due_competitor_collection_targets");
  const persistCall = calls.find((call) => call.name === "persist_competitor_collection_result");

  assert(dueCall !== undefined, "the due-target read was called");
  assert(persistCall !== undefined, "the result write was called");

  assertEquals(
    Object.keys(dueCall.args).sort(),
    declaredParameters(sql, "list_due_competitor_collection_targets").sort(),
    "the due-target read sends the declared parameters",
  );

  assertEquals(
    Object.keys(persistCall.args).sort(),
    declaredParameters(sql, "persist_competitor_collection_result").sort(),
    "the result write sends the declared parameters",
  );
});

Deno.test("every key the store reads is a key the new SQL returns", async () => {
  const sql = await migrationText();

  // The keys the store parses out of the two receipts.
  const readKeys = [
    "outcome",
    "source",
    "reason_code",
    "written",
    "media_count",
    "captured_at",
    "watchlist_id",
    "next_retry_at",
    "job_id",
    "job_generation",
    "user_id",
    "due_at",
  ];

  for (const key of readKeys) {
    assert(
      sql.includes(`'${key}'`),
      `the new SQL does not return ${key}`,
    );
  }
});

Deno.test("the store refuses a receipt the new SQL could not produce", async () => {
  // A receipt without the outcome is not a receipt. The store has to
  // refuse it rather than report an empty success.
  const { rpc } = recorder({
    persist_competitor_collection_result: {
      job_id: "j",
      job_generation: 1,
    },
  });

  const store = createCompetitorServiceStore({ rpc, reads: noReads });

  let threw = false;
  try {
    await store.persistResult({
      jobId: "j",
      claimToken: "t",
      jobGeneration: 1,
      payload: { outcome: "completed", source: "official", profile: { metrics: {} }, media: [] },
    });
  } catch {
    threw = true;
  }

  assertEquals(threw, true);
});
