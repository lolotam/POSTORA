/**
 * The SQL adapter of the competitor retention function.
 *
 * WHAT THIS SUITE PROVES
 *
 *   - the adapter calls EXACTLY one RPC and passes EXACTLY three arguments:
 *     the parent limit, the child limit and the dry-run flag. There is no
 *     owner, no cutoff, no time and no id;
 *   - a database error is a failure, never an empty slice;
 *   - an unknown or malformed payload is refused, not coerced;
 *   - the audit row is written through the shared logger with counts and
 *     reasons only, and never with a caption, a url, a handle or a secret.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createCompetitorRetentionPorts, parseRetentionSlice, type RetentionDatabase } from "./deps.ts";

interface RpcCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface InsertCall {
  readonly table: string;
  readonly row: Record<string, unknown>;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    switch_state: "enabled",
    dry_run: false,
    now_at: "2026-10-30T00:00:00.000Z",
    cutoff_at: "2026-07-31T00:00:00.000Z",
    parents_considered: 2,
    parents_deleted: 1,
    parents_projected: 1,
    parents_skipped_live_lease: 0,
    parents_skipped_ineligible: 1,
    child_counts: {
      competitor_media_snapshots: 3,
      competitor_profile_snapshots: 1,
      competitor_capture_coverage: 0,
      instagram_collection_job_operations: 0,
      instagram_collection_job_checkpoints: 0,
      instagram_collection_jobs: 1,
      instagram_collection_request_throttles: 0,
    },
    children_counted: 5,
    children_deleted: 5,
    has_more: false,
    ...overrides,
  };
}

/**
 * The test double.
 *
 * It implements exactly the two calls the adapter makes, which is what the
 * adapter's port asks for. Nothing of the SDK's own type is reproduced, so
 * the double cannot drift into pretending to be more than it is.
 */
function fakeClient(options: {
  rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown };
}): { client: RetentionDatabase; rpcCalls: RpcCall[]; inserts: InsertCall[] } {
  const rpcCalls: RpcCall[] = [];
  const inserts: InsertCall[] = [];
  const client: RetentionDatabase = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (options.rpc) return Promise.resolve(options.rpc(name, args));
      return Promise.resolve({ data: validPayload(), error: null });
    },
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, rpcCalls, inserts };
}

Deno.test("the adapter calls the batch RPC with exactly the three allowed arguments", async () => {
  const { client, rpcCalls } = fakeClient({});
  const ports = createCompetitorRetentionPorts(client);

  const outcome = await ports.runBatch({ parentLimit: 50, childLimit: 500, dryRun: false });

  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0].name, "run_competitor_retention_batch");
  assertEquals(Object.keys(rpcCalls[0].args).sort(), ["p_child_limit", "p_dry_run", "p_parent_limit"]);
  assertEquals(rpcCalls[0].args, {
    p_parent_limit: 50,
    p_child_limit: 500,
    p_dry_run: false,
  });
  assertEquals(outcome.ok, true);
});

Deno.test("the adapter never sends an owner, a cutoff or a time", async () => {
  const { client, rpcCalls } = fakeClient({});
  const ports = createCompetitorRetentionPorts(client);

  await ports.runBatch({ parentLimit: 7, childLimit: 11, dryRun: true });

  const serialised = JSON.stringify(rpcCalls[0].args).toLowerCase();
  for (const forbidden of ["owner", "user_id", "cutoff", "removed_at", "since", "until", "watchlist_id"]) {
    assert(
      !serialised.includes(forbidden),
      `the request must not carry ${forbidden}: ${serialised}`,
    );
  }
});

Deno.test("a database error is a failure, never an empty slice", async () => {
  const { client } = fakeClient({
    rpc: () => ({ data: null, error: { message: "relation does not exist" } }),
  });
  const ports = createCompetitorRetentionPorts(client);

  const outcome = await ports.runBatch({ parentLimit: 50, childLimit: 500, dryRun: false });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.ok === false && outcome.reason, "rpc_failed");
});

Deno.test("a payload that is not the expected shape is refused", () => {
  const withoutFlag = validPayload();
  delete withoutFlag.dry_run;
  const withoutHasMore = validPayload();
  delete withoutHasMore.has_more;
  const withoutCounts = validPayload();
  delete withoutCounts.child_counts;
  const withoutDeleted = validPayload();
  delete withoutDeleted.children_deleted;

  const refused: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "enabled"],
    ["an array", []],
    ["a number", 7],
    ["an unknown switch state", validPayload({ switch_state: "on" })],
    ["a null switch state", validPayload({ switch_state: null })],
    ["a numeric switch state", validPayload({ switch_state: 1 })],
    ["a string dry-run flag", validPayload({ dry_run: "false" })],
    ["a null dry-run flag", validPayload({ dry_run: null })],
    ["a missing dry-run flag", withoutFlag],
    ["a missing has_more flag", withoutHasMore],
    ["a missing child_counts object", withoutCounts],
    ["a missing children_deleted count", withoutDeleted],
    ["a negative count", validPayload({ parents_deleted: -1 })],
    ["a fractional count", validPayload({ parents_deleted: 1.5 })],
    ["a string count", validPayload({ children_counted: "5" })],
    ["a null count", validPayload({ children_deleted: null })],
    ["an array child_counts", validPayload({ child_counts: [] })],
  ];

  for (const [label, payload] of refused) {
    assertEquals(parseRetentionSlice(payload), null, `the parser refused ${label}`);
  }
});

Deno.test("a valid payload is parsed into the typed slice", () => {
  const parsed = parseRetentionSlice(validPayload());
  assert(parsed !== null);
  assertEquals(parsed.switchState, "enabled");
  assertEquals(parsed.dryRun, false);
  assertEquals(parsed.parentsConsidered, 2);
  assertEquals(parsed.parentsDeleted, 1);
  assertEquals(parsed.parentsProjected, 1);
  assertEquals(parsed.parentsSkippedLiveLease, 0);
  assertEquals(parsed.parentsSkippedIneligible, 1);
  assertEquals(parsed.childrenCounted, 5);
  assertEquals(parsed.childrenDeleted, 5);
  assertEquals(parsed.hasMore, false);
});

Deno.test("a malformed payload reported by the database is a malformed response", async () => {
  const { client } = fakeClient({
    rpc: () => ({ data: { switch_state: "enabled" }, error: null }),
  });
  const ports = createCompetitorRetentionPorts(client);

  const outcome = await ports.runBatch({ parentLimit: 50, childLimit: 500, dryRun: false });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.ok === false && outcome.reason, "malformed_response");
});

Deno.test("the audit row carries counts and reasons only", async () => {
  const { client, inserts } = fakeClient({});
  const ports = createCompetitorRetentionPorts(client);

  await ports.logAudit({
    event: "retention_run",
    outcome: "completed",
    reason: "completed",
    dry_run: false,
    switch_state: "enabled",
    slices: 1,
    parents_processed: 2,
    parents_deleted: 1,
    children_counted: 5,
    children_deleted: 5,
    has_more: false,
    duration_ms: 12,
  });

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.source, "competitor-retention");
  assertEquals(inserts[0].row.level, "info");

  const metadata = inserts[0].row.metadata as Record<string, unknown>;
  assertEquals(metadata.reason, "completed");
  assertEquals(metadata.parents_deleted, 1);
  assertEquals(metadata.children_deleted, 5);

  const serialised = JSON.stringify(inserts[0].row);
  for (const forbidden of ["caption", "url", "username", "handle", "Bearer", "token", "secret"]) {
    assert(
      !serialised.toLowerCase().includes(forbidden.toLowerCase()),
      `the audit row must not carry ${forbidden}: ${serialised}`,
    );
  }
});

Deno.test("a failed run is audited as a failure, not as an info row", async () => {
  const { client, inserts } = fakeClient({});
  const ports = createCompetitorRetentionPorts(client);

  await ports.logAudit({
    event: "retention_run",
    outcome: "failed",
    reason: "rpc_failed",
    dry_run: false,
    switch_state: "unknown",
    slices: 1,
    parents_processed: 0,
    parents_deleted: 0,
    children_counted: 0,
    children_deleted: 0,
    has_more: false,
    duration_ms: 12,
  });

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.level, "error");
});
