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
 *   against the PRODUCTION migration files, and compares what the store
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
  type CompetitorServiceWritePort,
  type ServiceReadPort,
} from "./store.ts";

const testFilePath = fileURLToPath(import.meta.url);
const FUNCTIONS_ROOT = dirname(dirname(testFilePath));
const REPO_ROOT = dirname(dirname(FUNCTIONS_ROOT));
const MIGRATIONS = join(REPO_ROOT, "supabase", "migrations");

/** The writer that carries the coverage evidence. */
const MIGRATION_V2 = join(
  MIGRATIONS,
  "20261030100000_competitor_capture_coverage.sql",
);

/** The writer that stays callable for deployment compatibility. */
const MIGRATION_V1 = join(
  MIGRATIONS,
  "20261029150000_competitor_collection_results.sql",
);

/**
 * The rollout admission contract.
 *
 * It owns the policy, the watchlist pins, the viewer attachment and the
 * per-request provider permit.
 */
const MIGRATION_ROLLOUT = join(
  MIGRATIONS,
  "20261030150000_instagram_collection_rollout_controls.sql",
);

async function migrationText(path: string): Promise<string> {
  return await Deno.readTextFile(path);
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

/**
 * The write port of a test that does not exercise the exception-path audit.
 *
 * It reports that the row did NOT commit, so a refusal that is audited here
 * is audited as failed - the fail-closed direction.
 */
const noWrites: CompetitorServiceWritePort = {
  async insertSystemLog() {
    return false;
  },
};

const COVERAGE_PAYLOAD = {
  capture_started_at: "2026-10-29T02:00:00.000Z",
  capture_ended_at: "2026-10-29T02:00:05.000Z",
  oldest_returned_at: null,
  ordering_verified: false,
  cursor_present: false,
  exhausted: true,
  truncated: false,
  gap_reason: null,
};

Deno.test("the store sends exactly the parameters the new SQL declares", async () => {
  // The due-target read is declared by the migration that introduced it and
  // is UNCHANGED; the versioned result write is declared by the new one.
  const v1 = await migrationText(MIGRATION_V1);
  const v2 = await migrationText(MIGRATION_V2);

  const { calls, rpc } = recorder({
    list_due_competitor_collection_targets: [],
    persist_competitor_collection_result_v2: {
      version: 2,
      job_id: "5c1b0003-0000-4000-8000-000000000003",
      job_generation: 1,
      outcome: "completed",
      source: "official",
      watchlist_id: "c1000000-0000-4000-8000-000000000001",
      captured_on: "2026-10-29",
      written: 1,
      media_count: 0,
      captured_at: "2026-10-29T02:00:00+00:00",
      coverage: {
        watchlist_id: "c1000000-0000-4000-8000-000000000001",
        user_id: "a1000000-0000-4000-8000-000000000001",
        captured_on: "2026-10-29",
        captured_at: "2026-10-29T02:00:00+00:00",
        source: "official",
        job_generation: 1,
        capture_started_at: "2026-10-29T02:00:00.000Z",
        capture_ended_at: "2026-10-29T02:00:05.000Z",
        oldest_returned_at: null,
        ordering_verified: false,
        cursor_present: false,
        exhausted: true,
        truncated: false,
        gap_reason: null,
        inventory_complete: true,
      },
    },
  });

  const store = createCompetitorServiceStore({ rpc, reads: noReads, writes: noWrites });

  await store.listDueTargets({
    limit: 50,
    cursor: { dueAt: "2026-10-01T00:00:00+00:00", id: "c1" },
  });

  await store.persistResult({
    jobId: "5c1b0003-0000-4000-8000-000000000003",
    claimToken: "t",
    jobGeneration: 1,
    payload: {
      outcome: "completed",
      source: "official",
      profile: { metrics: {} },
      media: [],
      coverage: COVERAGE_PAYLOAD,
    },
  });

  const dueCall = calls.find((call) => call.name === "list_due_competitor_collection_targets");
  const persistCall = calls.find((call) => call.name === "persist_competitor_collection_result_v2");

  assert(dueCall !== undefined, "the due-target read was called");
  assert(persistCall !== undefined, "the versioned result write was called");

  assertEquals(
    Object.keys(dueCall.args).sort(),
    declaredParameters(v1, "list_due_competitor_collection_targets").sort(),
    "the due-target read sends the declared parameters",
  );

  assertEquals(
    Object.keys(persistCall.args).sort(),
    declaredParameters(v2, "persist_competitor_collection_result_v2").sort(),
    "the versioned result write sends the declared parameters",
  );
});

Deno.test("every key the store reads is a key the new SQL returns", async () => {
  const sql = await migrationText(MIGRATION_V2);

  // The keys the store parses out of the versioned receipt.
  const readKeys = [
    "version",
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
    "captured_on",
    "coverage",
    // The keys of the stored coverage the store reads.
    "user_id",
    "source",
    "job_generation",
    "capture_started_at",
    "capture_ended_at",
    "oldest_returned_at",
    "ordering_verified",
    "cursor_present",
    "exhausted",
    "truncated",
    "gap_reason",
    "inventory_complete",
  ];

  for (const key of readKeys) {
    assert(
      sql.includes(`'${key}'`),
      `the new SQL does not return ${key}`,
    );
  }
});

Deno.test("the versioned writer accepts the coverage key the store sends", async () => {
  const sql = await migrationText(MIGRATION_V2);

  // The payload key list of the versioned writer names the coverage, so a
  // payload that carries one is not refused as an unknown key.
  assert(
    sql.includes("'profile', 'media', 'coverage'"),
    "the versioned writer accepts the coverage payload key",
  );

  // Every key the coverage payload carries is a key the writer reads.
  for (const key of Object.keys(COVERAGE_PAYLOAD)) {
    assert(
      sql.includes(`'${key}'`),
      `the versioned writer does not read the coverage key ${key}`,
    );
  }
});

Deno.test("the v1 writer is still declared and still callable", async () => {
  const v1 = await migrationText(MIGRATION_V1);
  const v2 = await migrationText(MIGRATION_V2);

  // The v1 writer is untouched: its declaration is still the accepted one.
  assertEquals(
    declaredParameters(v1, "persist_competitor_collection_result").sort(),
    ["p_claim_token", "p_job_generation", "p_job_id", "p_payload"],
    "the v1 writer keeps its signature",
  );

  // The versioned writer is a SEPARATE function, not a replacement.
  assert(
    v2.includes("CREATE OR REPLACE FUNCTION public.persist_competitor_collection_result_v2("),
    "the versioned writer is declared in the new migration",
  );
  assert(
    !v2.includes("CREATE OR REPLACE FUNCTION public.persist_competitor_collection_result("),
    "the new migration does not replace the v1 writer",
  );
});

Deno.test("the store sends exactly the parameters the rollout SQL declares", async () => {
  const rollout = await migrationText(MIGRATION_ROLLOUT);

  const { calls, rpc } = recorder({
    authorize_instagram_collection_provider_call: {
      allowed: false,
      reason_code: "collection_not_eligible",
    },
    attach_instagram_collection_job_viewer_context: {
      job_id: "5c1b0003-0000-4000-8000-000000000003",
      job_generation: 1,
      viewer_social_account_id: "a1000000-0000-4000-8000-000000000001",
      credential_generation: 3,
      login_kind: "page_linked",
      granted_scopes: [],
    },
  });

  const store = createCompetitorServiceStore({ rpc, reads: noReads, writes: noWrites });

  await store.attachViewerContext({
    jobId: "5c1b0003-0000-4000-8000-000000000003",
    claimToken: "5c1b0003-0000-4000-8000-000000000003",
    jobGeneration: 1,
    viewerSocialAccountId: "a1000000-0000-4000-8000-000000000001",
  });

  await store.authorizeProviderCall({
    jobId: "5c1b0003-0000-4000-8000-000000000003",
    claimToken: "5c1b0003-0000-4000-8000-000000000003",
    jobGeneration: 1,
    targetId: "c1000000-0000-4000-8000-000000000001",
    viewerSocialAccountId: "a1000000-0000-4000-8000-000000000001",
  });

  const attachCall = calls.find((call) =>
    call.name === "attach_instagram_collection_job_viewer_context"
  );
  const permitCall = calls.find((call) =>
    call.name === "authorize_instagram_collection_provider_call"
  );

  assert(attachCall !== undefined, "the viewer attachment was called");
  assert(permitCall !== undefined, "the provider permit was called");

  assertEquals(
    Object.keys(attachCall.args).sort(),
    declaredParameters(rollout, "attach_instagram_collection_job_viewer_context").sort(),
    "the viewer attachment sends the declared parameters",
  );

  assertEquals(
    Object.keys(permitCall.args).sort(),
    declaredParameters(rollout, "authorize_instagram_collection_provider_call").sort(),
    "the provider permit sends the declared parameters",
  );
});

Deno.test("the provider permit names no owner, no account and no viewer", async () => {
  const { calls, rpc } = recorder({
    authorize_instagram_collection_provider_call: {
      allowed: false,
      reason_code: "collection_not_eligible",
    },
  });

  const store = createCompetitorServiceStore({ rpc, reads: noReads, writes: noWrites });

  await store.authorizeProviderCall({
    jobId: "5c1b0003-0000-4000-8000-000000000003",
    claimToken: "5c1b0003-0000-4000-8000-000000000003",
    jobGeneration: 1,
    targetId: "c1000000-0000-4000-8000-000000000001",
    viewerSocialAccountId: "a1000000-0000-4000-8000-000000000001",
  });

  const permitCall = calls.find((call) =>
    call.name === "authorize_instagram_collection_provider_call"
  )!;

  // The scope of the request is derived from the live fenced job. The call
  // carries the claim and nothing else, so it can never redirect the
  // request to another owner, another target or another viewer.
  assertEquals(
    Object.keys(permitCall.args).sort(),
    ["p_claim_token", "p_job_generation", "p_job_id"],
  );
});

Deno.test("the store refuses a receipt the new SQL could not produce", async () => {
  // A receipt without the outcome is not a receipt. The store has to
  // refuse it rather than report an empty success.
  const { rpc } = recorder({
    persist_competitor_collection_result_v2: {
      job_id: "j",
      job_generation: 1,
    },
  });

  const store = createCompetitorServiceStore({ rpc, reads: noReads, writes: noWrites });

  let threw = false;
  try {
    await store.persistResult({
      jobId: "j",
      claimToken: "t",
      jobGeneration: 1,
      payload: {
        outcome: "completed",
        source: "official",
        profile: { metrics: {} },
        media: [],
        coverage: COVERAGE_PAYLOAD,
      },
    });
  } catch {
    threw = true;
  }

  assertEquals(threw, true);
});
