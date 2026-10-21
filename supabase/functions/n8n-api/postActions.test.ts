import { assertEquals } from "jsr:@std/assert@1";
import type { YouTubeCommentsDeps } from "../_shared/youtubeComments.ts";
import {
  cancelScheduledPost,
  checkAccountHealth,
  computePostingHistogram,
  deletePost,
  readPlatformResults,
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

// A fetcher that fails loudly if a test that expects no network call makes one.
function noNetwork(): typeof fetch {
  return (() =>
    Promise.reject(new Error("this test must not reach the network"))) as unknown as typeof fetch;
}

function fakeYoutubeDeps(): YouTubeCommentsDeps {
  const admin = {
    from: () => {
      const builder: Record<string, unknown> = {
        update: () => builder,
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) => resolve({ error: null }),
      };
      return builder;
    },
  };
  return { admin } as unknown as YouTubeCommentsDeps;
}

function depsFor(db: FakeSupabase, fetcher: typeof fetch): PostActionDeps {
  return {
    supabase: db,
    fetcher,
    now: () => NOW,
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_KEY,
    youtubeDeps: fakeYoutubeDeps,
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

// The position of the first recorded call that matches, so a test can assert that
// one query came before another.
function indexOfCall(
  db: FakeSupabase,
  table: string,
  op: RecordedCall["op"],
): number {
  return db.calls.findIndex((call) => call.table === table && call.op === op);
}

function errorCode(result: { body: Record<string, unknown> }): string {
  return ((result.body.error as { code?: unknown }).code ?? "") as string;
}

function errorDetails(result: { body: Record<string, unknown> }): unknown {
  return (result.body.error as { details?: unknown }).details;
}

// The rows of a read that answered with rows instead of a refusal.
function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(result)) throw new Error("expected rows");
  return result as Array<Record<string, unknown>>;
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

Deno.test("a cancel with a non-uuid post id is refused before the database", async () => {
  const db = new FakeSupabase();
  const result = await cancelScheduledPost(depsFor(db, noNetwork()), USER, {
    post_id: "not-a-uuid",
  });
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "INVALID_POST_ID");
  assertEquals(db.calls.length, 0);
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
  ];

  for (const testCase of cases) {
    const db = new FakeSupabase();
    const result = await reschedulePost(depsFor(db, noNetwork()), USER, testCase.body);
    assertEquals(result.status, 400, testCase.name);
    assertEquals(errorCode(result), testCase.code, testCase.name);
    assertEquals(db.calls.length, 0, testCase.name);
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

// ── platform results ─────────────────────────────────────────────────────────

Deno.test("the results read is scoped to the owner of the post", async () => {
  const db = new FakeSupabase();
  db.queue("platform_posts", {
    data: [
      {
        id: "pp1",
        platform: "facebook",
        status: "failed",
        social_account_id: ACCOUNT,
        posts: { user_id: USER },
      },
    ],
    error: null,
  });

  const results = await readPlatformResults(depsFor(db, noNetwork()), "posts/delete", {
    postId: POST,
    userId: USER,
    columns: "id, platform, status, social_account_id",
  });

  const read = callsFor(db, "platform_posts", "select")[0];
  assertEquals(String(read.payload).includes("posts!inner(user_id)"), true);
  assertEquals(hasFilter(read, "eq", "post_id", POST), true);
  // The ownership is part of the query, not a check the caller has to do first.
  assertEquals(hasFilter(read, "eq", "posts.user_id", USER), true);

  const rows = resultRows(results);
  assertEquals(rows.length, 1);
  assertEquals("posts" in rows[0], false);
  assertEquals(rows[0].id, "pp1");
});

// ── posts/delete ───────────────────────────────────────────────────────────────

Deno.test("a delete removes the record and keeps the media library", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "completed" },
    error: null,
  });
  db.queue("posts", { data: [{ id: POST }], error: null });
  db.queue("platform_posts", {
    data: [
      {
        id: "pp1",
        platform: "facebook",
        status: "success",
        platform_post_id: "fb-1",
        social_account_id: ACCOUNT,
        response_data: null,
      },
      {
        id: "pp2",
        platform: "instagram",
        status: "success",
        platform_post_id: "ig-1",
        social_account_id: ACCOUNT,
        response_data: null,
      },
    ],
    error: null,
  });
  // The ownership check of the row that is cleared.
  db.queue("platform_posts", { data: [{ id: "pp1" }, { id: "pp2" }], error: null });
  db.queue("platform_posts", { data: null, error: null });
  // The results are read once more before the record goes.
  db.queue("platform_posts", {
    data: [{ id: "pp2", status: "success" }],
    error: null,
  });
  db.queue("social_accounts", {
    data: [{ id: ACCOUNT, user_id: USER, platform: "facebook", access_token: "tok" }],
    error: null,
  });

  const { fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const result = await deletePost(depsFor(db, fetcher), USER, { post_id: POST });
  assertEquals(result.status, 200);
  assertEquals(result.body.record_deleted, true);
  assertEquals(result.body.media_kept_in_library, true);
  assertEquals(result.body.kept_despite_failures, undefined);

  const platforms = result.body.platforms as Array<Record<string, unknown>>;
  assertEquals(platforms.length, 2);
  assertEquals(platforms[0].outcome, "deleted");
  assertEquals(platforms[1].platform, "instagram");
  assertEquals(platforms[1].outcome, "kept_on_platform");

  const removal = callsFor(db, "posts", "delete")[0];
  assertEquals(hasFilter(removal, "eq", "user_id", USER), true);
  // The record may not go while a publish is running against it.
  assertEquals(hasFilter(removal, "neq", "status", "processing"), true);
});

Deno.test("a delete never claims the post", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: { id: POST, status: "completed" }, error: null });
  db.queue("platform_posts", { data: [], error: null });
  db.queue("platform_posts", { data: [], error: null });
  db.queue("posts", { data: [{ id: POST }], error: null });

  const { fetcher } = fakeFetcher();
  const result = await deletePost(depsFor(db, fetcher), USER, { post_id: POST });
  assertEquals(result.status, 200);

  // Not one status is written: a claim that is never given back (the function is
  // cut off between two platforms) would leave the post `processing` for good.
  assertEquals(callsFor(db, "posts", "update").length, 0);
});

Deno.test("a deleted copy is cleared before the next platform is asked", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: { id: POST, status: "completed" }, error: null });
  db.queue("posts", { data: [{ id: POST }], error: null });
  db.queue("platform_posts", {
    data: [
      {
        id: "pp1",
        platform: "facebook",
        status: "success",
        platform_post_id: "fb-1",
        social_account_id: ACCOUNT,
        response_data: null,
      },
      {
        id: "pp2",
        platform: "pinterest",
        status: "success",
        platform_post_id: "pin-1",
        social_account_id: ACCOUNT,
        response_data: null,
      },
    ],
    error: null,
  });
  // The ownership check of the row that is cleared, once per cleared row.
  db.queue("platform_posts", { data: [{ id: "pp1" }, { id: "pp2" }], error: null });
  db.queue("platform_posts", { data: null, error: null });
  db.queue("platform_posts", { data: [{ id: "pp1" }, { id: "pp2" }], error: null });
  db.queue("platform_posts", { data: null, error: null });
  // The results are read once more before the record goes.
  db.queue("platform_posts", { data: [], error: null });
  db.queue("social_accounts", {
    data: [{ id: ACCOUNT, user_id: USER, platform: "facebook", access_token: "tok" }],
    error: null,
  });

  // How many queries had been made when each platform was asked to delete.
  const queriesWhenAsked: number[] = [];
  const { fetcher } = fakeFetcher(
    [
      { status: 200, body: { success: true } },
      { status: 200, body: {} },
    ],
    () => {
      queriesWhenAsked.push(db.calls.length);
    },
  );
  const result = await deletePost(depsFor(db, fetcher), USER, { post_id: POST });
  assertEquals(result.status, 200);
  assertEquals(queriesWhenAsked.length, 2);

  // The copy that is gone on Facebook is cleared before Pinterest is asked: a delete
  // that dies halfway must not offer the same copy to a platform again.
  const cleared = callsFor(db, "platform_posts", "delete");
  assertEquals(cleared.length, 2);
  assertEquals(hasInFilter(cleared[0], "id", ["pp1"]), true);
  assertEquals(hasInFilter(cleared[1], "id", ["pp2"]), true);
  const clearedIndex = indexOfCall(db, "platform_posts", "delete");
  assertEquals(clearedIndex < queriesWhenAsked[1], true);
});

Deno.test("a delete is refused while a platform is still publishing", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: { id: POST, status: "completed" }, error: null });
  db.queue("platform_posts", {
    data: [
      { id: "pp1", platform: "tiktok", status: "pending", social_account_id: ACCOUNT },
    ],
    error: null,
  });

  const { calls, fetcher } = fakeFetcher();
  const result = await deletePost(depsFor(db, fetcher), USER, { post_id: POST });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "RESULTS_PENDING");
  assertEquals(errorDetails(result), { pending_platforms: ["tiktok"] });

  // Nothing was deleted on a platform and the record was kept.
  assertEquals(calls.length, 0);
  assertEquals(callsFor(db, "posts", "delete").length, 0);

  // No claim was taken, so the post is not stuck in `processing`.
  assertEquals(callsFor(db, "posts", "update").length, 0);
});

Deno.test("a platform delete that fails keeps the Postora record", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: { id: POST, status: "completed" }, error: null });
  db.queue("platform_posts", {
    data: [
      {
        id: "pp1",
        platform: "facebook",
        status: "success",
        platform_post_id: "fb-1",
        social_account_id: ACCOUNT,
        response_data: null,
      },
    ],
    error: null,
  });
  db.queue("social_accounts", {
    data: [{ id: ACCOUNT, user_id: USER, platform: "facebook", access_token: "tok" }],
    error: null,
  });

  const { fetcher } = fakeFetcher([
    { status: 400, body: { error: { message: "Unsupported delete request." } } },
  ]);
  const result = await deletePost(depsFor(db, fetcher), USER, { post_id: POST });
  assertEquals(result.status, 422);
  assertEquals(errorCode(result), "PLATFORM_DELETE_FAILED");
  const details = errorDetails(result) as { record_deleted: boolean };
  assertEquals(details.record_deleted, false);
  assertEquals(callsFor(db, "posts", "delete").length, 0);

  // No claim was taken, so the post is not stuck in `processing`.
  assertEquals(callsFor(db, "posts", "update").length, 0);
});

Deno.test("a failed platform delete can still be told to delete the record", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: { id: POST, status: "completed" }, error: null });
  db.queue("posts", { data: [{ id: POST }], error: null });
  db.queue("platform_posts", {
    data: [
      {
        id: "pp1",
        platform: "facebook",
        status: "success",
        platform_post_id: "fb-1",
        social_account_id: ACCOUNT,
        response_data: null,
      },
    ],
    error: null,
  });
  // The results are read once more before the record goes.
  db.queue("platform_posts", {
    data: [{ id: "pp1", status: "success" }],
    error: null,
  });
  db.queue("social_accounts", {
    data: [{ id: ACCOUNT, user_id: USER, platform: "facebook", access_token: "tok" }],
    error: null,
  });

  const { fetcher } = fakeFetcher([
    { status: 400, body: { error: { message: "Unsupported delete request." } } },
  ]);
  const result = await deletePost(depsFor(db, fetcher), USER, {
    post_id: POST,
    delete_record_if_platform_fails: true,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.record_deleted, true);
  assertEquals(result.body.kept_despite_failures, true);

  // The failure is still reported honestly.
  const platforms = result.body.platforms as Array<Record<string, unknown>>;
  assertEquals(platforms.length, 1);
  assertEquals(platforms[0].outcome, "failed");
  assertEquals(platforms[0].deleted_on_platform, false);
  assertEquals(callsFor(db, "posts", "delete").length, 1);
  assertEquals(callsFor(db, "posts", "update").length, 0);
});

Deno.test("a form-encoded delete can still be told to delete the record", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: { id: POST, status: "completed" }, error: null });
  db.queue("posts", { data: [{ id: POST }], error: null });
  db.queue("platform_posts", {
    data: [
      {
        id: "pp1",
        platform: "facebook",
        status: "success",
        platform_post_id: "fb-1",
        social_account_id: ACCOUNT,
        response_data: null,
      },
    ],
    error: null,
  });
  // The results are read once more before the record goes.
  db.queue("platform_posts", {
    data: [{ id: "pp1", status: "success" }],
    error: null,
  });
  db.queue("social_accounts", {
    data: [{ id: ACCOUNT, user_id: USER, platform: "facebook", access_token: "tok" }],
    error: null,
  });

  const { fetcher } = fakeFetcher([
    { status: 400, body: { error: { message: "Unsupported delete request." } } },
  ]);
  // n8n sends a form-encoded body, so the flag arrives as the string "true".
  const result = await deletePost(depsFor(db, fetcher), USER, {
    post_id: POST,
    delete_record_if_platform_fails: "true",
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.record_deleted, true);
  assertEquals(result.body.kept_despite_failures, true);
  assertEquals(callsFor(db, "posts", "delete").length, 1);
  assertEquals(callsFor(db, "posts", "update").length, 0);
});

Deno.test("a delete whose accounts cannot be read is a 500", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: { id: POST, status: "completed" }, error: null });
  db.queue("platform_posts", {
    data: [
      {
        id: "pp1",
        platform: "facebook",
        status: "success",
        platform_post_id: "fb-1",
        social_account_id: ACCOUNT,
        response_data: null,
      },
    ],
    error: null,
  });
  db.queue("social_accounts", { data: null, error: { message: "boom" } });

  const result = await deletePost(depsFor(db, noNetwork()), USER, { post_id: POST });
  assertEquals(result.status, 500);
  assertEquals(errorCode(result), "INTERNAL_ERROR");

  // The record was not touched, and no claim was left behind.
  assertEquals(callsFor(db, "posts", "delete").length, 0);
  assertEquals(callsFor(db, "posts", "update").length, 0);
});

Deno.test("a record delete that fails leaves the copy that is gone on the platform cleared", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: { id: POST, status: "completed" }, error: null });
  db.queue("posts", { data: null, error: { message: "boom" } });
  db.queue("platform_posts", {
    data: [
      {
        id: "pp1",
        platform: "facebook",
        status: "success",
        platform_post_id: "fb-1",
        social_account_id: ACCOUNT,
        response_data: null,
      },
    ],
    error: null,
  });
  // The ownership check of the row that is cleared.
  db.queue("platform_posts", { data: [{ id: "pp1" }], error: null });
  db.queue("platform_posts", { data: null, error: null });
  // The results are read once more before the record goes.
  db.queue("platform_posts", { data: [], error: null });
  db.queue("social_accounts", {
    data: [{ id: ACCOUNT, user_id: USER, platform: "facebook", access_token: "tok" }],
    error: null,
  });

  const { fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const result = await deletePost(depsFor(db, fetcher), USER, { post_id: POST });
  assertEquals(result.status, 500);
  assertEquals(errorCode(result), "INTERNAL_ERROR");
  assertEquals(
    (result.body.error as { message: string }).message,
    "Deleting the Postora record failed. Please try again.",
  );

  // The copy that is gone on the platform is not offered to the platform again.
  const cleared = callsFor(db, "platform_posts", "delete")[0];
  assertEquals(hasInFilter(cleared, "id", ["pp1"]), true);
  assertEquals(hasFilter(cleared, "eq", "post_id", POST), true);
  assertEquals(callsFor(db, "posts", "update").length, 0);
});

Deno.test("a publish that lands while the delete runs stops the record delete", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: { id: POST, status: "completed" }, error: null });
  db.queue("platform_posts", {
    data: [
      {
        id: "pp1",
        platform: "facebook",
        status: "success",
        platform_post_id: "fb-1",
        social_account_id: ACCOUNT,
        response_data: null,
      },
    ],
    error: null,
  });
  // The ownership check of the row that is cleared.
  db.queue("platform_posts", { data: [{ id: "pp1" }], error: null });
  db.queue("platform_posts", { data: null, error: null });
  // A result that was not there when the delete started: a publish landed.
  db.queue("platform_posts", {
    data: [{ id: "pp9", status: "success" }],
    error: null,
  });
  db.queue("social_accounts", {
    data: [{ id: ACCOUNT, user_id: USER, platform: "facebook", access_token: "tok" }],
    error: null,
  });

  const { fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const result = await deletePost(depsFor(db, fetcher), USER, { post_id: POST });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_STATE_CHANGED");
  assertEquals(
    (result.body.error as { message: string }).message,
    "The post was published again while it was being deleted. Check get_post.",
  );
  const details = errorDetails(result) as { record_deleted: boolean };
  assertEquals(details.record_deleted, false);

  // The record stays: removing it would orphan the new result.
  assertEquals(callsFor(db, "posts", "delete").length, 0);
  assertEquals(callsFor(db, "posts", "update").length, 0);
});

Deno.test("a post that is publishing right now cannot be deleted", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: { id: POST, status: "processing", platform_posts: [] },
    error: null,
  });
  const result = await deletePost(depsFor(db, noNetwork()), USER, { post_id: POST });
  assertEquals(result.status, 409);
  assertEquals(errorCode(result), "POST_PROCESSING");
  assertEquals(db.calls.length, 1);
});

// ── accounts/health ────────────────────────────────────────────────────────────

Deno.test("a health check with a non-uuid account id is refused", async () => {
  const db = new FakeSupabase();
  const result = await checkAccountHealth(depsFor(db, noNetwork()), USER, "not-a-uuid");
  assertEquals(result.status, 400);
  assertEquals(errorCode(result), "INVALID_ACCOUNT_ID");
  assertEquals(db.calls.length, 0);
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

// ── best-times ─────────────────────────────────────────────────────────────────

Deno.test("the posting histogram counts the local hour and the local weekday", () => {
  const histogram = computePostingHistogram(["2026-10-04T21:30:00Z"], "Asia/Kuwait");
  assertEquals(histogram.hourCounts, { 0: 1 });
  assertEquals(histogram.dayCounts, { 1: 1 });
  assertEquals(histogram.totalPosts, 1);
});

Deno.test("the best-times request carries the platforms and the history", async () => {
  const db = new FakeSupabase();
  db.queue("posts", {
    data: [{ posted_at: "2026-10-04T21:30:00Z" }],
    error: null,
  });
  const { calls, fetcher } = fakeFetcher([
    { status: 200, body: { suggestions: [{ platform: "instagram", day: "Monday" }] } },
  ]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram"] },
    "Asia/Kuwait",
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.timezone, "Asia/Kuwait");
  assertEquals(result.body.based_on_posts, 1);
  assertEquals(result.body.suggestions, [{ platform: "instagram", day: "Monday" }]);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `${SUPABASE_URL}/functions/v1/suggest-best-times`);
  assertEquals(calls[0].headers.Authorization, `Bearer ${SERVICE_KEY}`);
  const sent = JSON.parse(String(calls[0].body)) as {
    platforms: string[];
    historicalData: { hourCounts: Record<string, number>; dayCounts: Record<string, number>; totalPosts: number };
  };
  assertEquals(sent.platforms, ["instagram"]);
  assertEquals(sent.historicalData.hourCounts, { "0": 1 });
  assertEquals(sent.historicalData.dayCounts, { "1": 1 });
  assertEquals(sent.historicalData.totalPosts, 1);
});

Deno.test("a best-times service that refuses is a 502", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: [], error: null });
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

Deno.test("a timezone the runtime does not know falls back to UTC", async () => {
  const db = new FakeSupabase();
  db.queue("posts", { data: [], error: null });
  const { fetcher } = fakeFetcher([{ status: 200, body: { suggestions: [] } }]);
  const result = await suggestBestTimes(
    depsFor(db, fetcher),
    USER,
    { platforms: ["instagram"] },
    "Mars/Olympus",
  );
  assertEquals(result.status, 200);
  assertEquals(result.body.timezone, "UTC");
});
