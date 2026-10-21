import { assertEquals } from "jsr:@std/assert@1";
import {
  cancelScheduledPost,
  checkAccountHealth,
  computePostingHistogram,
  handleCancelScheduledPost,
  handleReschedulePost,
  handleSuggestBestTimes,
  isBestTimeSuggestion,
  reschedulePost,
  suggestBestTimes,
  type PostActionDeps,
} from "./postActions.ts";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const USER = "11111111-1111-4111-8111-111111111111";
const POST = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const SERVICE_KEY = "service-role-key";
const SUPABASE_URL = "https://api.postora.cloud";
const SCHEDULED_STATUSES = ["scheduled", "pending"];

// ── fake Supabase ──────────────────────────────────────────────────────────────

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

interface RecordedCall {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  filters: Array<[string, ...unknown[]]>;
  /** The select columns for a select, the data object for an insert/update. */
  payload: unknown;
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
  private readonly queues = new Map<string, FakeResult[]>();

  queue(table: string, result: FakeResult): this {
    const list = this.queues.get(table) ?? [];
    list.push(result);
    this.queues.set(table, list);
    return this;
  }

  from(table: string): FakeBuilder {
    return new FakeBuilder(this, table);
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

  record(call: RecordedCall): void {
    this.calls.push(call);
  }
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
  db.queue("posts", { data: [{ id: POST }], error: null });
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
});

Deno.test("the cancel delete is a compare-and-set against the scheduler", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-22T12:00:00.000Z" },
    error: null,
  });
  db.queue("posts", { data: [{ id: POST }], error: null });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 200);
  const removal = callsFor(db, "posts", "delete")[0];
  assertEquals(hasFilter(removal, "eq", "id", POST), true);
  assertEquals(hasFilter(removal, "eq", "user_id", USER), true);
  assertEquals(hasInFilter(removal, "status", SCHEDULED_STATUSES), true);
  assertEquals(hasFilter(removal, "gt", "scheduled_at", NOW_ISO), true);
  assertEquals(result.body, {
    success: true,
    post_id: POST,
    cancelled: true,
  });
});

Deno.test("the cancel delete is checked against the clock at the moment of the write", async () => {
  const db = new FakeSupabase();
  // The post is due in an hour, but the request takes two: by the time the
  // delete goes out the post is overdue, and a deadline taken when the request
  // began would let the delete through anyway.
  const writeTime = new Date("2026-10-21T14:00:00.000Z");
  db.queue("posts", {
    data: { id: POST, status: "scheduled", scheduled_at: "2026-10-21T13:00:00.000Z" },
    error: null,
  });
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
  db.queue("posts", { data: [], error: null });
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
  });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_STATE_CHANGED");
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
  db.queue("posts", {
    data: [{ id: POST, status: "scheduled", scheduled_at: "2027-01-01T04:30:00.000Z" }],
    error: null,
  });

  // The written date is the one that is published: the offset only says which
  // instant it is.
  const result = await reschedulePost(depsFor(db, noNetwork()), USER, {
    post_id: POST,
    scheduled_at: "2026-12-31T23:30:00-05:00",
  });
  assertEquals(result.status, 200);
  const update = callsFor(db, "posts", "update")[0];
  assertEquals(update.payload, { scheduled_at: "2027-01-01T04:30:00.000Z" });
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
  db.queue("posts", {
    data: [{ id: POST, status: "scheduled", scheduled_at: "2026-12-01T10:00:00.000Z" }],
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
  const update = callsFor(db, "posts", "update")[0];
  // The metadata is not rebuilt from the earlier read: that would overwrite a
  // dashboard edit that landed in the meantime.
  assertEquals(update.payload, { scheduled_at: "2026-12-01T10:00:00.000Z" });
  assertEquals("metadata" in (update.payload as Record<string, unknown>), false);
  assertEquals(hasFilter(update, "eq", "user_id", USER), true);
  assertEquals(hasInFilter(update, "status", SCHEDULED_STATUSES), true);
  assertEquals(hasFilter(update, "gt", "scheduled_at", NOW_ISO), true);
  const body = result.body as { post: { scheduled_at: string }; previous_scheduled_at: string };
  assertEquals(body.post.scheduled_at, "2026-12-01T10:00:00.000Z");
  assertEquals(body.previous_scheduled_at, "2026-10-22T12:00:00.000Z");
});

Deno.test("a reschedule whose new time has come while the post was read is refused", async () => {
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
  const result = await reschedulePost(
    depsFor(db, noNetwork(), advancingClock(NOW, writeTime)),
    USER,
    { post_id: POST, scheduled_at: "2026-10-21T12:05:00.000Z" },
  );
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "SCHEDULED_AT_IN_PAST");
  // The post was not moved: an instant that has already come cannot be
  // scheduled.
  assertEquals(callsFor(db, "posts", "update").length, 0);
  // The refusal leaves a durable row behind.
  assertEquals(callsFor(db, "system_logs", "insert").length, 1);
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
