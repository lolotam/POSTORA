import { assertEquals } from "jsr:@std/assert@1";
import {
  cancelScheduledPost,
  checkAccountHealth,
  computePostingHistogram,
  deletePost,
  handleCancelScheduledPost,
  handleDeletePost,
  handleReschedulePost,
  handleRetryFailedPost,
  handleSuggestBestTimes,
  isBestTimeSuggestion,
  reschedulePost,
  retryFailedPost,
  suggestBestTimes,
  type PostActionDeps,
} from "./postActions.ts";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const USER = "11111111-1111-4111-8111-111111111111";
const POST = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_TWO = "44444444-4444-4444-8444-444444444444";
const CLAIM = "55555555-5555-4555-8555-555555555555";
const MEDIA = "66666666-6666-4666-8666-666666666666";
const SERVICE_KEY = "service-role-key";
const SUPABASE_URL = "https://api.postora.cloud";
const SCHEDULED_STATUSES = ["scheduled", "pending"];
// The two database functions the cancel and the reschedule write through.
const CANCEL_RPC = "mcp_cancel_scheduled_post";
const RESCHEDULE_RPC = "mcp_reschedule_post";
// The two database functions the retry takes and gives back its lease through.
const CLAIM_RPC = "mcp_claim_post_action";
const RELEASE_RPC = "mcp_release_post_action";
// The database function that deletes the post row while the claim is held.
const DELETE_CLAIMED_RPC = "mcp_delete_claimed_post";

// ── fake Supabase ──────────────────────────────────────────────────────────────

interface FakeResult {
  data: unknown;
  // The shape a PostgREST error carries: the SQLSTATE in `code` and the
  // DETAIL in `details`.
  error: {
    message: string;
    code?: string;
    details?: string;
    detail?: string;
  } | null;
}

interface RecordedCall {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  filters: Array<[string, ...unknown[]]>;
  /** The select columns for a select, the data object for an insert/update. */
  payload: unknown;
  /**
   * The order in which the call was made, counted over every table call and
   * every RPC. Two calls can therefore be compared: the delete of the post
   * row and the delete of the media that follows it.
   */
  order: number;
}

// One call to a database function: the name and the arguments it was called
// with. The writes of the cancel and the reschedule go through one RPC each,
// so the recorded calls are how a test sees which write actually happened.
interface RecordedRpc {
  name: string;
  args: Record<string, unknown>;
  order: number;
}

class FakeBuilder {
  private op: RecordedCall["op"] = "select";
  private readonly filters: Array<[string, ...unknown[]]> = [];
  private payload: unknown = undefined;
  private settled = false;

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
  ) {}

  select(columns: string): this {
    if (this.op === "select") this.payload = columns;
    return this;
  }

  insert(payload: unknown): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: unknown): this {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.filter("eq", column, value);
  }

  neq(column: string, value: unknown): this {
    return this.filter("neq", column, value);
  }

  in(column: string, values: unknown): this {
    return this.filter("in", column, values);
  }

  gt(column: string, value: unknown): this {
    return this.filter("gt", column, value);
  }

  not(column: string, operator: unknown, value: unknown): this {
    return this.filter("not", column, operator, value);
  }

  order(column: string, options: unknown): this {
    return this.filter("order", column, options);
  }

  limit(count: number): this {
    return this.filter("limit", count);
  }

  private filter(method: string, ...args: unknown[]): this {
    this.filters.push([method, ...args] as [string, ...unknown[]]);
    return this;
  }

  private resolve(): FakeResult {
    if (this.settled) throw new Error("the query was already resolved");
    this.settled = true;
    this.db.record({
      table: this.table,
      op: this.op,
      filters: [...this.filters],
      payload: this.payload,
    });
    return this.db.take(this.table);
  }

  maybeSingle(): Promise<FakeResult> {
    return Promise.resolve(this.resolve());
  }

  then(
    onfulfilled?: (value: FakeResult) => unknown,
    onrejected?: (reason: unknown) => unknown,
  ): Promise<unknown> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

class FakeSupabase {
  readonly calls: RecordedCall[] = [];
  readonly rpcCalls: RecordedRpc[] = [];
  /** The files that were removed from the storage, and when. */
  readonly storageRemovals: Array<{ bucket: string; paths: string[]; order: number }> = [];
  private readonly queues = new Map<string, FakeResult[]>();
  private readonly rpcQueues = new Map<string, FakeResult[]>();
  private counter = 0;

  queue(table: string, result: FakeResult): this {
    const list = this.queues.get(table) ?? [];
    list.push(result);
    this.queues.set(table, list);
    return this;
  }

  /**
   * Queues the answer of one database function call. The queue is per
   * function name, so a test can say what each of the RPCs answers without
   * caring in which order they are called.
   */
  queueRpc(name: string, result: FakeResult): this {
    const list = this.rpcQueues.get(name) ?? [];
    list.push(result);
    this.rpcQueues.set(name, list);
    return this;
  }

  from(table: string): FakeBuilder {
    return new FakeBuilder(this, table);
  }

  rpc(name: string, args: Record<string, unknown>): Promise<FakeResult> {
    this.rpcCalls.push({ name, args, order: this.counter++ });
    const list = this.rpcQueues.get(name);
    if (!list || list.length === 0) {
      throw new Error(`no queued rpc result for ${name}`);
    }
    return Promise.resolve(list.shift() as FakeResult);
  }

  take(table: string): FakeResult {
    const list = this.queues.get(table);
    if (!list || list.length === 0) {
      // A refusal writes its durable row without the test having to queue one:
      // the row is the record of the refusal, not a result the test reads. A
      // test that needs the write to fail queues an error for it.
      if (table === "system_logs") return { data: null, error: null };
      throw new Error(`no queued result for table ${table}`);
    }
    return list.shift() as FakeResult;
  }

  record(call: Omit<RecordedCall, "order">): void {
    this.calls.push({ ...call, order: this.counter++ });
  }

  /** The storage the media delete removes the files from. */
  readonly storage = {
    from: (bucket: string) => ({
      remove: (paths: string[]) => {
        this.storageRemovals.push({ bucket, paths, order: this.counter++ });
        return Promise.resolve({ error: null });
      },
    }),
  };
}

// ── fake fetcher ───────────────────────────────────────────────────────────────

interface RecordedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface QueuedResponse {
  status?: number;
  body?: unknown;
  reject?: Error;
}

// `onRequest` runs just before the request leaves, so a test can see how many
// database calls had already been made when the call went out.
function fakeFetcher(responses: QueuedResponse[] = [], onRequest?: () => void) {
  const calls: RecordedFetch[] = [];
  const queue = [...responses];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    onRequest?.();
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : String((input as Request).url);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw) {
      if (raw instanceof Headers) {
        raw.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(raw)) {
        for (const [key, value] of raw) headers[key] = value;
      } else {
        Object.assign(headers, raw as Record<string, string>);
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    if (next.reject) throw next.reject;
    const status = next.status ?? 200;
    const payload = status === 204 || next.body === undefined
      ? null
      : JSON.stringify(next.body);
    return new Response(payload, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

// A fetcher that answers with a body that is not JSON at all, so the caller
// has to cope with a 2xx whose body cannot be parsed.
function rawBodyFetcher(status: number, rawBody: string): typeof fetch {
  return (() =>
    Promise.resolve(new Response(rawBody, {
      status,
      headers: { "Content-Type": "application/json" },
    }))) as unknown as typeof fetch;
}

// A fetcher that fails loudly if a test that expects no network call makes one.
function noNetwork(): typeof fetch {
  return (() =>
    Promise.reject(new Error("this test must not reach the network"))) as unknown as typeof fetch;
}

// A fetcher whose headers arrive and whose body never does: the stream is
// opened and nothing is ever enqueued into it, so reading the body waits for
// an answer that never comes. The stream records that it was cancelled, so a
// test can tell whether the connection was released after the deadline.
function stalledBodyFetcher(): {
  fetcher: typeof fetch;
  wasCancelled: () => boolean;
} {
  const state = { cancelled: false };
  const fetcher = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          pull() {
            // Nothing is enqueued and the pull never finishes, so the body
            // never arrives.
            return new Promise<void>(() => {});
          },
          cancel() {
            state.cancelled = true;
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as unknown as typeof fetch;
  return { fetcher, wasCancelled: () => state.cancelled };
}

// A fetcher that answers with a body that arrives in more than one chunk, so
// the body has to be read in full and not only up to the end of the first
// chunk.
function chunkedBodyFetcher(chunks: string[]): typeof fetch {
  const encoder = new TextEncoder();
  return (() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as unknown as typeof fetch;
}

function depsFor(
  db: FakeSupabase,
  fetcher: typeof fetch,
  now: () => Date = () => NOW,
): PostActionDeps {
  return {
    supabase: db,
    fetcher,
    now,
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_KEY,
  };
}

// A clock that moves while the request runs: the first call is the moment the
// request began, every call after it is the moment the write happens.
function advancingClock(first: Date, later: Date): () => Date {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? first : later;
  };
}

// ── assertions on the recorded queries ─────────────────────────────────────────

function callsFor(
  db: FakeSupabase,
  table: string,
  op?: RecordedCall["op"],
): RecordedCall[] {
  return db.calls.filter((call) =>
    call.table === table && (op === undefined || call.op === op)
  );
}

function hasFilter(
  call: RecordedCall | undefined,
  method: string,
  column: string,
  value: unknown,
): boolean {
  if (!call) return false;
  return call.filters.some((entry) =>
    entry[0] === method && entry[1] === column && entry[2] === value
  );
}

// The call to one database function, if it was called.
function rpcCallFor(db: FakeSupabase, name: string): RecordedRpc | undefined {
  return db.rpcCalls.find((call) => call.name === name);
}

// PostgREST answers PGRST202 when the function is not in the schema cache: the
// migration that creates it has not been applied to this database yet.
function missingRpcError(name: string): NonNullable<FakeResult["error"]> {
  return {
    message: `Could not find the function public.${name} in the schema cache`,
    code: "PGRST202",
  };
}

function hasInFilter(
  call: RecordedCall | undefined,
  column: string,
  values: unknown[],
): boolean {
  if (!call) return false;
  return call.filters.some((entry) =>
    entry[0] === "in" && entry[1] === column &&
    JSON.stringify(entry[2]) === JSON.stringify(values)
  );
}

// The limit is recorded as its own filter: ["limit", count].
function hasLimit(call: RecordedCall | undefined, count: number): boolean {
  if (!call) return false;
  return call.filters.some((entry) => entry[0] === "limit" && entry[1] === count);
}

// The read that was made for one platform.
function readForPlatform(
  db: FakeSupabase,
  platform: string,
): RecordedCall | undefined {
  return callsFor(db, "platform_posts", "select").find((call) =>
    hasFilter(call, "eq", "platform", platform)
  );
}

function errorCode(result: { body: Record<string, unknown> }): string {
  return ((result.body.error as { code?: unknown }).code ?? "") as string;
}

// ── the pinned error shape ─────────────────────────────────────────────────────

Deno.test("the not-found body is exactly the apiError shape", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: null, error: null });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 404);
  assertEquals(result.body, {
    success: false,
    error: { code: "POST_NOT_FOUND", message: "Post not found." },
  });
});

// ── posts/cancel ──────────────────────────────────────────────────────────────

Deno.test("a cancel with a non-uuid post id is refused before the post is read", async () => {
  const db = new FakeSupabase();
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: "not-a-uuid",
  });
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "INVALID_POST_ID");
  // The post is never read or written: the refusal only writes its own row.
  assertEquals(callsFor(db, "posts").length, 0);
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("the cancel read is scoped to the authenticated user", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-22T12:00:00.000Z" },
    error: null,
  });
  db.queueRpc(CANCEL_RPC, { data: true, error: null });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 200);
  const read = callsFor(db, "posts", "select")[0];
  assertEquals(hasFilter(read, "eq", "user_id", USER), true);
  assertEquals(hasFilter(read, "eq", "id", POST), true);
});

Deno.test("a post whose time has come cannot be cancelled", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-20T12:00:00.000Z" },
    error: null,
  });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_NOT_SCHEDULED");
  assertEquals(callsFor(db, "posts", "delete").length, 0);
  // Nothing is written: the post is not cancelled through the database either.
  assertEquals(db.rpcCalls.length, 0);
});

Deno.test("the cancel write is one call to the database", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-22T12:00:00.000Z" },
    error: null,
  });
  db.queueRpc(CANCEL_RPC, { data: true, error: null });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 200);
  // The compare-and-set against the scheduler and the deadline live in the
  // database now: one call, carrying the owner and the post.
  assertEquals(db.rpcCalls.length, 1);
  assertEquals(db.rpcCalls[0].name, CANCEL_RPC);
  assertEquals(db.rpcCalls[0].args, { p_user_id: USER, p_post_id: POST });
  // The function does not delete the row itself any more.
  assertEquals(callsFor(db, "posts", "delete").length, 0);
  assertEquals(result.body, {
    success: true,
    post_id: POST,
    cancelled: true,
  });
});

Deno.test("a cancel falls back to the app-clock delete while the function is missing", async () => {
  const db = new FakeSupabase();
  // The post is due in an hour, but the request takes two: by the time the
  // delete goes out the post is overdue, and a deadline taken when the request
  // began would let the delete through anyway.
  const writeTime = new Date("2026-10-21T14:00:00.000Z");
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-21T13:00:00.000Z" },
    error: null,
  });
  // The function is not in the database yet: the route falls back to the path
  // it used before, on the clock of the edge.
  db.queueRpc(CANCEL_RPC, { data: null, error: missingRpcError(CANCEL_RPC) });
  db.queue("posts", { data: [{ id: POST }], error: null });
  const result = await cancelScheduledPost(
    depsFor(db, noNetwork(), advancingClock(NOW, writeTime)),
    USER,
    { post_id: POST },
  );
  assertEquals(result.status, 200);
  const removal = callsFor(db, "posts", "delete")[0];
  // The deadline is the one of the write, not the one of the request.
  assertEquals(hasFilter(removal, "gt", "scheduled_at", writeTime.toISOString()), true);
  assertEquals(hasFilter(removal, "gt", "scheduled_at", NOW_ISO), false);
});

Deno.test("a post that changed while it was being cancelled is a 409", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-22T12:00:00.000Z" },
    error: null,
  });
  // The database deleted no row: the post is no longer scheduled for the
  // future, so the scheduler has it.
  db.queueRpc(CANCEL_RPC, { data: false, error: null });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_STATE_CHANGED");
  // The refusal leaves a durable row behind.
  const rows = callsFor(db, "system_logs", "insert");
  assertEquals(rows.length, 1);
  const row = rows[0].payload as Record<string, unknown>;
  assertEquals((row.metadata as { code: string }).code, "POST_STATE_CHANGED");
});

Deno.test("a cancel of a post that is being published to TikTok is a 409, not a 500", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-22T12:00:00.000Z" },
    error: null,
  });
  // The database refused the delete on purpose: the trigger raises P0001 with
  // the DETAIL 'TIKTOK_REVIEW_POST_LOCKED' while the post is mid-publish.
  const triggerMessage =
    "This TikTok post is being published right now and can't be deleted. Try again in a few minutes.";
  db.queueRpc(CANCEL_RPC, {
    data: null,
    error: {
      message: triggerMessage,
      code: "P0001",
      details: "TIKTOK_REVIEW_POST_LOCKED",
    },
  });
  const { result, logged } = await withCapturedWarn(() =>
    cancelScheduledPost(depsFor(db, noNetwork()), USER, { post_id: POST })
  );
  // A lock is a decision, not a fault: the caller is told what the database
  // said about it.
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_LOCKED");
  // The answer carries the database's own message: the same lock marker covers
  // a transient refusal and a permanent one, and only the trigger knows which
  // one it is.
  assertEquals(
    (result.body.error as { message: string }).message,
    triggerMessage,
  );
  // The refusal leaves a durable row behind: a lock nobody watched still has
  // to leave a trace.
  const rows = callsFor(db, "system_logs", "insert");
  assertEquals(rows.length, 1);
  const row = rows[0].payload as Record<string, unknown>;
  assertEquals((row.metadata as { code: string }).code, "POST_LOCKED");
  // The lock leaves a line behind that names the route and the post.
  assertEquals(
    logged.some((line) => line.includes("posts/cancel") && line.includes(POST)),
    true,
  );
});

Deno.test("a lock that carries no message of its own is answered with a fallback", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-22T12:00:00.000Z" },
    error: null,
  });
  // The lock marker is there, but the database sent no message of its own: the
  // answer still says something, and it does not claim that the refusal is
  // transient.
  db.queueRpc(CANCEL_RPC, {
    data: null,
    error: {
      message: "",
      code: "P0001",
      details: "TIKTOK_REVIEW_POST_LOCKED",
    },
  });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_LOCKED");
  assertEquals(
    (result.body.error as { message: string }).message,
    "This TikTok post can't be changed right now.",
  );
});

Deno.test("a lock whose message is the lock marker itself is answered with a fallback", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-22T12:00:00.000Z" },
    error: null,
  });
  // The marker arrived in the message instead of the DETAIL: it is an internal
  // token, so it is a lock all the same, but it never reaches the caller.
  db.queueRpc(CANCEL_RPC, {
    data: null,
    error: {
      message: "TIKTOK_REVIEW_POST_LOCKED",
      code: "P0001",
    },
  });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_LOCKED");
  assertEquals(
    (result.body.error as { message: string }).message,
    "This TikTok post can't be changed right now.",
  );
  // The internal marker is nowhere in the answer the caller reads.
  assertEquals(
    JSON.stringify(result.body).includes("TIKTOK_REVIEW_POST_LOCKED"),
    false,
  );
});

Deno.test("a cancel with a padded post id queries the trimmed id", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-22T12:00:00.000Z" },
    error: null,
  });
  db.queueRpc(CANCEL_RPC, { data: true, error: null });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: ` ${POST}\n`,
  });
  assertEquals(result.status, 200);
  // The guard validates a trimmed value, so the trimmed value is the one that
  // reaches the query: an untrimmed id is not the uuid the row is stored under.
  const read = callsFor(db, "posts", "select")[0];
  assertEquals(hasFilter(read, "eq", "id", POST), true);
  // The write carries the trimmed id too.
  assertEquals(rpcCallFor(db, CANCEL_RPC)?.args.p_post_id, POST);
  assertEquals(result.body.post_id, POST);
});

// ── posts/reschedule ───────────────────────────────────────────────────────────

Deno.test("a reschedule refuses a body that does not name a usable time", async () => {
  const cases = [
    {
      name: "a scheduled_at without an explicit offset",
      body: { post_id: POST, scheduled_at: "2026-12-01 10:00" },
      code: "INVALID_SCHEDULED_AT",
    },
    {
      name: "a scheduled_at in the past",
      body: { post_id: POST, scheduled_at: "2020-01-01T00:00:00Z" },
      code: "SCHEDULED_AT_IN_PAST",
    },
    {
      // Date.parse reads the thirtieth of February as the second of March, so
      // the post would be published on a day nobody asked for.
      name: "a scheduled_at on a day the calendar does not have",
      body: { post_id: POST, scheduled_at: "2026-02-30T10:00:00Z" },
      code: "INVALID_SCHEDULED_AT",
    },
    {
      name: "a scheduled_at on a day the calendar does not have, with an offset",
      body: { post_id: POST, scheduled_at: "2026-04-31T10:00:00+03:00" },
      code: "INVALID_SCHEDULED_AT",
    },
    {
      // Date.parse reads a date with a trailing Z as midnight, so the post
      // would publish at a moment the caller never asked for.
      name: "a scheduled_at that is a date with a trailing Z",
      body: { post_id: POST, scheduled_at: "2027-01-01Z" },
      code: "INVALID_SCHEDULED_AT",
    },
    {
      // An hour without minutes is not a time: there is no instant to publish
      // at.
      name: "a scheduled_at with an hour but no minutes",
      body: { post_id: POST, scheduled_at: "2027-01-01T10Z" },
      code: "INVALID_SCHEDULED_AT",
    },
  ];

  for (const testCase of cases) {
    const db = new FakeSupabase();
    const result = await reschedulePost(depsFor(db, noNetwork()), USER, testCase.body);
    assertEquals(result.status, 400, testCase.name);
    assertEquals(errorCode(result), testCase.code, testCase.name);
    // The post is never read or written: the refusal only writes its own row.
    assertEquals(callsFor(db, "posts").length, 0, testCase.name);
    assertEquals(callsFor(db, "system_logs", "insert").length, 1, testCase.name);
  }
});

Deno.test("a reschedule accepts an instant that has a real calendar date and an offset", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: {
      id: POST,
      status: "scheduled",
      scheduled_at: "2026-10-22T12:00:00.000Z",
      metadata: null,
    },
    error: null,
  });
  db.queueRpc(RESCHEDULE_RPC, {
    data: {
      outcome: "updated",
      post: { id: POST, status: "scheduled", scheduled_at: "2027-01-01T04:30:00.000Z" },
    },
    error: null,
  });

  // The written date is the one that is published: the offset only says which
  // instant it is.
  const result = await reschedulePost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
    scheduled_at: "2026-12-31T23:30:00-05:00",
  });
  assertEquals(result.status, 200);
  const args = rpcCallFor(db, RESCHEDULE_RPC)?.args ?? {};
  assertEquals(args.p_scheduled_at, "2027-01-01T04:30:00.000Z");
  assertEquals(args.p_user_id, USER);
  assertEquals(args.p_post_id, POST);
});

Deno.test("a reschedule moves the instant and writes nothing else", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: {
      id: POST,
      status: "scheduled",
      scheduled_at: "2026-10-22T12:00:00.000Z",
      metadata: { source: "api" },
    },
    error: null,
  });
  db.queueRpc(RESCHEDULE_RPC, {
    data: {
      outcome: "updated",
      post: { id: POST, status: "scheduled", scheduled_at: "2026-12-01T10:00:00.000Z" },
    },
    error: null,
  });
  // A caller that still sends a timezone is accepted: the timezone is a label
  // and the instant is what publishes, so nothing is stored for it.
  const result = await reschedulePost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
    scheduled_at: "2026-12-01T10:00:00Z",
    timezone: "America/New_York",
  });
  assertEquals(result.status, 200);
  const args = rpcCallFor(db, RESCHEDULE_RPC)?.args ?? {};
  // Only the instant is written: the metadata is not rebuilt from the earlier
  // read, which would overwrite a dashboard edit that landed in the meantime.
  assertEquals(args.p_scheduled_at, "2026-12-01T10:00:00.000Z");
  assertEquals("metadata" in args, false);
  // The function does not update the row itself any more.
  assertEquals(callsFor(db, "posts", "update").length, 0);
  const body = result.body as { post: { scheduled_at: string }; previous_scheduled_at: string };
  assertEquals(body.post.scheduled_at, "2026-12-01T10:00:00.000Z");
  assertEquals(body.previous_scheduled_at, "2026-10-22T12:00:00.000Z");
});

Deno.test("a reschedule whose new time has come by the time the database writes is refused", async () => {
  const db = new FakeSupabase();
  // The new time was five minutes away when the request started, and the
  // database clock says it is in the past now: the post may not be moved to an
  // instant that has already come.
  db.queue("posts", {
    data: {
      id: POST,
      status: "scheduled",
      scheduled_at: "2026-10-22T12:00:00.000Z",
      metadata: null,
    },
    error: null,
  });
  db.queueRpc(RESCHEDULE_RPC, { data: { outcome: "in_past" }, error: null });
  const result = await reschedulePost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
    scheduled_at: "2026-10-21T12:05:00.000Z",
  });
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "SCHEDULED_AT_IN_PAST");
  // The post was not moved: an instant that has already come cannot be
  // scheduled.
  assertEquals(callsFor(db, "posts", "update").length, 0);
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a reschedule of a post that is no longer scheduled for the future is a 409", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: {
      id: POST,
      status: "scheduled",
      scheduled_at: "2026-10-22T12:00:00.000Z",
      metadata: null,
    },
    error: null,
  });
  // The database moved no row: the post is not a scheduled post in the future
  // any more, so the scheduler has it.
  db.queueRpc(RESCHEDULE_RPC, { data: { outcome: "unchanged" }, error: null });
  const result = await reschedulePost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
    scheduled_at: "2026-12-01T10:00:00Z",
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_STATE_CHANGED");
  assertEquals(callsFor(db, "posts", "update").length, 0);
});

Deno.test("a reschedule falls back to the app-clock update while the function is missing", async () => {
  const db = new FakeSupabase();
  const writeTime = new Date("2026-10-21T12:10:00.000Z");
  db.queue("posts", {
    data: {
      id: POST,
      status: "scheduled",
      scheduled_at: "2026-10-22T12:00:00.000Z",
      metadata: null,
    },
    error: null,
  });
  // The function is not in the database yet: the route falls back to the path
  // it used before, on the clock of the edge.
  db.queueRpc(RESCHEDULE_RPC, { data: null, error: missingRpcError(RESCHEDULE_RPC) });
  db.queue("posts", {
    data: [{ id: POST, status: "scheduled", scheduled_at: "2026-12-01T10:00:00.000Z" }],
    error: null,
  });
  const result = await reschedulePost(
    depsFor(db, noNetwork(), advancingClock(NOW, writeTime)),
    USER,
    { post_id: POST, scheduled_at: "2026-12-01T10:00:00Z" },
  );
  assertEquals(result.status, 200);
  // The old path is used: the update is still compared with the clock of the
  // write, and it is still scoped to the owner and to a scheduled post.
  const update = callsFor(db, "posts", "update")[0];
  assertEquals(update.payload, { scheduled_at: "2026-12-01T10:00:00.000Z" });
  assertEquals(hasFilter(update, "eq", "user_id", USER), true);
  assertEquals(hasInFilter(update, "status", SCHEDULED_STATUSES), true);
  assertEquals(hasFilter(update, "gt", "scheduled_at", writeTime.toISOString()), true);
});

Deno.test("a reschedule falls back to the app clock and refuses a time that has come", async () => {
  const db = new FakeSupabase();
  // The new time is five minutes away when the request starts and the write
  // goes out ten minutes later: by then the instant asked for is already past,
  // so the post may not be moved to it.
  const writeTime = new Date("2026-10-21T12:10:00.000Z");
  db.queue("posts", {
    data: {
      id: POST,
      status: "scheduled",
      scheduled_at: "2026-10-22T12:00:00.000Z",
      metadata: null,
    },
    error: null,
  });
  db.queueRpc(RESCHEDULE_RPC, { data: null, error: missingRpcError(RESCHEDULE_RPC) });
  const result = await reschedulePost(
    depsFor(db, noNetwork(), advancingClock(NOW, writeTime)),
    USER,
    { post_id: POST, scheduled_at: "2026-10-21T12:05:00.000Z" },
  );
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "SCHEDULED_AT_IN_PAST");
  // The post was not moved.
  assertEquals(callsFor(db, "posts", "update").length, 0);
});

Deno.test("a post that carries a TikTok review consent cannot be rescheduled", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: {
      id: POST,
      status: "scheduled",
      scheduled_at: "2026-10-22T12:00:00.000Z",
      metadata: { tiktok_review_submission_id: "77777777-7777-4777-8777-777777777777" },
    },
    error: null,
  });
  const result = await reschedulePost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
    scheduled_at: "2026-12-01T10:00:00Z",
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "CONSENT_BOUND_POST");
  assertEquals(
    (result.body.error as { message: string }).message,
    "This post was scheduled through the TikTok review consent flow; reschedule it from the Postora dashboard so the consent is renewed.",
  );

  // The post was not moved: process-post would refuse to publish it at an
  // instant the consent does not cover.
  assertEquals(callsFor(db, "posts", "update").length, 0);
  assertEquals(db.rpcCalls.length, 0);
});

Deno.test("a reschedule of a post that is being published to TikTok is a 409, not a 500", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: {
      id: POST,
      status: "scheduled",
      scheduled_at: "2026-10-22T12:00:00.000Z",
      metadata: null,
    },
    error: null,
  });
  // The database refused the update on purpose: the trigger raises P0001 with
  // the DETAIL 'TIKTOK_REVIEW_POST_LOCKED'. The post has already gone to
  // TikTok, so this refusal is permanent and not a retry in a few minutes.
  const triggerMessage =
    "This TikTok post has already gone to TikTok, so its time, account and content can't change. To post again, start a new draft in TikTok review.";
  db.queueRpc(RESCHEDULE_RPC, {
    data: null,
    error: {
      message: triggerMessage,
      code: "P0001",
      details: "TIKTOK_REVIEW_POST_LOCKED",
    },
  });
  const { result, logged } = await withCapturedWarn(() =>
    reschedulePost(depsFor(db, noNetwork()), USER, {
      post_id: POST,
      scheduled_at: "2026-12-01T10:00:00Z",
    })
  );
  // A lock is a decision, not a fault: the caller is told what the database
  // said about it.
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_LOCKED");
  // The answer carries the database's own message: a permanent refusal is not
  // dressed up as a transient one.
  assertEquals(
    (result.body.error as { message: string }).message,
    triggerMessage,
  );
  // The refusal leaves a durable row behind: a lock nobody watched still has
  // to leave a trace.
  const rows = callsFor(db, "system_logs", "insert");
  assertEquals(rows.length, 1);
  const row = rows[0].payload as Record<string, unknown>;
  assertEquals((row.metadata as { code: string }).code, "POST_LOCKED");
  // The lock leaves a line behind that names the route and the post.
  assertEquals(
    logged.some((line) => line.includes("posts/reschedule") && line.includes(POST)),
    true,
  );
});

Deno.test("a reschedule with a padded post id queries the trimmed id", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: {
      id: POST,
      status: "scheduled",
      scheduled_at: "2026-10-22T12:00:00.000Z",
      metadata: null,
    },
    error: null,
  });
  db.queueRpc(RESCHEDULE_RPC, {
    data: {
      outcome: "updated",
      post: { id: POST, status: "scheduled", scheduled_at: "2026-12-01T10:00:00.000Z" },
    },
    error: null,
  });
  const result = await reschedulePost(depsFor(db, noNetwork()), USER, {
    post_id: ` ${POST}\n`,
    scheduled_at: "2026-12-01T10:00:00Z",
  });
  assertEquals(result.status, 200);
  // The guard validates a trimmed value, so the trimmed value is the one that
  // reaches the query: an untrimmed id is not the uuid the row is stored under.
  const read = callsFor(db, "posts", "select")[0];
  assertEquals(hasFilter(read, "eq", "id", POST), true);
  // The write carries the trimmed id too.
  assertEquals(rpcCallFor(db, RESCHEDULE_RPC)?.args.p_post_id, POST);
});

// ── accounts/health ────────────────────────────────────────────────────────────

Deno.test("a health check with a non-uuid account id is refused", async () => {
  const db = new FakeSupabase();
  const result = await checkAccountHealth(depsFor(db, noNetwork()), USER, "not-a-uuid");
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "INVALID_ACCOUNT_ID");
  // The account is never read, and the id the caller sent is not a uuid, so
  // it is never written down either.
  assertEquals(callsFor(db, "social_accounts").length, 0);
  const rows = callsFor(db, "system_logs", "insert");
  assertEquals(rows.length, 1);
  assertEquals(JSON.stringify(rows[0].payload).includes("not-a-uuid"), false);
});

Deno.test("a health check for an account that is not there is a 404", async () => {
  const db = new FakeSupabase();
  db.queue("social_accounts", { data: null, error: null });
  const result = await checkAccountHealth(depsFor(db, noNetwork()), USER, ACCOUNT);
  assertEquals(result.status, 404);
  assertEquals(errorCode(result), "ACCOUNT_NOT_FOUND");
});

Deno.test("the health check never selects a token", async () => {
  const db = new FakeSupabase();
  db.queue("social_accounts", {
    data: {
      id: ACCOUNT,
      platform: "facebook",
      platform_username: "page",
      is_active: true,
      needs_reauth: false,
      failure_count: 0,
      last_refresh_error: null,
      token_expires_at: "2026-10-25T00:00:00.000Z",
    },
    error: null,
  });
  const result = await checkAccountHealth(depsFor(db, noNetwork()), USER, ACCOUNT);
  assertEquals(result.status, 200);
  const read = callsFor(db, "social_accounts", "select")[0];
  assertEquals(String(read.payload).includes("access_token"), false);
  assertEquals(String(read.payload).includes("refresh_token"), false);
});

Deno.test("a token that expires in three and a half days is still healthy", async () => {
  const db = new FakeSupabase();
  db.queue("social_accounts", {
    data: {
      id: ACCOUNT,
      platform: "facebook",
      platform_username: "page",
      is_active: true,
      needs_reauth: false,
      failure_count: 0,
      last_refresh_error: null,
      token_expires_at: "2026-10-25T00:00:00.000Z",
    },
    error: null,
  });
  const result = await checkAccountHealth(depsFor(db, noNetwork()), USER, ACCOUNT);
  assertEquals(result.status, 200);
  const account = (result.body as { account: Record<string, unknown> }).account;
  assertEquals(account.days_until_expiry, 3);
  assertEquals(account.token_expired, false);
  assertEquals(account.healthy, true);
});

Deno.test("an account that needs a reconnect is not healthy", async () => {
  const db = new FakeSupabase();
  db.queue("social_accounts", {
    data: {
      id: ACCOUNT,
      platform: "facebook",
      platform_username: "page",
      is_active: true,
      needs_reauth: true,
      failure_count: 2,
      last_refresh_error: "YouTube refresh failed: invalid_grant",
      token_expires_at: "2026-10-25T00:00:00.000Z",
    },
    error: null,
  });
  const result = await checkAccountHealth(depsFor(db, noNetwork()), USER, ACCOUNT);
  const account = (result.body as { account: Record<string, unknown> }).account;
  assertEquals(account.healthy, false);
  assertEquals(account.needs_reauth, true);
  assertEquals(account.failure_count, 2);
});

Deno.test("an account whose token expiry is unknown is not known to be healthy", async () => {
  const db = new FakeSupabase();
  db.queue("social_accounts", {
    data: {
      id: ACCOUNT,
      platform: "facebook",
      platform_username: "page",
      is_active: true,
      needs_reauth: false,
      failure_count: 0,
      last_refresh_error: null,
      token_expires_at: null,
    },
    error: null,
  });
  const result = await checkAccountHealth(depsFor(db, noNetwork()), USER, ACCOUNT);
  assertEquals(result.status, 200);
  const account = (result.body as { account: Record<string, unknown> }).account;
  // The expiry is unknown, so the state is indeterminate: null, not true. A
  // "healthy" nobody has checked is a claim the answer cannot make.
  assertEquals(account.token_expired, null);
  assertEquals(account.days_until_expiry, null);
  assertEquals(account.healthy, null);
});

Deno.test("an inactive account is not healthy even when its token expiry is unknown", async () => {
  const db = new FakeSupabase();
  db.queue("social_accounts", {
    data: {
      id: ACCOUNT,
      platform: "facebook",
      platform_username: "page",
      is_active: false,
      needs_reauth: false,
      failure_count: 0,
      last_refresh_error: null,
      token_expires_at: null,
    },
    error: null,
  });
  const result = await checkAccountHealth(depsFor(db, noNetwork()), USER, ACCOUNT);
  assertEquals(result.status, 200);
  const account = (result.body as { account: Record<string, unknown> }).account;
  // An account that is switched off is unhealthy whatever its token says.
  assertEquals(account.healthy, false);
});

// ── best-times ─────────────────────────────────────────────────────────────────

// The connected accounts of the caller: one row per platform the caller can
// post to. The best-times route reads the caller's own active accounts before
// it reads any history, so a test that gets that far has to say which
// platforms the caller is connected to.
function queueConnectedAccounts(db: FakeSupabase, platforms: string[]): void {
  db.queue("social_accounts", {
    data: platforms.map((platform) => ({ platform })),
    error: null,
  });
}

// The suggestion service answers with the shape the model was asked for: the
// platform, the day, the time, the score and the reason. A suggestion that
// does not carry every field is not usable, so the fixtures below are
// complete and a test that wants a broken one removes the field it needs.
function suggestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: "instagram",
    day: "Monday",
    time: "11:00 AM",
    score: 95,
    reason: "Lunch hours perform best for this account.",
    ...overrides,
  };
}

Deno.test("the posting histogram counts the local hour and the local weekday", () => {
  const histogram = computePostingHistogram(["2026-10-04T21:30:00Z"], "Asia/Kuwait");
  assertEquals(histogram.hourCounts, { 0: 1 });
  assertEquals(histogram.dayCounts, { 1: 1 });
  assertEquals(histogram.totalPosts, 1);
});

// The body the suggestion service is called with.
interface SentSuggestionBody {
  platforms: string[];
  user_id: string;
  historicalData: {
    hourCounts: Record<string, number>;
    dayCounts: Record<string, number>;
    totalPosts: number;
  };
}

Deno.test("the best-times request carries the platforms and the history", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-04T21:30:00Z" }],
    error: null,
  });
  const { calls, fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion()] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram"] },
    "Asia/Kuwait",
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.timezone, "Asia/Kuwait");
  assertEquals(result.body.based_on_posts, { instagram: 1 });
  assertEquals(result.body.suggestions, [suggestion()]);

  // The history is the successful per-platform results of the requested
  // platform, and the owner is enforced by the join to posts. The platform is
  // a filter of the read, not a column of the answer.
  const read = callsFor(db, "platform_posts", "select")[0];
  assertEquals(hasFilter(read, "eq", "posts.user_id", USER), true);
  assertEquals(hasFilter(read, "eq", "status", "success"), true);
  assertEquals(hasFilter(read, "eq", "platform", "instagram"), true);
  assertEquals(String(read.payload).includes("posted_at"), true);
  assertEquals(String(read.payload).includes("posts!inner(user_id)"), true);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `${SUPABASE_URL}/functions/v1/suggest-best-times`);
  assertEquals(calls[0].headers.Authorization, `Bearer ${SERVICE_KEY}`);
  const sent = JSON.parse(String(calls[0].body)) as SentSuggestionBody;
  assertEquals(sent.platforms, ["instagram"]);
  // The suggestion service is called with the service role, so the owner of the
  // API key travels in the body: the AI call is logged against that user.
  assertEquals(sent.user_id, USER);
  assertEquals(sent.historicalData.hourCounts, { "0": 1 });
  assertEquals(sent.historicalData.dayCounts, { "1": 1 });
  assertEquals(sent.historicalData.totalPosts, 1);
});

Deno.test("each platform is analysed on its own publishing history", async () => {
  const db = new FakeSupabase();
  // One read per platform, in the order the platforms were asked for.
  queueConnectedAccounts(db, ["instagram", "tiktok"]);
  db.queue("platform_posts", {
    data: [
      { posted_at: "2026-10-04T21:30:00Z" },
      { posted_at: "2026-10-05T21:30:00Z" },
    ],
    error: null,
  });
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-06T12:00:00Z" }],
    error: null,
  });
  const { calls, fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion()] } },
    { status: 200, body: { suggestions: [suggestion({ platform: "tiktok", day: "Tuesday" })] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram", "tiktok"] },
    "UTC",
  );
  assertEquals(result.status, 200);
  // Each platform is counted on its own posts.
  assertEquals(result.body.based_on_posts, { instagram: 2, tiktok: 1 });
  // The suggestions come back in the order the platforms were asked for.
  assertEquals(result.body.suggestions, [
    suggestion(),
    suggestion({ platform: "tiktok", day: "Tuesday" }),
  ]);

  // One call per platform, and each call carries only that platform's
  // history: a merged histogram would have counted three posts for both.
  assertEquals(calls.length, 2);
  const first = JSON.parse(String(calls[0].body)) as SentSuggestionBody;
  const second = JSON.parse(String(calls[1].body)) as SentSuggestionBody;
  assertEquals(first.platforms, ["instagram"]);
  assertEquals(first.historicalData.totalPosts, 2);
  assertEquals(first.historicalData.hourCounts, { "21": 2 });
  assertEquals(second.platforms, ["tiktok"]);
  assertEquals(second.historicalData.totalPosts, 1);
  assertEquals(second.historicalData.hourCounts, { "12": 1 });
  assertEquals(first.user_id, USER);
  assertEquals(second.user_id, USER);
});

Deno.test("every platform's history is read on its own, under its own limit", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram", "tiktok"]);
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-04T21:30:00Z" }],
    error: null,
  });
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-06T12:00:00Z" }],
    error: null,
  });
  const { fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion()] } },
    { status: 200, body: { suggestions: [suggestion({ platform: "tiktok" })] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram", "tiktok"] },
    "UTC",
  );
  assertEquals(result.status, 200);

  // One read per platform, each with its own limit: a shared limit would let
  // the rows of a busy platform push every row of another platform out.
  const reads = callsFor(db, "platform_posts", "select");
  assertEquals(reads.length, 2);
  for (const platform of ["instagram", "tiktok"]) {
    const read = readForPlatform(db, platform);
    assertEquals(read !== undefined, true, platform);
    assertEquals(hasFilter(read, "eq", "posts.user_id", USER), true, platform);
    assertEquals(hasFilter(read, "eq", "status", "success"), true, platform);
    assertEquals(hasLimit(read, 500), true, platform);
  }
  // No read asks for the platforms together.
  assertEquals(
    reads.some((call) => call.filters.some((entry) => entry[0] === "in" && entry[1] === "platform")),
    false,
  );
});

Deno.test("a history read that fails is a 500 and no suggestion is asked for", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram", "tiktok"]);
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-04T21:30:00Z" }],
    error: null,
  });
  db.queue("platform_posts", { data: null, error: { message: "statement timeout" } });
  const { calls, fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion()] } },
    { status: 200, body: { suggestions: [suggestion({ platform: "tiktok" })] } },
  ]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await suggestBestTimes(
      depsFor(db, fetcher),
      USER,
      { platforms: ["instagram", "tiktok"] },
      null,
    );
    assertEquals(result.status, 500);
    assertEquals(errorCode(result), "INTERNAL_ERROR");
    // The history of one platform could not be read, so no suggestion is asked
    // for: an answer built on a half-read history would be a suggestion for a
    // platform that has none.
    assertEquals(calls.length, 0);
    // The fault is logged where it happened.
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("reading the posting history failed"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a platform asked for twice is one platform", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-04T21:30:00Z" }],
    error: null,
  });
  const { calls, fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion()] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram", "instagram"] },
    null,
  );
  assertEquals(result.status, 200);
  assertEquals(calls.length, 1);
  assertEquals(callsFor(db, "platform_posts", "select").length, 1);
  assertEquals(result.body.based_on_posts, { instagram: 1 });
});

Deno.test("the same platform spelled three ways is one platform", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-04T21:30:00Z" }],
    error: null,
  });
  const { calls, fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion()] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram", "Instagram", " INSTAGRAM "] },
    null,
  );
  assertEquals(result.status, 200);

  // One history read, for the name the rows are actually stored under: the
  // second read of "Instagram" would have found nothing.
  const reads = callsFor(db, "platform_posts", "select");
  assertEquals(reads.length, 1);
  assertEquals(hasFilter(reads[0], "eq", "platform", "instagram"), true);

  // One AI call, so one platform is billed once.
  assertEquals(calls.length, 1);
  const sent = JSON.parse(String(calls[0].body)) as SentSuggestionBody;
  assertEquals(sent.platforms, ["instagram"]);

  // One count for one platform: two spellings would have answered with two
  // contradictory counts for the same platform.
  assertEquals(result.body.based_on_posts, { instagram: 1 });
  assertEquals(result.body.suggestions, [suggestion()]);
});

Deno.test("a platform that is not a platform name is refused before the history is read", async () => {
  const db = new FakeSupabase();
  const result = await suggestBestTimes(
    depsFor(db, noNetwork()),
    USER,
    { platforms: ["insta gram"] },
    null,
  );
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "INVALID_REQUEST");
  assertEquals(
    (result.body.error as { message: string }).message,
    "platforms must be platform names such as instagram or tiktok.",
  );
  // The history is never read: the refusal only writes its own row.
  assertEquals(callsFor(db, "platform_posts").length, 0);
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a platform with no connected account is refused before the history is read", async () => {
  const db = new FakeSupabase();
  // The caller has an Instagram account and no Facebook one. "facebok" is a
  // lowercase word, so the shape check lets it through: only the caller's own
  // connected accounts can tell a typo from a platform.
  queueConnectedAccounts(db, ["instagram"]);
  const { calls, fetcher } = fakeFetcher([]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram", "facebok"] },
    null,
  );
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "UNKNOWN_PLATFORM");
  assertEquals(
    (result.body.error as { message: string }).message,
    "No connected account for: facebok. Use list_accounts to see your platforms.",
  );
  // The names echoed back are the normalized names the caller sent.
  assertEquals(
    (result.body.error as { details: { platforms: string[] } }).details.platforms,
    ["facebok"],
  );
  // The history is never read and the AI is never called: a platform the
  // caller cannot post to costs neither.
  assertEquals(callsFor(db, "platform_posts").length, 0);
  assertEquals(calls.length, 0);
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("the connected accounts are read once, for the caller's own active accounts", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram", "tiktok"]);
  db.queue("platform_posts", { data: [], error: null });
  db.queue("platform_posts", { data: [], error: null });
  const { fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion()] } },
    { status: 200, body: { suggestions: [suggestion({ platform: "tiktok" })] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram", "tiktok"] },
    null,
  );
  assertEquals(result.status, 200);

  // One read of the caller's own accounts, for the platforms that were asked
  // about. The service role is not the boundary, so the ownership and the
  // active flag are part of the query and not of the caller's trust.
  const reads = callsFor(db, "social_accounts", "select");
  assertEquals(reads.length, 1);
  assertEquals(hasFilter(reads[0], "eq", "user_id", USER), true);
  assertEquals(hasFilter(reads[0], "eq", "is_active", true), true);
  assertEquals(hasInFilter(reads[0], "platform", ["instagram", "tiktok"]), true);
});

Deno.test("a connected accounts read that fails is a 500 and nothing is read or asked for", async () => {
  const db = new FakeSupabase();
  db.queue("social_accounts", { data: null, error: { message: "statement timeout" } });
  const { calls, fetcher } = fakeFetcher([]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await suggestBestTimes(
      depsFor(db, fetcher),
      USER,
      { platforms: ["instagram"] },
      null,
    );
    // A failed read is not an empty result: the platform is not refused as
    // unknown on the strength of a read that never happened.
    assertEquals(result.status, 500);
    assertEquals(errorCode(result), "INTERNAL_ERROR");
    assertEquals(
      (result.body.error as { message: string }).message,
      "Reading the connected accounts failed. Please try again.",
    );
    // Nothing is read and no AI is called on a platform nobody could be
    // checked against.
    assertEquals(callsFor(db, "platform_posts").length, 0);
    assertEquals(calls.length, 0);
    // The fault is logged where it happened.
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("reading the connected accounts failed"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a best-times request for more than six platforms is refused before the history is read", async () => {
  const db = new FakeSupabase();
  const result = await suggestBestTimes(
    depsFor(db, noNetwork()),
    USER,
    { platforms: ["a", "b", "c", "d", "e", "f", "g"] },
    null,
  );
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "INVALID_REQUEST");
  // The history is never read: the refusal only writes its own row.
  assertEquals(callsFor(db, "platform_posts").length, 0);
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a platform whose suggestion call fails is the failure that is reported", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram", "tiktok"]);
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-04T21:30:00Z" }],
    error: null,
  });
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-06T12:00:00Z" }],
    error: null,
  });
  const { fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion()] } },
    { status: 503, body: { error: "down" } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram", "tiktok"] },
    null,
  );
  assertEquals(result.status, 502);
  assertEquals(errorCode(result), "BEST_TIMES_FAILED");
});

Deno.test("the first failure in request order is the one that is reported", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram", "tiktok"]);
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-04T21:30:00Z" }],
    error: null,
  });
  db.queue("platform_posts", {
    data: [{ posted_at: "2026-10-06T12:00:00Z" }],
    error: null,
  });
  // Instagram times out, TikTok refuses. The caller asked for Instagram
  // first, so the timeout is the failure it is told about.
  const { fetcher } = fakeFetcher([
    { reject: new Error("Request timed out") },
    { status: 503, body: { error: "down" } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram", "tiktok"] },
    null,
  );
  assertEquals(result.status, 504);
  assertEquals(errorCode(result), "BEST_TIMES_TIMEOUT");
});

Deno.test("a best-times service that refuses is a 502", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  const { fetcher } = fakeFetcher([{ status: 503, body: { error: "down" } }]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram"] },
    null,
  );
  assertEquals(result.status, 502);
  assertEquals(errorCode(result), "BEST_TIMES_FAILED");
});

Deno.test("a suggestion service that does not answer in time is a 504 and leaves a log line", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  const { fetcher } = fakeFetcher([{ reject: new Error("Request timed out") }]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await suggestBestTimes(
      depsFor(db, fetcher),
      USER,
      { platforms: ["instagram"] },
      null,
    );
    assertEquals(result.status, 504);
    assertEquals(errorCode(result), "BEST_TIMES_TIMEOUT");
    // Every refusal leaves a line behind, so a timeout is visible in the logs
    // and not only in the answer the caller got.
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("did not answer"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a suggestion service whose body never arrives is a 504 and leaves a log line", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  const { fetcher, wasCancelled } = stalledBodyFetcher();
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await suggestBestTimes(
      // The deadline covers the body and not only the headers, so a body that
      // stalls is a service that did not answer in time.
      { ...depsFor(db, fetcher), bestTimesTimeoutMs: 20 },
      USER,
      { platforms: ["instagram"] },
      null,
    );
    assertEquals(result.status, 504);
    assertEquals(errorCode(result), "BEST_TIMES_TIMEOUT");
    // Every refusal leaves a line behind, so a timeout is visible in the logs
    // and not only in the answer the caller got.
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("did not answer"), true);
    // The body is cancelled, so the connection to the service is released: a
    // service that stalls must not keep it open behind the 504.
    assertEquals(wasCancelled(), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a body that arrives in two chunks is read in full", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  // The body arrives in two pieces, so a reader that stopped at the end of the
  // first one would answer with a body that is not JSON.
  const json = JSON.stringify({ suggestions: [suggestion()] });
  const splitAt = Math.floor(json.length / 2);
  const fetcher = chunkedBodyFetcher([json.slice(0, splitAt), json.slice(splitAt)]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram"] },
    null,
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.suggestions, [suggestion()]);
});

Deno.test("a suggestion service that answers 2xx with a body that is not JSON is a 502", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await suggestBestTimes(
      depsFor(db, rawBodyFetcher(200, "not json")),
      USER,
      { platforms: ["instagram"] },
      null,
    );
    assertEquals(result.status, 502);
    assertEquals(errorCode(result), "BEST_TIMES_FAILED");
    // A body that could not be read is not an empty result: the caller is told
    // the answer failed, and the refusal leaves a line behind.
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("without a suggestions list"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a suggestion service that answers 2xx without a suggestions list is a 502", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  const { fetcher } = fakeFetcher([{ status: 200, body: {} }]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await suggestBestTimes(
      depsFor(db, fetcher),
      USER,
      { platforms: ["instagram"] },
      null,
    );
    assertEquals(result.status, 502);
    assertEquals(errorCode(result), "BEST_TIMES_FAILED");
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("without a suggestions list"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a suggestion service that could not read the model's answer is a 502", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  // The service flags the answer it could not parse: the list is empty because
  // the model's answer failed to parse, not because there was nothing to say.
  const { fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [], parse_failed: true } },
  ]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await suggestBestTimes(
      depsFor(db, fetcher),
      USER,
      { platforms: ["instagram"] },
      null,
    );
    assertEquals(result.status, 502);
    assertEquals(errorCode(result), "BEST_TIMES_FAILED");
    // The refusal leaves a line behind, so a failed read is visible in the
    // logs and not only in the answer the caller got.
    assertEquals(logged.length, 1);
    assertEquals(
      logged[0],
      `[n8n-api] best-times: the suggestion service could not read the model's answer (user ${USER})`,
    );
  } finally {
    console.error = originalError;
  }
});

Deno.test("a suggestion that does not carry every field is dropped", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  // The service answered with an item that has no time: it cannot be
  // scheduled, so it is dropped and the usable suggestion is kept.
  const withoutTime = {
    platform: "instagram",
    day: "Monday",
    score: 95,
    reason: "Lunch hours perform best for this account.",
  };
  const { fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion(), withoutTime] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram"] },
    null,
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.suggestions, [suggestion()]);
});

Deno.test("a suggestion nobody can schedule from is dropped", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  // A day nobody can schedule on and a time that is not a clock time are not
  // suggestions, so they are dropped the same way a missing field is.
  const { fetcher } = fakeFetcher([
    {
      status: 200,
      body: {
        suggestions: [
          suggestion(),
          suggestion({ day: "Funday" }),
          suggestion({ time: "25:90" }),
          suggestion({ reason: "   " }),
        ],
      },
    },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram"] },
    null,
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.suggestions, [suggestion()]);
});

Deno.test("a suggestion for another platform is dropped", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  // The service was asked about Instagram, so a TikTok suggestion is not an
  // answer to this question.
  const { fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion(), suggestion({ platform: "tiktok" })] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram"] },
    null,
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.suggestions, [suggestion()]);
});

Deno.test("a suggestion whose platform carries spaces is kept", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  // The service answered with the platform spelled with spaces around it: it
  // is still an answer about Instagram, and dropping it would tell the caller
  // the service had nothing to say.
  const padded = suggestion({ platform: " Instagram " });
  const { fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [padded] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram"] },
    null,
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.suggestions, [padded]);
});

Deno.test("a list with nothing usable in it is a 502 and leaves a log line", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  // The service answered with a list, but nothing in it is a suggestion: a
  // 200 with no suggestions would tell the caller the service had nothing to
  // say, when in fact it answered with something unusable.
  const { fetcher } = fakeFetcher([
    {
      status: 200,
      body: { suggestions: [{ platform: "instagram", day: "Monday", score: 95 }] },
    },
  ]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await suggestBestTimes(
      depsFor(db, fetcher),
      USER,
      { platforms: ["instagram"] },
      null,
    );
    assertEquals(result.status, 502);
    assertEquals(errorCode(result), "BEST_TIMES_FAILED");
    // The failed read leaves a line behind, so it is visible in the logs and
    // not only in the answer the caller got.
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("no usable suggestion"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a suggestion is only a suggestion when every field is there", () => {
  assertEquals(isBestTimeSuggestion(suggestion()), true);
  // A score outside the range is not a score.
  assertEquals(isBestTimeSuggestion({ ...suggestion(), score: 101 }), false);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), score: -1 }), false);
  // A score that is a string is not a number.
  assertEquals(isBestTimeSuggestion({ ...suggestion(), score: "95" }), false);
  // A missing field is a missing field.
  assertEquals(isBestTimeSuggestion({ ...suggestion(), time: undefined }), false);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), day: undefined }), false);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), reason: undefined }), false);
  // Anything that is not an object at all is not a suggestion.
  assertEquals(isBestTimeSuggestion(null), false);
  assertEquals(isBestTimeSuggestion("instagram"), false);
});

Deno.test("a suggestion whose day is not a weekday is not a suggestion", () => {
  // A day nobody can schedule on is not a day: the model is asked for a
  // weekday, and "Funday" is not one.
  assertEquals(isBestTimeSuggestion({ ...suggestion(), day: "" }), false);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), day: "Funday" }), false);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), day: "   " }), false);
});

Deno.test("a suggestion whose time is not a clock time is not a suggestion", () => {
  assertEquals(isBestTimeSuggestion({ ...suggestion(), time: "" }), false);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), time: "25:90" }), false);
  // The hour of a 12-hour clock never goes past twelve, and the minutes
  // never past fifty-nine.
  assertEquals(isBestTimeSuggestion({ ...suggestion(), time: "13:00 PM" }), false);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), time: "11:60" }), false);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), time: "noon" }), false);
});

Deno.test("a suggestion without a reason is not a suggestion", () => {
  assertEquals(isBestTimeSuggestion({ ...suggestion(), reason: "" }), false);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), reason: "   " }), false);
});

Deno.test("a suggestion without a platform is not a suggestion", () => {
  assertEquals(isBestTimeSuggestion({ ...suggestion(), platform: "" }), false);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), platform: "   " }), false);
});

Deno.test("a day and a time written in another spelling are still a suggestion", () => {
  // The day is a weekday whatever its casing, and the time is a clock time in
  // either of the two formats a caller writes.
  assertEquals(
    isBestTimeSuggestion({ ...suggestion(), day: "monday", time: "11:00 AM" }),
    true,
  );
  assertEquals(isBestTimeSuggestion({ ...suggestion(), time: "18:30" }), true);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), day: " sunday " }), true);
  assertEquals(isBestTimeSuggestion({ ...suggestion(), time: "9:05 PM" }), true);
});

Deno.test("an empty suggestion list from the service is a 502", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  // The service answered with an empty list: it read the model and the model
  // had nothing to say. That is a failed call, and a 200 with no suggestions
  // would tell the caller the service had nothing to say.
  const { fetcher } = fakeFetcher([{ status: 200, body: { suggestions: [] } }]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await suggestBestTimes(
      depsFor(db, fetcher),
      USER,
      { platforms: ["instagram"] },
      null,
    );
    assertEquals(result.status, 502);
    assertEquals(errorCode(result), "BEST_TIMES_FAILED");
    // The failed read leaves a line behind, so it is visible in the logs and
    // not only in the answer the caller got.
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("no suggestions"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a suggestion service that flags an empty result is a 502", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  // The service read the model's answer and it held nothing to schedule: the
  // service flags it as an empty result, and the flag is a failed read too.
  const { fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [], empty_result: true } },
  ]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await suggestBestTimes(
      depsFor(db, fetcher),
      USER,
      { platforms: ["instagram"] },
      null,
    );
    assertEquals(result.status, 502);
    assertEquals(errorCode(result), "BEST_TIMES_FAILED");
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("empty result"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a timezone the runtime does not know falls back to UTC", async () => {
  const db = new FakeSupabase();
  queueConnectedAccounts(db, ["instagram"]);
  db.queue("platform_posts", { data: [], error: null });
  const { fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [suggestion()] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram"] },
    "Mars/Olympus",
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.timezone, "UTC");
});

// ── a body that cannot be parsed ───────────────────────────────────────────────

// The router used to parse the body before the handler ran, so a malformed or
// truncated body threw out of the route and was answered with a generic 500
// that carried no rate-limit headers. The handler reads the body itself now,
// and a body that cannot be parsed is a stable 400 that never reaches a
// business table: the only thing it writes is its own refusal row.
const MALFORMED_BODY = () => Promise.reject(new SyntaxError("Unexpected end of JSON input"));

function minimalRequest(path: string): Request {
  return new Request(`https://api.postora.cloud${path}`, { method: "POST" });
}

// Every refusal leaves a line behind, so the warning is captured while the
// call runs.
async function withCapturedWarn<T>(
  run: () => Promise<T>,
): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await run();
    return { result, logged };
  } finally {
    console.warn = originalWarn;
  }
}

Deno.test("a cancel whose body cannot be parsed is a 400 and never reaches the posts table", async () => {
  const db = new FakeSupabase();
  const { result: response, logged } = await withCapturedWarn(() =>
    handleCancelScheduledPost(
      minimalRequest("/api/v1/posts/cancel"),
      db,
      USER,
      MALFORMED_BODY,
    )
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: string; message: string } };
  assertEquals(body.error.code, "INVALID_REQUEST");
  assertEquals(body.error.message, "The request body is not valid JSON.");
  // The post is never read or written: the refusal only writes its own row.
  assertEquals(callsFor(db, "posts").length, 0);
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
  // The refusal leaves a line behind, ids only: never the body itself.
  assertEquals(logged.length, 1);
  assertEquals(
    logged[0],
    `[n8n-api] posts/cancel: INVALID_REQUEST (post unknown, user ${USER})`,
  );
});

Deno.test("a reschedule whose body cannot be parsed is a 400 and never reaches the posts table", async () => {
  const db = new FakeSupabase();
  const { result: response, logged } = await withCapturedWarn(() =>
    handleReschedulePost(
      minimalRequest("/api/v1/posts/reschedule"),
      db,
      USER,
      MALFORMED_BODY,
    )
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: string; message: string } };
  assertEquals(body.error.code, "INVALID_REQUEST");
  assertEquals(body.error.message, "The request body is not valid JSON.");
  assertEquals(callsFor(db, "posts").length, 0);
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
  assertEquals(logged.length, 1);
  assertEquals(
    logged[0],
    `[n8n-api] posts/reschedule: INVALID_REQUEST (post unknown, user ${USER})`,
  );
});

Deno.test("a best-times whose body cannot be parsed is a 400 and never reaches the history table", async () => {
  const db = new FakeSupabase();
  const { result: response, logged } = await withCapturedWarn(() =>
    handleSuggestBestTimes(
      minimalRequest("/api/v1/best-times"),
      db,
      USER,
      MALFORMED_BODY,
      "Asia/Kuwait",
    )
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: string; message: string } };
  assertEquals(body.error.code, "INVALID_REQUEST");
  assertEquals(body.error.message, "The request body is not valid JSON.");
  assertEquals(callsFor(db, "platform_posts").length, 0);
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
  assertEquals(logged.length, 1);
  assertEquals(
    logged[0],
    `[n8n-api] best-times: INVALID_REQUEST (user ${USER})`,
  );
});

// ── the durable refusal row ────────────────────────────────────────────────────

// A refusal that only prints a line leaves nothing behind once the request is
// over, and a refusal nobody watched is a refusal nobody can explain later.
// Every refusal therefore writes one system_logs row: the route, the code, the
// status and the ids, and nothing the caller sent.

Deno.test("a not-found cancel leaves exactly one durable refusal row", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: null, error: null });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 404);
  assertEquals(errorCode(result), "POST_NOT_FOUND");

  const rows = callsFor(db, "system_logs", "insert");
  assertEquals(rows.length, 1);
  const row = rows[0].payload as Record<string, unknown>;
  assertEquals(row.source, "n8n-api");
  // The category has to be one the column accepts: system_logs_category_check
  // rejects anything outside auth, edge, database, token, post, system, ai,
  // scheduler, webhook, payment and media.
  assertEquals(row.category, "edge");
  assertEquals(row.level, "warn");
  assertEquals(row.message, "posts/cancel refused: POST_NOT_FOUND");
  assertEquals(row.user_id, USER);
  assertEquals(row.metadata, {
    route: "posts/cancel",
    code: "POST_NOT_FOUND",
    status: 404,
    post_id: POST,
  });
});

Deno.test("a refusal row that cannot be written still answers the caller", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: null, error: null });
  db.queue("system_logs", { data: null, error: { message: "insert failed" } });
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
      post_id: POST,
    });
    // The answer does not change because the log row failed: the refusal is
    // still a refusal, and it still never throws.
    assertEquals(result.status, 404);
    assertEquals(result.body, {
      success: false,
      error: { code: "POST_NOT_FOUND", message: "Post not found." },
    });
    // The edge log is the only sink left when the database refuses the row.
    // The wording is the one writer's (./refusalLog.ts), so the code names the
    // refusal as well as the route.
    assertEquals(logged.length, 1);
    assertEquals(
      logged[0],
      "[n8n-api] system_logs insert failed while refusing posts/cancel (POST_NOT_FOUND, no durable refusal row): insert failed",
    );
  } finally {
    console.error = originalError;
  }
});

Deno.test("a body that cannot be parsed leaves a durable refusal row", async () => {
  const db = new FakeSupabase();
  const response = await handleCancelScheduledPost(
    minimalRequest("/api/v1/posts/cancel"),
    db,
    USER,
    MALFORMED_BODY,
  );
  assertEquals(response.status, 400);

  const rows = callsFor(db, "system_logs", "insert");
  assertEquals(rows.length, 1);
  const row = rows[0].payload as Record<string, unknown>;
  assertEquals(row.source, "n8n-api");
  assertEquals(row.category, "edge");
  assertEquals(row.level, "warn");
  assertEquals(row.message, "posts/cancel refused: INVALID_REQUEST");
  assertEquals(row.user_id, USER);
  // The body the caller sent is never part of the row: only the route, the
  // code and the status.
  assertEquals(row.metadata, {
    route: "posts/cancel",
    code: "INVALID_REQUEST",
    status: 400,
  });
});

// ── posts/retry ───────────────────────────────────────────────────────────────

// A fetcher whose request never comes back: the headers and the body are both
// late, so only the deadline can end the call. The pending promise is never
// settled, so the request is still running when the deadline fires.
function hangingFetcher(): typeof fetch {
  return (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

// The rows of a post, as they are read: one failed result per account, and
// the results of the accounts that already went out.
function platformResult(
  id: string,
  platform: string | null,
  accountId: string | null,
  status: string,
): Record<string, unknown> {
  return {
    id,
    platform,
    social_account_id: accountId,
    status,
    error_message: status === "failed" ? "the provider refused the post" : null,
  };
}

// The claim that says the post may be retried.
function claimQueued(db: FakeSupabase, status = "failed"): void {
  db.queueRpc(CLAIM_RPC, {
    data: { outcome: "claimed", claim_id: CLAIM, status },
    error: null,
  });
}

Deno.test("a retry with a non-uuid post id is refused before anything is claimed", async () => {
  const db = new FakeSupabase();
  const result = await retryFailedPost(depsFor(db, noNetwork()), USER, {
    post_id: "not-a-uuid",
  });
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "INVALID_POST_ID");
  // Nothing is claimed and nothing is published: the refusal only writes its
  // own row.
  assertEquals(db.rpcCalls.length, 0);
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a retry whose claim function is not in the database yet is a 503 and publishes nothing", async () => {
  const db = new FakeSupabase();
  // The migration that creates the claim has not been applied to this
  // database yet: PostgREST answers PGRST202.
  db.queueRpc(CLAIM_RPC, { data: null, error: missingRpcError(CLAIM_RPC) });
  const { calls, fetcher } = fakeFetcher([]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await retryFailedPost(depsFor(db, fetcher), USER, {
      post_id: POST,
    });
    // An outage is not a refusal: the caller's request is fine, the database
    // is not ready for it.
    assertEquals(result.status, 503);
    assertEquals(errorCode(result), "FEATURE_NOT_READY");
    assertEquals(
      (result.body.error as { message: string }).message,
      "Retrying a post needs a database update that has not been applied yet.",
    );
    // Nothing is published: the claim never came, so the publish never goes.
    assertEquals(calls.length, 0);
    // The outage leaves a line behind, and not a refusal row: it is not a
    // decision about the caller's request.
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("is not in the database yet"), true);
    assertEquals(callsFor(db, "system_logs", "insert").length, 0);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a retry of a post that does not exist is a 404 and leaves a durable row", async () => {
  const db = new FakeSupabase();
  db.queueRpc(CLAIM_RPC, { data: { outcome: "not_found" }, error: null });
  const { calls, fetcher } = fakeFetcher([]);
  const result = await retryFailedPost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 404);
  assertEquals(errorCode(result), "POST_NOT_FOUND");
  // Nothing is published and no claim is given back: there was no claim.
  assertEquals(calls.length, 0);
  assertEquals(rpcCallFor(db, RELEASE_RPC), undefined);
  const rows = callsFor(db, "system_logs", "insert");
  assertEquals(rows.length, 1);
  const row = rows[0].payload as Record<string, unknown>;
  assertEquals(row.message, "posts/retry refused: POST_NOT_FOUND");
});

Deno.test("a retry of a post another action is working on is a 409", async () => {
  const db = new FakeSupabase();
  db.queueRpc(CLAIM_RPC, { data: { outcome: "busy" }, error: null });
  const { calls, fetcher } = fakeFetcher([]);
  const result = await retryFailedPost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_BUSY");
  assertEquals(
    (result.body.error as { message: string }).message,
    "Another action is running on this post. Try again in a few minutes.",
  );
  // Nothing is published and no claim is given back: there was no claim.
  assertEquals(calls.length, 0);
  assertEquals(rpcCallFor(db, RELEASE_RPC), undefined);
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a retry of a post that did not finish publishing is a 409 and names its status", async () => {
  const db = new FakeSupabase();
  db.queueRpc(CLAIM_RPC, {
    data: { outcome: "bad_status", status: "scheduled" },
    error: null,
  });
  const { calls, fetcher } = fakeFetcher([]);
  const result = await retryFailedPost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_NOT_RETRYABLE");
  assertEquals(
    (result.body.error as { message: string }).message,
    "Only a post that finished publishing (completed or failed) can be retried.",
  );
  assertEquals(
    (result.body.error as { details: { status: string } }).details.status,
    "scheduled",
  );
  // Nothing is published and no claim is given back: there was no claim.
  assertEquals(calls.length, 0);
  assertEquals(rpcCallFor(db, RELEASE_RPC), undefined);
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a post with no failed result left is refused and the claim is given back", async () => {
  const db = new FakeSupabase();
  claimQueued(db, "completed");
  db.queue("platform_posts", {
    data: [platformResult("row-success", "instagram", ACCOUNT, "success")],
    error: null,
  });
  db.queueRpc(RELEASE_RPC, { data: true, error: null });
  const { calls, fetcher } = fakeFetcher([]);
  const result = await retryFailedPost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "NO_FAILED_PLATFORMS");
  // Nothing is published: there is no failed result to publish again.
  assertEquals(calls.length, 0);
  // The claim is given back, so the next call is not told the post is busy.
  assertEquals(rpcCallFor(db, RELEASE_RPC)?.args, {
    p_user_id: USER,
    p_post_id: POST,
    p_claim_id: CLAIM,
  });
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a failed result of an account that already published is not published again", async () => {
  const db = new FakeSupabase();
  claimQueued(db);
  db.queue("platform_posts", {
    data: [
      platformResult("row-failed", "tiktok", ACCOUNT_TWO, "failed"),
      platformResult("row-published", "tiktok", ACCOUNT_TWO, "success"),
    ],
    error: null,
  });
  db.queueRpc(RELEASE_RPC, { data: true, error: null });
  const { calls, fetcher } = fakeFetcher([]);
  const result = await retryFailedPost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "NO_FAILED_PLATFORMS");
  // The account went out already, so the post is not published a second time.
  assertEquals(calls.length, 0);
});

Deno.test("a retry publishes only the failed accounts and clears the rows it replaced", async () => {
  const db = new FakeSupabase();
  claimQueued(db);
  db.queue("platform_posts", {
    data: [
      platformResult("row-target", "instagram", ACCOUNT, "failed"),
      // The account of this failed result already published: it is skipped.
      platformResult("row-published", "tiktok", ACCOUNT_TWO, "failed"),
      platformResult("row-published-ok", "tiktok", ACCOUNT_TWO, "success"),
      // A failed result without an account: there is nothing to publish to.
      platformResult("row-no-account", "facebook", null, "failed"),
    ],
    error: null,
  });
  // The rows after the publish: a new row for the retried account.
  db.queue("platform_posts", {
    data: [
      platformResult("row-target", "instagram", ACCOUNT, "failed"),
      platformResult("row-new", "instagram", ACCOUNT, "success"),
    ],
    error: null,
  });
  // The delete of the row the publish replaced.
  db.queue("platform_posts", { data: null, error: null });
  db.queueRpc(RELEASE_RPC, { data: true, error: null });

  const { calls, fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const result = await retryFailedPost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });

  assertEquals(result.status, 200);
  // The publish went to the publishing service with the service role.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `${SUPABASE_URL}/functions/v1/process-post`);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers.Authorization, `Bearer ${SERVICE_KEY}`);
  const sent = JSON.parse(String(calls[0].body)) as Record<string, unknown>;
  assertEquals(sent.post_id, POST);
  // Only the failed account is published again, and only on its platform.
  assertEquals(sent.platforms, ["instagram"]);
  assertEquals(sent.account_ids, [ACCOUNT]);
  // The post finished, it is not scheduled: the publishing service must not
  // be asked to match a scheduled instant it does not have.
  assertEquals("expected_scheduled_at" in sent, false);

  // The failed row the publish replaced is removed.
  const removals = callsFor(db, "platform_posts", "delete");
  assertEquals(removals.length, 1);
  assertEquals(hasFilter(removals[0], "eq", "post_id", POST), true);
  assertEquals(hasInFilter(removals[0], "id", ["row-target"]), true);
  // The row of the account that already published is left alone.
  assertEquals(hasInFilter(removals[0], "id", ["row-published"]), false);

  // The claim is given back now that the retry is over.
  assertEquals(rpcCallFor(db, RELEASE_RPC)?.args, {
    p_user_id: USER,
    p_post_id: POST,
    p_claim_id: CLAIM,
  });

  // The answer names what was published again and what was left alone.
  assertEquals(result.body.retried, [{ account_id: ACCOUNT, platform: "instagram" }]);
  const skipped = result.body.skipped as Array<{
    account_id: string | null;
    platform: string | null;
    reason: string;
  }>;
  assertEquals(skipped.length, 2);
  const publishedSkip = skipped.find((skip) => skip.account_id === ACCOUNT_TWO);
  assertEquals(publishedSkip !== undefined, true);
  assertEquals((publishedSkip?.reason ?? "").includes("already published"), true);
  const noAccountSkip = skipped.find((skip) => skip.account_id === null);
  assertEquals(noAccountSkip !== undefined, true);
  assertEquals((noAccountSkip?.reason ?? "").includes("no social account"), true);

  // The new row is the result of the retry.
  const results = result.body.results as Array<{ id: string; status: string }>;
  assertEquals(results.length, 1);
  assertEquals(results[0].id, "row-new");
  assertEquals(results[0].status, "success");
});

Deno.test("a publish that does not answer in time is answered 202 and keeps the claim", async () => {
  const db = new FakeSupabase();
  claimQueued(db);
  db.queue("platform_posts", {
    data: [platformResult("row-target", "instagram", ACCOUNT, "failed")],
    error: null,
  });
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await retryFailedPost(
      { ...depsFor(db, hangingFetcher()), retryDispatchTimeoutMs: 20 },
      USER,
      { post_id: POST },
    );
    // The publish was sent; its answer did not come back in time.
    assertEquals(result.status, 202);
    assertEquals(result.body.status, "results_pending");
    assertEquals(result.body.retried, [{
      account_id: ACCOUNT,
      platform: "instagram",
    }]);
    // The claim is KEPT: releasing it would let a second retry take the post
    // and publish the same account again while the first publish may still be
    // running. The lease runs out on its own.
    assertEquals(rpcCallFor(db, RELEASE_RPC), undefined);
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("did not answer"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a publishing service that cannot be reached is answered 202 and keeps the claim", async () => {
  const db = new FakeSupabase();
  claimQueued(db);
  db.queue("platform_posts", {
    data: [platformResult("row-target", "instagram", ACCOUNT, "failed")],
    error: null,
  });
  const { fetcher } = fakeFetcher([{ reject: new Error("connection refused") }]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await retryFailedPost(depsFor(db, fetcher), USER, {
      post_id: POST,
    });
    assertEquals(result.status, 202);
    assertEquals(result.body.status, "results_pending");
    // The claim is kept for the same reason as on a timeout.
    assertEquals(rpcCallFor(db, RELEASE_RPC), undefined);
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("could not be reached"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a publishing service that refuses the publish is a 502 and the claim is given back", async () => {
  const db = new FakeSupabase();
  claimQueued(db);
  db.queue("platform_posts", {
    data: [platformResult("row-target", "instagram", ACCOUNT, "failed")],
    error: null,
  });
  db.queueRpc(RELEASE_RPC, { data: true, error: null });
  const { fetcher } = fakeFetcher([
    { status: 403, body: { error: "Forbidden" } },
  ]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await retryFailedPost(depsFor(db, fetcher), USER, {
      post_id: POST,
    });
    assertEquals(result.status, 502);
    assertEquals(errorCode(result), "RETRY_FAILED");
    // Nothing was published, so the post is free again right away.
    assertEquals(rpcCallFor(db, RELEASE_RPC)?.args, {
      p_user_id: USER,
      p_post_id: POST,
      p_claim_id: CLAIM,
    });
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("answered 403"), true);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a publishing service that fails is a 502 with a reason that carries no credential", async () => {
  const db = new FakeSupabase();
  claimQueued(db);
  db.queue("platform_posts", {
    data: [platformResult("row-target", "instagram", ACCOUNT, "failed")],
    error: null,
  });
  db.queueRpc(RELEASE_RPC, { data: true, error: null });
  const { fetcher } = fakeFetcher([
    {
      status: 500,
      body: { error: "Instagram refused the media (Bearer secret-token-value)" },
    },
  ]);
  const result = await retryFailedPost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 502);
  assertEquals(errorCode(result), "RETRY_FAILED");
  // The reason is not echoed: it carries the shape of a credential.
  const details = (result.body.error as { details?: { reason?: string } }).details;
  assertEquals(details === undefined || details.reason === undefined, true);
  assertEquals(JSON.stringify(result.body).includes("secret-token-value"), false);
});

Deno.test("a retry whose body cannot be parsed is a 400 and never reaches the posts table", async () => {
  const db = new FakeSupabase();
  const { result: response, logged } = await withCapturedWarn(() =>
    handleRetryFailedPost(
      minimalRequest("/api/v1/posts/retry"),
      db,
      USER,
      MALFORMED_BODY,
    )
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: string; message: string } };
  assertEquals(body.error.code, "INVALID_REQUEST");
  assertEquals(body.error.message, "The request body is not valid JSON.");
  // Nothing is claimed and nothing is published: the refusal only writes its
  // own row.
  assertEquals(db.rpcCalls.length, 0);
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
  assertEquals(
    logged[0],
    `[n8n-api] posts/retry: INVALID_REQUEST (post unknown, user ${USER})`,
  );
});

// ── posts/delete ───────────────────────────────────────────────────────────────

// One published copy of a post: the per-platform result that went out.
function publishedCopy(
  id: string,
  platform: string | null,
  accountId: string | null,
  platformPostId: string | null,
): Record<string, unknown> {
  return {
    id,
    platform,
    platform_post_id: platformPostId,
    social_account_id: accountId,
    status: "success",
    response_data: null,
  };
}

// The account a published copy went out on.
function deleteAccount(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ACCOUNT,
    user_id: USER,
    platform: "facebook",
    access_token: "placeholder",
    ...overrides,
  };
}

// The reads a delete makes, in the order it makes them: the post itself, the
// published copies and the accounts they went out on.
function queueDeleteReads(
  db: FakeSupabase,
  options: {
    mediaFileIds?: string[];
    copies?: Array<Record<string, unknown>>;
    accounts?: Array<Record<string, unknown>>;
  } = {},
): void {
  db.queue("posts", {
    data: {
      id: POST,
      status: "completed",
      media_file_ids: options.mediaFileIds ?? [],
    },
    error: null,
  });
  db.queue("platform_posts", { data: options.copies ?? [], error: null });
  db.queue("social_accounts", { data: options.accounts ?? [], error: null });
}

Deno.test("a delete with a non-uuid post id is refused before anything is claimed", async () => {
  const db = new FakeSupabase();
  const result = await deletePost(depsFor(db, noNetwork()), USER, {
    post_id: "not-a-uuid",
  });
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "INVALID_POST_ID");
  // Nothing is claimed and nothing is deleted: the refusal only writes its
  // own row.
  assertEquals(db.rpcCalls.length, 0);
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a delete whose claim function is not in the database yet is a 503 and deletes nothing", async () => {
  const db = new FakeSupabase();
  // The migration that creates the claim has not been applied to this
  // database yet: PostgREST answers PGRST202.
  db.queueRpc(CLAIM_RPC, { data: null, error: missingRpcError(CLAIM_RPC) });
  const { calls, fetcher } = fakeFetcher([]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await deletePost(depsFor(db, fetcher), USER, {
      post_id: POST,
    });
    // An outage is not a refusal: the caller's request is fine, the database
    // is not ready for it.
    assertEquals(result.status, 503);
    assertEquals(errorCode(result), "FEATURE_NOT_READY");
    assertEquals(
      (result.body.error as { message: string }).message,
      "Deleting a post needs a database update that has not been applied yet.",
    );
    // Nothing is deleted: the claim never came, so the delete never goes.
    assertEquals(calls.length, 0);
    assertEquals(rpcCallFor(db, DELETE_CLAIMED_RPC), undefined);
    // The outage leaves a line behind, and not a refusal row.
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("is not in the database yet"), true);
    assertEquals(callsFor(db, "system_logs", "insert").length, 0);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a delete of a post that is being published to TikTok is a 409, not a 500", async () => {
  const db = new FakeSupabase();
  // The database refused the claim on purpose: the trigger raises P0001 with
  // the DETAIL 'TIKTOK_REVIEW_POST_LOCKED' while the post is mid-publish.
  const triggerMessage =
    "This TikTok post is being published right now and can't be deleted. Try again in a few minutes.";
  db.queueRpc(CLAIM_RPC, {
    data: null,
    error: {
      message: triggerMessage,
      code: "P0001",
      details: "TIKTOK_REVIEW_POST_LOCKED",
    },
  });
  const { result, logged } = await withCapturedWarn(() =>
    deletePost(depsFor(db, noNetwork()), USER, { post_id: POST })
  );
  // A lock is a decision, not a fault: the caller is told what the database
  // said about it.
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_LOCKED");
  assertEquals(
    (result.body.error as { message: string }).message,
    triggerMessage,
  );
  // Nothing is deleted and no claim is given back: there was no claim.
  assertEquals(rpcCallFor(db, DELETE_CLAIMED_RPC), undefined);
  assertEquals(rpcCallFor(db, RELEASE_RPC), undefined);
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
  assertEquals(
    logged.some((line) => line.includes("posts/delete") && line.includes(POST)),
    true,
  );
});

Deno.test("a delete of a post that did not finish publishing is a 409 and names its status", async () => {
  const db = new FakeSupabase();
  db.queueRpc(CLAIM_RPC, {
    data: { outcome: "bad_status", status: "scheduled" },
    error: null,
  });
  const { calls, fetcher } = fakeFetcher([]);
  const result = await deletePost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_NOT_DELETABLE");
  assertEquals(
    (result.body.error as { message: string }).message,
    "Only a post that finished publishing (completed or failed) can be deleted here; use cancel_scheduled_post for a scheduled post.",
  );
  assertEquals(
    (result.body.error as { details: { status: string } }).details.status,
    "scheduled",
  );
  // Nothing is deleted: a scheduled post is the cancel path's business.
  assertEquals(calls.length, 0);
  assertEquals(rpcCallFor(db, DELETE_CLAIMED_RPC), undefined);
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a delete whose platform refused deletes nothing in Postora and gives the claim back", async () => {
  const db = new FakeSupabase();
  claimQueued(db, "completed");
  queueDeleteReads(db, {
    mediaFileIds: [MEDIA],
    copies: [publishedCopy("row-facebook", "facebook", ACCOUNT, "1234567890")],
    // The account has no token, so the platform copy cannot be deleted.
    accounts: [deleteAccount({ access_token: null })],
  });
  db.queueRpc(RELEASE_RPC, { data: true, error: null });

  const { calls, fetcher } = fakeFetcher([]);
  const result = await deletePost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });

  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "PLATFORM_DELETE_FAILED");
  const details = (result.body.error as {
    details: { post_id: string; results: Array<{ outcome: string }> };
  }).details;
  assertEquals(details.post_id, POST);
  assertEquals(details.results[0].outcome, "failed");

  // The Postora record and its media stay: the caller can retry the delete.
  assertEquals(rpcCallFor(db, DELETE_CLAIMED_RPC), undefined);
  assertEquals(callsFor(db, "media_files").length, 0);
  assertEquals(db.storageRemovals.length, 0);
  // The claim is given back, so the next call is not told the post is busy.
  assertEquals(rpcCallFor(db, RELEASE_RPC)?.args, {
    p_user_id: USER,
    p_post_id: POST,
    p_claim_id: CLAIM,
  });
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a delete whose platforms are gone removes the post and then its media", async () => {
  const db = new FakeSupabase();
  claimQueued(db, "completed");
  queueDeleteReads(db, {
    mediaFileIds: [MEDIA],
    copies: [
      publishedCopy("row-facebook", "facebook", ACCOUNT, "1234567890"),
      publishedCopy("row-instagram", "instagram", ACCOUNT_TWO, "9876543210"),
    ],
    accounts: [
      deleteAccount(),
      deleteAccount({ id: ACCOUNT_TWO, platform: "instagram" }),
    ],
  });
  // The media of the post: the read and the delete of its row.
  db.queue("media_files", {
    data: [{ id: MEDIA, file_path: `${MEDIA}.png`, storage_bucket: "media" }],
    error: null,
  });
  db.queue("media_files", { data: null, error: null });
  db.queueRpc(DELETE_CLAIMED_RPC, { data: true, error: null });

  const { calls, fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const result = await deletePost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.post_id, POST);
  assertEquals(result.body.deleted, true);

  // The Facebook copy is deleted on the platform; the Instagram one stays.
  const platforms = result.body.platforms as Array<{
    platform: string;
    outcome: string;
    platform_post_id: string | null;
  }>;
  assertEquals(platforms.length, 2);
  assertEquals(platforms[0].platform, "facebook");
  assertEquals(platforms[0].platform_post_id, "1234567890");
  assertEquals(platforms[0].outcome, "deleted");
  assertEquals(platforms[1].platform, "instagram");
  assertEquals(platforms[1].outcome, "not_supported");

  // The Postora row is deleted while the claim is held.
  const deleteRpc = rpcCallFor(db, DELETE_CLAIMED_RPC);
  assertEquals(deleteRpc?.args, {
    p_user_id: USER,
    p_post_id: POST,
    p_claim_id: CLAIM,
  });

  // The media goes AFTER the post row, and not before: a file that is gone
  // while the post is still there is a file nobody can reach any more.
  const mediaRead = callsFor(db, "media_files", "select")[0];
  assertEquals(mediaRead !== undefined, true);
  assertEquals(
    deleteRpc !== undefined && mediaRead !== undefined && mediaRead.order > deleteRpc.order,
    true,
  );
  // The file lives in the storage, so it is removed there and its row goes.
  assertEquals(db.storageRemovals.length, 1);
  assertEquals(db.storageRemovals[0].bucket, "media");
  assertEquals(db.storageRemovals[0].paths, [`${MEDIA}.png`]);
  assertEquals(result.body.media, { removed: 1, failed: [] });

  // The Facebook copy is the one request that went out: the Instagram copy
  // has no delete endpoint, so nothing was asked of it.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "DELETE");
});

Deno.test("a delete whose claim is not the one on the row is a 409 and the media stays", async () => {
  const db = new FakeSupabase();
  claimQueued(db, "completed");
  queueDeleteReads(db, {
    mediaFileIds: [MEDIA],
    copies: [publishedCopy("row-facebook", "facebook", ACCOUNT, "1234567890")],
    accounts: [deleteAccount()],
  });
  // The row was not deleted: the claim is not the one on the row any more, so
  // somebody else holds the post.
  db.queueRpc(DELETE_CLAIMED_RPC, { data: false, error: null });
  db.queueRpc(RELEASE_RPC, { data: true, error: null });

  const { fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const result = await deletePost(depsFor(db, fetcher), USER, {
    post_id: POST,
  });

  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_STATE_CHANGED");
  // The media is not deleted: the post is still there.
  assertEquals(callsFor(db, "media_files").length, 0);
  assertEquals(db.storageRemovals.length, 0);
  // The claim is given back, so the next call is not told the post is busy for
  // the rest of the lease.
  assertEquals(rpcCallFor(db, RELEASE_RPC)?.args, {
    p_user_id: USER,
    p_post_id: POST,
    p_claim_id: CLAIM,
  });
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
});

Deno.test("a delete of a post that is locked by a TikTok publish gives the claim back", async () => {
  const db = new FakeSupabase();
  claimQueued(db, "completed");
  queueDeleteReads(db, {
    mediaFileIds: [MEDIA],
    // The post is being published right now, so it has no published copy yet.
    copies: [],
    accounts: [],
  });
  // The database refused the delete on purpose: the trigger raises P0001 with
  // the DETAIL 'TIKTOK_REVIEW_POST_LOCKED' while the post is mid-publish.
  const triggerMessage =
    "This TikTok post is being published right now and can't be deleted. Try again in a few minutes.";
  db.queueRpc(DELETE_CLAIMED_RPC, {
    data: null,
    error: {
      message: triggerMessage,
      code: "P0001",
      details: "TIKTOK_REVIEW_POST_LOCKED",
    },
  });
  db.queueRpc(RELEASE_RPC, { data: true, error: null });

  const { fetcher } = fakeFetcher([]);
  const { result, logged } = await withCapturedWarn(() =>
    deletePost(depsFor(db, fetcher), USER, { post_id: POST })
  );

  // A lock is a decision, not a fault: the caller is told what the database
  // said about it.
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_LOCKED");
  assertEquals(
    (result.body.error as { message: string }).message,
    triggerMessage,
  );
  // The claim is given back, so the next call is not told the post is busy for
  // the rest of the lease.
  assertEquals(rpcCallFor(db, RELEASE_RPC)?.args, {
    p_user_id: USER,
    p_post_id: POST,
    p_claim_id: CLAIM,
  });
  // The media is not deleted: the post is still there.
  assertEquals(callsFor(db, "media_files").length, 0);
  assertEquals(db.storageRemovals.length, 0);
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
  // The lock leaves a line behind that names the route and the post.
  assertEquals(
    logged.some((line) => line.includes("posts/delete") && line.includes(POST)),
    true,
  );
});

Deno.test("a delete whose database write fails is a 500 and keeps the claim", async () => {
  const db = new FakeSupabase();
  claimQueued(db, "completed");
  queueDeleteReads(db, {
    mediaFileIds: [MEDIA],
    copies: [],
    accounts: [],
  });
  // The database refused the write for a reason of its own, not on purpose.
  db.queueRpc(DELETE_CLAIMED_RPC, {
    data: null,
    error: { message: "deadlock detected" },
  });

  const { fetcher } = fakeFetcher([]);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await deletePost(depsFor(db, fetcher), USER, {
      post_id: POST,
    });
    assertEquals(result.status, 500);
    assertEquals(errorCode(result), "INTERNAL_ERROR");
    // The claim is KEPT: it is a lease, so it runs out on its own and the
    // caller can try again in the meantime.
    assertEquals(rpcCallFor(db, RELEASE_RPC), undefined);
    // The media is not deleted: the post is still there.
    assertEquals(callsFor(db, "media_files").length, 0);
    assertEquals(db.storageRemovals.length, 0);
    // The fault is logged where it happened, and it is not a refusal.
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes("deleting post"), true);
    assertEquals(callsFor(db, "system_logs", "insert").length, 0);
  } finally {
    console.error = originalError;
  }
});

Deno.test("a delete whose body cannot be parsed is a 400 and never reaches the posts table", async () => {
  const db = new FakeSupabase();
  const { result: response, logged } = await withCapturedWarn(() =>
    handleDeletePost(
      minimalRequest("/api/v1/posts/delete"),
      db,
      USER,
      MALFORMED_BODY,
    )
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: string; message: string } };
  assertEquals(body.error.code, "INVALID_REQUEST");
  assertEquals(body.error.message, "The request body is not valid JSON.");
  // Nothing is claimed and nothing is deleted: the refusal only writes its
  // own row.
  assertEquals(db.rpcCalls.length, 0);
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
  assertEquals(
    logged[0],
    `[n8n-api] posts/delete: INVALID_REQUEST (post unknown, user ${USER})`,
  );
});
