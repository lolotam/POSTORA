/**
 * The database adapter of the competitor tracking report.
 *
 * WHAT THIS SUITE PROVES
 *
 *   - The read runs as the CALLER: the verified bearer is forwarded
 *     unchanged, and the adapter never holds a token of its own.
 *   - The request carries exactly the keys the action allows.
 *   - A failed read is a FAILURE, never an empty payload, and the driver
 *     message never reaches the caller.
 *   - The stable SQL identifiers map onto the stable failure kinds.
 *   - A malformed projection is refused.
 *   - The payload the real database returned is accepted.
 */

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CompetitorReportContractError,
  type CompetitorReportRequest,
} from "./contracts.ts";
import {
  COMPETITOR_REPORT_RPC,
  CompetitorReportStore,
  CompetitorReportStoreError,
  type CompetitorReportRpcCaller,
} from "./reportStore.ts";

const BEARER = "synthetic.owner.bearer";
const WATCHLIST_ID = "d2000000-0000-4000-8000-000000000001";

const here = dirname(fileURLToPath(import.meta.url));
const CAPTURED_FIXTURE = join(here, "fixtures", "captured-report.json");

interface RpcCall {
  readonly functionName: string;
  readonly args: Record<string, unknown>;
  readonly bearer: string;
}

function listRequest(): CompetitorReportRequest {
  return { action: "list", state: "active", limit: 20, cursor: null };
}

function detailRequest(): CompetitorReportRequest {
  return {
    action: "detail",
    watchlistId: WATCHLIST_ID,
    periodDays: 7,
    limit: 20,
    cursor: null,
  };
}

/** A projection the reader accepts. */
function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    action: "list",
    as_of: "2026-10-30T11:59:59.123456+00:00",
    capture_timezone: "Asia/Kuwait",
    quota: {
      max_tracked_competitors: 20,
      unlimited: false,
      tracked_active: 3,
      remaining: 17,
    },
    next_cursor: null,
    entries: [],
    entry: null,
    media: [],
    ...overrides,
  };
}

function storeReturning(
  envelope: unknown,
  calls: RpcCall[] = [],
): { store: CompetitorReportStore; calls: RpcCall[] } {
  const rpc: CompetitorReportRpcCaller = async (functionName, args, bearer) => {
    calls.push({ functionName, args, bearer });
    return envelope;
  };
  return { store: new CompetitorReportStore(rpc), calls };
}

Deno.test("the read runs as the caller: the bearer is forwarded unchanged", async () => {
  const calls: RpcCall[] = [];
  const { store } = storeReturning({ data: projection(), error: null }, calls);

  await store.readReportInput(listRequest(), BEARER);

  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.functionName, COMPETITOR_REPORT_RPC);
  assertEquals(calls[0]!.bearer, BEARER);
  assert(calls[0]!.bearer !== "");
});

Deno.test("the list request carries only the keys the action allows", async () => {
  const calls: RpcCall[] = [];
  const { store } = storeReturning({ data: projection(), error: null }, calls);

  await store.readReportInput(listRequest(), BEARER);

  const request = calls[0]!.args.p_request as Record<string, unknown>;
  assertEquals(request.action, "list");
  assertEquals(request.state, "active");
  assertEquals(request.limit, 20);
  assertEquals("watchlist_id" in request, false);
  assertEquals("period_days" in request, false);
  assertEquals("cursor" in request, false);
});

Deno.test("the detail request carries only the keys the action allows", async () => {
  const calls: RpcCall[] = [];
  const { store } = storeReturning(
    { data: projection({ action: "detail", entry: { watchlist_id: WATCHLIST_ID } }), error: null },
    calls,
  );

  await store.readReportInput(detailRequest(), BEARER);

  const request = calls[0]!.args.p_request as Record<string, unknown>;
  assertEquals(request.action, "detail");
  assertEquals(request.watchlist_id, WATCHLIST_ID);
  assertEquals(request.period_days, 7);
  assertEquals("state" in request, false);
});

Deno.test("a cursor is forwarded and an absent cursor is not", async () => {
  const calls: RpcCall[] = [];
  const { store } = storeReturning({ data: projection(), error: null }, calls);

  await store.readReportInput(
    { action: "list", state: "active", limit: 20, cursor: "abc" },
    BEARER,
  );

  const request = calls[0]!.args.p_request as Record<string, unknown>;
  assertEquals(request.cursor, "abc");
});

Deno.test("a failed read is a failure and never an empty payload", async () => {
  const { store } = storeReturning({
    data: null,
    error: { code: "PGRST116", message: "no rows" },
  });

  await assertRejects(
    () => store.readReportInput(listRequest(), BEARER),
    CompetitorReportStoreError,
  );
});

Deno.test("a missing error is a malformed envelope and not a completed read", async () => {
  const { store } = storeReturning({ data: projection() });

  const error = await assertRejects(
    () => store.readReportInput(listRequest(), BEARER),
    CompetitorReportStoreError,
  );
  // A missing error is a MALFORMED envelope, not a driver refusal: it is not
  // classified by a SQLSTATE it does not have.
  assertEquals(error.failure, "read_failed");
  assertEquals(error.sqlstate, null);
});

Deno.test("a completed read without a payload is a failure", async () => {
  const { store } = storeReturning({ data: null, error: null });

  await assertRejects(
    () => store.readReportInput(listRequest(), BEARER),
    CompetitorReportStoreError,
  );
});

Deno.test("the stable SQL identifiers map onto the stable failure kinds", async () => {
  const cases: Array<[string, string]> = [
    ["COMPETITOR_REPORT_NOT_FOUND", "not_found"],
    ["COMPETITOR_REPORT_INVALID_REQUEST", "invalid"],
    ["COMPETITOR_REPORT_INVALID_CURSOR", "invalid"],
    ["COMPETITOR_REPORT_UNAUTHENTICATED", "forbidden"],
  ];

  for (const [identifier, failure] of cases) {
    const { store } = storeReturning({
      data: null,
      error: { code: "22023", message: `${identifier}: the detail of the refusal` },
    });

    const error = await assertRejects(
      () => store.readReportInput(listRequest(), BEARER),
      CompetitorReportStoreError,
    );
    assertEquals(error.failure, failure);
    // The driver message never reaches the caller.
    assertEquals(error.message.includes(identifier), false);
    assertEquals(error.message.includes("the detail of the refusal"), false);
  }
});

Deno.test("an unknown identifier is a read failure and never a refusal", async () => {
  const { store } = storeReturning({
    data: null,
    error: { code: "08006", message: "connection failure" },
  });

  const error = await assertRejects(
    () => store.readReportInput(listRequest(), BEARER),
    CompetitorReportStoreError,
  );
  assertEquals(error.failure, "read_failed");
});

Deno.test("an undeployed reader is unavailable and not an empty report", async () => {
  const { store } = storeReturning({
    data: null,
    error: { code: "PGRST202", message: "function is not defined" },
  });

  const error = await assertRejects(
    () => store.readReportInput(listRequest(), BEARER),
    CompetitorReportStoreError,
  );
  assertEquals(error.failure, "unavailable");
});

Deno.test("a malformed projection is refused", async () => {
  const cases: unknown[] = [
    "not an object",
    projection({ version: 2 }),
    projection({ action: "detail" }),
    projection({ as_of: 42 }),
    projection({ capture_timezone: "" }),
    projection({ quota: "none" }),
    projection({ next_cursor: 42 }),
    projection({ entries: "none" }),
    projection({ media: "none" }),
  ];

  for (const payload of cases) {
    const { store } = storeReturning({ data: payload, error: null });
    await assertRejects(
      () => store.readReportInput(listRequest(), BEARER),
      CompetitorReportContractError,
    );
  }
});

Deno.test("a detail read that answers another entry is refused", async () => {
  const { store } = storeReturning({
    data: projection({ action: "detail", entry: { watchlist_id: "d2000000-0000-4000-8000-0000000000ff" } }),
    error: null,
  });

  await assertRejects(
    () => store.readReportInput(detailRequest(), BEARER),
    CompetitorReportContractError,
  );
});

Deno.test("a detail read without an entry is refused", async () => {
  const { store } = storeReturning({
    data: projection({ action: "detail", entry: null }),
    error: null,
  });

  await assertRejects(
    () => store.readReportInput(detailRequest(), BEARER),
    CompetitorReportContractError,
  );
});

Deno.test("a list read that carries an entry is refused", async () => {
  const { store } = storeReturning({
    data: projection({ entry: { watchlist_id: WATCHLIST_ID } }),
    error: null,
  });

  await assertRejects(
    () => store.readReportInput(listRequest(), BEARER),
    CompetitorReportContractError,
  );
});

Deno.test("an oversized cursor is refused", async () => {
  const { store } = storeReturning({
    data: projection({ next_cursor: "a".repeat(2049) }),
    error: null,
  });

  await assertRejects(
    () => store.readReportInput(listRequest(), BEARER),
    CompetitorReportContractError,
  );
});

Deno.test("the captured payload of the real database is accepted", async () => {
  const captured = JSON.parse(await Deno.readTextFile(CAPTURED_FIXTURE));

  const { store } = storeReturning({ data: captured, error: null });
  const projectionRead = await store.readReportInput(
    {
      action: "detail",
      watchlistId: captured.entry.watchlist_id,
      periodDays: 7,
      limit: 20,
      cursor: null,
    },
    BEARER,
  );

  assertEquals(projectionRead.version, 1);
  assertEquals(projectionRead.action, "detail");
  assertEquals(projectionRead.entry?.watchlist_id, captured.entry.watchlist_id);
  assert(Array.isArray(projectionRead.media));
});

Deno.test("the captured payload of the real database carries no credential", async () => {
  const raw = await Deno.readTextFile(CAPTURED_FIXTURE);

  assertEquals(raw.includes("lease_token"), false);
  assertEquals(raw.includes("claim_token"), false);
  assertEquals(raw.includes("context_viewer"), false);
  assertEquals(raw.includes("credential_generation"), false);
  assertEquals(raw.includes("Bearer"), false);
  assertEquals(raw.includes("service_role"), false);
});
