/**
 * The SQL adapter of the owner daily dispatch.
 *
 * WHAT THIS SUITE COVERS
 *
 *   1. the call: the accepted RPC name, the target kind and the start
 *      marker, and nothing else;
 *   2. the accepted receipt: the closed key set, the values inside the
 *      SQL's own domain, and the agreement of the receipt with itself;
 *   3. the refusal receipt: the closed reason set;
 *   4. the failures: a driver error, a transport failure, a missing
 *      function and a malformed envelope. Every one of them is a FAILURE,
 *      never a completion and never an empty page.
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createOwnerDailyEnqueueStore,
  OWNER_DAILY_PAGE_LIMIT,
  OWNER_DAILY_TARGET_KIND,
  OwnerDailyEnqueueStoreError,
} from "./dailyEnqueueStore.ts";

interface RecordedCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

function acceptedReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accepted: true,
    target_kind: "owner",
    captured_on: "2026-10-30",
    sweep_status: "pending",
    enqueued: 25,
    has_more: true,
    page_limit: OWNER_DAILY_PAGE_LIMIT,
    scanned: 25,
    started: true,
    resumed: false,
    ...overrides,
  };
}

function refusedReceipt(reason: unknown = "collection_disabled"): Record<string, unknown> {
  return {
    accepted: false,
    refused: true,
    reason_code: reason,
    target_kind: "owner",
    captured_on: "2026-10-30",
  };
}

function createCaller(envelope: unknown) {
  const calls: RecordedCall[] = [];
  const caller = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    calls.push({ name, args });
    return envelope;
  };
  return { calls, caller };
}

function store(caller: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  return createOwnerDailyEnqueueStore(caller);
}

async function failureOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof OwnerDailyEnqueueStoreError) return error.failure;
    return "not-a-store-error";
  }
  return "no-error";
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

Deno.test("the daily page names the kind and the start marker, and nothing else", async () => {
  const { calls, caller } = createCaller({ data: acceptedReceipt(), error: null });
  const daily = store(caller);

  await daily.enqueueDailyPage({ start: true, signal: new AbortController().signal });

  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.name, "enqueue_instagram_collection_daily_page");
  assertEquals(calls[0]!.args, {
    p_target_kind: OWNER_DAILY_TARGET_KIND,
    p_start: true,
  });
});

Deno.test("the resume asks the statement to resume, never to start", async () => {
  const { calls, caller } = createCaller({
    data: acceptedReceipt({ started: false, resumed: true, sweep_status: "pending" }),
    error: null,
  });
  const daily = store(caller);

  await daily.enqueueDailyPage({ start: false, signal: new AbortController().signal });

  assertEquals(calls[0]!.args.p_start, false);
});

// ---------------------------------------------------------------------------
// The accepted receipt
// ---------------------------------------------------------------------------

Deno.test("the accepted receipt is parsed into its typed projection", async () => {
  const { caller } = createCaller({ data: acceptedReceipt(), error: null });
  const daily = store(caller);

  const outcome = await daily.enqueueDailyPage({
    start: true,
    signal: new AbortController().signal,
  });

  assertEquals(outcome.kind, "accepted");
  if (outcome.kind !== "accepted") return;

  assertEquals(outcome.receipt.targetKind, "owner");
  assertEquals(outcome.receipt.capturedOn, "2026-10-30");
  assertEquals(outcome.receipt.sweepStatus, "pending");
  assertEquals(outcome.receipt.enqueued, 25);
  assertEquals(outcome.receipt.hasMore, true);
  assertEquals(outcome.receipt.pageLimit, OWNER_DAILY_PAGE_LIMIT);
  assertEquals(outcome.receipt.scanned, 25);
  assertEquals(outcome.receipt.started, true);
  assertEquals(outcome.receipt.resumed, false);
});

Deno.test("a receipt with an extra or a missing key is not this contract's receipt", async () => {
  const withExtra = acceptedReceipt({ lease_token: "a-lease" });
  const withoutEnqueued = acceptedReceipt();
  delete withoutEnqueued.enqueued;

  for (const data of [withExtra, withoutEnqueued]) {
    const { caller } = createCaller({ data, error: null });
    const daily = store(caller);

    assertEquals(
      await failureOf(() =>
        daily.enqueueDailyPage({ start: true, signal: new AbortController().signal })
      ),
      "rpc_failed",
    );
  }
});

Deno.test("a receipt outside the SQL's own domain is refused", async () => {
  const cases: Array<Record<string, unknown>> = [
    acceptedReceipt({ target_kind: "competitor" }),
    acceptedReceipt({ captured_on: "2026-13-30" }),
    acceptedReceipt({ captured_on: "not-a-date" }),
    acceptedReceipt({ sweep_status: "unknown" }),
    acceptedReceipt({ enqueued: -1 }),
    acceptedReceipt({ enqueued: 1.5 }),
    acceptedReceipt({ has_more: "yes" }),
    acceptedReceipt({ page_limit: 50 }),
    acceptedReceipt({ scanned: 26 }),
    acceptedReceipt({ started: 1 }),
    acceptedReceipt({ started: true, resumed: true }),
    acceptedReceipt({ sweep_status: "completed", has_more: true }),
    acceptedReceipt({ sweep_status: "pending", has_more: false }),
  ];

  for (const data of cases) {
    const { caller } = createCaller({ data, error: null });
    const daily = store(caller);

    assertEquals(
      await failureOf(() =>
        daily.enqueueDailyPage({ start: true, signal: new AbortController().signal })
      ),
      "rpc_failed",
      JSON.stringify(data),
    );
  }
});

Deno.test("a receipt that carries an accessor is refused without running it", async () => {
  let ran = false;
  const data = acceptedReceipt() as Record<string, unknown>;
  Object.defineProperty(data, "enqueued", {
    enumerable: true,
    get() {
      ran = true;
      return 1;
    },
  });

  const { caller } = createCaller({ data, error: null });
  const daily = store(caller);

  assertEquals(
    await failureOf(() =>
      daily.enqueueDailyPage({ start: true, signal: new AbortController().signal })
    ),
    "rpc_failed",
  );
  assertEquals(ran, false, "the accessor must never be invoked");
});

Deno.test("an inherited property is not authority", async () => {
  const parent = { enqueued: 5 };
  const data = Object.create(parent) as Record<string, unknown>;
  Object.assign(data, acceptedReceipt());
  delete (data as Record<string, unknown>).enqueued;

  const { caller } = createCaller({ data, error: null });
  const daily = store(caller);

  assertEquals(
    await failureOf(() =>
      daily.enqueueDailyPage({ start: true, signal: new AbortController().signal })
    ),
    "rpc_failed",
  );
});

// ---------------------------------------------------------------------------
// The refusal receipt
// ---------------------------------------------------------------------------

Deno.test("a refusal of the configuration is a decision, not a failure", async () => {
  for (const reason of ["collection_disabled", "settings_unavailable"]) {
    const { caller } = createCaller({ data: refusedReceipt(reason), error: null });
    const daily = store(caller);

    const outcome = await daily.enqueueDailyPage({
      start: true,
      signal: new AbortController().signal,
    });

    assertEquals(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    assertEquals(outcome.reason, reason);
    assertEquals(outcome.capturedOn, "2026-10-30");
  }
});

Deno.test("an unknown refusal reason is not a refusal this contract knows", async () => {
  const { caller } = createCaller({ data: refusedReceipt("collection_not_eligible"), error: null });
  const daily = store(caller);

  assertEquals(
    await failureOf(() =>
      daily.enqueueDailyPage({ start: true, signal: new AbortController().signal })
    ),
    "rpc_failed",
  );
});

// ---------------------------------------------------------------------------
// The failures
// ---------------------------------------------------------------------------

Deno.test("a missing function is unavailable, never a completion", async () => {
  const { caller } = createCaller({
    data: null,
    error: { code: "PGRST202", message: "the function is not deployed" },
  });
  const daily = store(caller);

  assertEquals(
    await failureOf(() =>
      daily.enqueueDailyPage({ start: true, signal: new AbortController().signal })
    ),
    "schema_unavailable",
  );
});

Deno.test("a refused role is a failure of the caller", async () => {
  const { caller } = createCaller({
    data: null,
    error: { code: "42501", message: "permission denied" },
  });
  const daily = store(caller);

  assertEquals(
    await failureOf(() =>
      daily.enqueueDailyPage({ start: true, signal: new AbortController().signal })
    ),
    "forbidden",
  );
});

Deno.test("any other driver error is an indeterminate failure", async () => {
  const { caller } = createCaller({
    data: null,
    error: { code: "57014", message: "statement timeout" },
  });
  const daily = store(caller);

  assertEquals(
    await failureOf(() =>
      daily.enqueueDailyPage({ start: true, signal: new AbortController().signal })
    ),
    "rpc_failed",
  );
});

Deno.test("a thrown transport failure is a failure, never an empty page", async () => {
  const daily = store(async () => {
    throw new Error("the transport failed");
  });

  assertEquals(
    await failureOf(() =>
      daily.enqueueDailyPage({ start: true, signal: new AbortController().signal })
    ),
    "rpc_failed",
  );
});

Deno.test("a malformed envelope is a failure", async () => {
  for (const envelope of ["not-an-envelope", null, 42, { data: acceptedReceipt() }]) {
    const { caller } = createCaller(envelope);
    const daily = store(caller);

    assertEquals(
      await failureOf(() =>
        daily.enqueueDailyPage({ start: true, signal: new AbortController().signal })
      ),
      "rpc_failed",
    );
  }
});

Deno.test("the store error never carries the driver text", async () => {
  const { caller } = createCaller({
    data: null,
    error: { code: "P0001", message: "IG_COLLECTION_SECRET: a secret detail" },
  });
  const daily = store(caller);

  const error = await assertRejects(
    () => daily.enqueueDailyPage({ start: true, signal: new AbortController().signal }),
    OwnerDailyEnqueueStoreError,
  );

  assert(
    !error.message.includes("IG_COLLECTION_SECRET"),
    "the driver text must never reach the error",
  );
  assert(!("sqlstate" in error), "the error carries a stable failure kind, not a SQLSTATE");
});
