import { assertEquals } from "jsr:@std/assert@1";
import { deletePostMedia, type PostMediaDeleteDeps } from "./postMediaDelete.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const MEDIA = "33333333-3333-4333-8333-333333333333";
const MEDIA_TWO = "44444444-4444-4444-8444-444444444444";
const SUPABASE_URL = "https://api.postora.cloud";
const SERVICE_KEY = "service-role-key";

interface FakeCall {
  table: string;
  op: "select" | "delete";
  filters: Array<[string, ...unknown[]]>;
  payload: unknown;
}

// The query builder of the fake database.
interface MediaBuilder {
  select(columns: string): MediaBuilder;
  delete(): MediaBuilder;
  in(column: string, values: unknown): MediaBuilder;
  eq(column: string, value: unknown): MediaBuilder;
  then(
    onfulfilled?: (value: unknown) => unknown,
    onrejected?: (reason: unknown) => unknown,
  ): Promise<unknown>;
}

// The database boundary of the media delete: a read of the caller's own files
// and the delete of the rows that are gone.
class FakeMediaDb {
  readonly calls: FakeCall[] = [];
  readonly removals: Array<{ bucket: string; paths: string[] }> = [];

  constructor(
    private readonly readResult: { data: unknown; error: { message: string } | null },
    private readonly deleteError: { message: string } | null = null,
    private readonly storageError: { message: string } | null = null,
  ) {}

  from(table: string): MediaBuilder {
    const db = this;
    const filters: Array<[string, ...unknown[]]> = [];
    let op: "select" | "delete" = "select";
    let payload: unknown = undefined;
    const builder: MediaBuilder = {
      select(columns: string) {
        payload = columns;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      in(column: string, values: unknown) {
        filters.push(["in", column, values]);
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push(["eq", column, value]);
        return builder;
      },
      then(
        onfulfilled?: (value: unknown) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) {
        db.calls.push({ table, op, filters: [...filters], payload });
        const result = op === "select"
          ? db.readResult
          : { data: null, error: db.deleteError };
        return Promise.resolve(result).then(onfulfilled, onrejected);
      },
    };
    return builder;
  }

  readonly storage = {
    from: (bucket: string) => ({
      remove: (paths: string[]) => {
        this.removals.push({ bucket, paths });
        return Promise.resolve({ error: this.storageError });
      },
    }),
  };
}

interface RecordedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeFetcher(responses: Array<{ status?: number; body?: unknown }> = []) {
  const calls: RecordedFetch[] = [];
  const queue = [...responses];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
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

function depsFor(
  db: FakeMediaDb,
  fetcher: typeof fetch,
): PostMediaDeleteDeps {
  return {
    supabase: db,
    fetcher,
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_KEY,
  };
}

function hasFilter(
  call: FakeCall | undefined,
  method: string,
  column: string,
  value: unknown,
): boolean {
  if (!call) return false;
  return call.filters.some((entry) =>
    entry[0] === method && entry[1] === column &&
    // The value is compared by its shape: a filter on a list of ids carries
    // an array, and two arrays are the same list only when they say the
    // same thing.
    JSON.stringify(entry[2]) === JSON.stringify(value)
  );
}

function storedFile(
  id: string,
  bucket: string | null,
): Record<string, unknown> {
  return { id, file_path: `${id}.png`, storage_bucket: bucket };
}

Deno.test("a stored file is removed from the storage and its row is deleted", async () => {
  const db = new FakeMediaDb({
    data: [storedFile(MEDIA, "media")],
    error: null,
  });
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePostMedia(depsFor(db, fetcher), {
    userId: USER,
    mediaFileIds: [MEDIA],
  });

  assertEquals(outcome, { removedIds: [MEDIA], failedIds: [] });
  // The file lives in the Supabase storage, so the provider is never called.
  assertEquals(calls.length, 0);
  assertEquals(db.removals, [{ bucket: "media", paths: [`${MEDIA}.png`] }]);

  const removal = db.calls.find((call) => call.op === "delete");
  assertEquals(removal !== undefined, true);
  assertEquals(hasFilter(removal, "in", "id", [MEDIA]), true);
});

Deno.test("a provider file is deleted through the provider service", async () => {
  const db = new FakeMediaDb({
    data: [storedFile(MEDIA, "cloudinary")],
    error: null,
  });
  const { calls, fetcher } = fakeFetcher([
    { status: 200, body: { success: true, deletedMediaFileIds: [MEDIA] } },
  ]);
  const outcome = await deletePostMedia(depsFor(db, fetcher), {
    userId: USER,
    mediaFileIds: [MEDIA],
  });

  assertEquals(outcome, { removedIds: [MEDIA], failedIds: [] });
  // The file is not in the storage, so nothing is removed there.
  assertEquals(db.removals.length, 0);

  // The provider service is called with the service role, and it is told which
  // user it acts for.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `${SUPABASE_URL}/functions/v1/cloudinary-delete`);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers.Authorization, `Bearer ${SERVICE_KEY}`);
  const sent = JSON.parse(String(calls[0].body)) as Record<string, unknown>;
  assertEquals(sent.mediaFileIds, [MEDIA]);
  assertEquals(sent.user_id, USER);

  const removal = db.calls.find((call) => call.op === "delete");
  assertEquals(hasFilter(removal, "in", "id", [MEDIA]), true);
});

Deno.test("a provider file the service did not confirm stays in the library", async () => {
  const db = new FakeMediaDb({
    data: [storedFile(MEDIA, "cloudinary"), storedFile(MEDIA_TWO, "cloudinary")],
    error: null,
  });
  const { fetcher } = fakeFetcher([
    // The service confirmed one of the two files only.
    { status: 200, body: { success: false, deletedMediaFileIds: [MEDIA] } },
  ]);
  const outcome = await deletePostMedia(depsFor(db, fetcher), {
    userId: USER,
    mediaFileIds: [MEDIA, MEDIA_TWO],
  });

  // The row of the file that was not confirmed is not removed: the library
  // still lists it.
  assertEquals(outcome, { removedIds: [MEDIA], failedIds: [MEDIA_TWO] });
  const removal = db.calls.find((call) => call.op === "delete");
  assertEquals(hasFilter(removal, "in", "id", [MEDIA]), true);
  assertEquals(hasFilter(removal, "in", "id", [MEDIA_TWO]), false);
});

Deno.test("a provider service that refuses leaves every provider file in place", async () => {
  const db = new FakeMediaDb({
    data: [storedFile(MEDIA, "cloudinary")],
    error: null,
  });
  const { fetcher } = fakeFetcher([{ status: 500, body: { error: "boom" } }]);
  const outcome = await deletePostMedia(depsFor(db, fetcher), {
    userId: USER,
    mediaFileIds: [MEDIA],
  });

  assertEquals(outcome, { removedIds: [], failedIds: [MEDIA] });
  assertEquals(db.calls.filter((call) => call.op === "delete").length, 0);
});

Deno.test("a read that fails deletes nothing at all", async () => {
  const db = new FakeMediaDb({
    data: null,
    error: { message: "statement timeout" },
  });
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePostMedia(depsFor(db, fetcher), {
    userId: USER,
    mediaFileIds: [MEDIA, MEDIA_TWO],
  });

  // A read that failed cannot say which files may go: every file is reported
  // as still there, and nothing was removed.
  assertEquals(outcome, { removedIds: [], failedIds: [MEDIA, MEDIA_TWO] });
  assertEquals(db.removals.length, 0);
  assertEquals(calls.length, 0);
  assertEquals(db.calls.filter((call) => call.op === "delete").length, 0);
});

Deno.test("the read and the row delete are scoped to the owner", async () => {
  const db = new FakeMediaDb({
    data: [storedFile(MEDIA, "media")],
    error: null,
  });
  const { fetcher } = fakeFetcher();
  await deletePostMedia(depsFor(db, fetcher), {
    userId: USER,
    mediaFileIds: [MEDIA],
  });

  const read = db.calls.find((call) => call.op === "select");
  const removal = db.calls.find((call) => call.op === "delete");
  assertEquals(hasFilter(read, "eq", "user_id", USER), true);
  assertEquals(hasFilter(removal, "eq", "user_id", USER), true);
  // Another user's file is never in the read, so it can never be removed.
  assertEquals(hasFilter(read, "eq", "user_id", OTHER_USER), false);
  assertEquals(hasFilter(removal, "eq", "user_id", OTHER_USER), false);
});

Deno.test("a post without media files has nothing to delete", async () => {
  const db = new FakeMediaDb({ data: [], error: null });
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePostMedia(depsFor(db, fetcher), {
    userId: USER,
    mediaFileIds: [],
  });

  assertEquals(outcome, { removedIds: [], failedIds: [] });
  assertEquals(db.calls.length, 0);
  assertEquals(calls.length, 0);
});
