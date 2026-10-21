import { assertEquals } from "jsr:@std/assert@1";
import {
  deletePostMedia,
  isOwnStoragePath,
  type PostMediaDeleteDeps,
} from "./postMediaDelete.ts";

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
  overrides: Partial<PostMediaDeleteDeps> = {},
): PostMediaDeleteDeps {
  return {
    supabase: db,
    fetcher,
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_KEY,
    ...overrides,
  };
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

// A fetcher whose headers arrive only after most of the deadline of the call
// has passed, and whose body never arrives. The call must give up at the end
// of the deadline it was given, and not a deadline later.
function slowHeadersStalledBodyFetcher(delayMs: number): {
  fetcher: typeof fetch;
  wasCancelled: () => boolean;
} {
  const state = { cancelled: false };
  const fetcher = (() =>
    new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(
          new Response(
            new ReadableStream({
              pull() {
                return new Promise<void>(() => {});
              },
              cancel() {
                state.cancelled = true;
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }, delayMs);
    })) as unknown as typeof fetch;
  return { fetcher, wasCancelled: () => state.cancelled };
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

// A stored file, at the path the upload convention gives it: every upload
// goes to `${userId}/${fileName}`.
function storedFile(
  id: string,
  bucket: string | null,
  userId: string = USER,
): Record<string, unknown> {
  return { id, file_path: `${userId}/${id}.png`, storage_bucket: bucket };
}

// A stored file whose path points outside the caller's own folder.
function foreignFile(
  id: string,
  bucket: string | null,
): Record<string, unknown> {
  return storedFile(id, bucket, OTHER_USER);
}

Deno.test("a path under the caller's own folder is the caller's own file", () => {
  assertEquals(isOwnStoragePath(`${USER}/x.png`, USER), true);
  // A file in a subfolder of the caller's own folder is still their own.
  assertEquals(isOwnStoragePath(`${USER}/sub/x.png`, USER), true);
});

Deno.test("a path that climbs out of the caller's own folder is not the caller's own file", () => {
  // The prefix is not enough: these paths start with the folder of the caller
  // and still point somewhere else.
  assertEquals(isOwnStoragePath(`${USER}/../other/x.png`, USER), false);
  assertEquals(isOwnStoragePath(`${USER}//x.png`, USER), false);
  assertEquals(isOwnStoragePath(`${USER}/a\\b.png`, USER), false);
  assertEquals(isOwnStoragePath(`${USER}/./x.png`, USER), false);
});

Deno.test("a path of another account is not the caller's own file", () => {
  assertEquals(isOwnStoragePath(`${OTHER_USER}/x.png`, USER), false);
  assertEquals(isOwnStoragePath("/x.png", USER), false);
  assertEquals(isOwnStoragePath(`${USER}`, USER), false);
});

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
  assertEquals(db.removals, [{ bucket: "media", paths: [`${USER}/${MEDIA}.png`] }]);

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

Deno.test("a stored file that is not in the caller's own folder is not removed and its row stays", async () => {
  const db = new FakeMediaDb({
    data: [storedFile(MEDIA, "media"), foreignFile(MEDIA_TWO, "media")],
    error: null,
  });
  const { fetcher } = fakeFetcher();
  const outcome = await deletePostMedia(depsFor(db, fetcher), {
    userId: USER,
    mediaFileIds: [MEDIA, MEDIA_TWO],
  });

  // Only the caller's own file is removed: the path of the other one points
  // outside the caller's folder, so it is not the caller's file to remove.
  assertEquals(outcome, { removedIds: [MEDIA], failedIds: [MEDIA_TWO] });
  assertEquals(db.removals, [{ bucket: "media", paths: [`${USER}/${MEDIA}.png`] }]);

  // The row of the file that was not removed stays: the library still lists
  // it, and the caller is told that it is still there.
  const removal = db.calls.find((call) => call.op === "delete");
  assertEquals(hasFilter(removal, "in", "id", [MEDIA]), true);
  assertEquals(hasFilter(removal, "in", "id", [MEDIA_TWO]), false);
});

Deno.test("a stored file whose path climbs out of the caller's own folder is not removed and its row stays", async () => {
  // The path of the row is written by the client that uploaded the file, and
  // the service role removes whatever it is told to remove: a path that
  // climbs out of the caller's own folder is not the caller's file.
  const db = new FakeMediaDb({
    data: [
      { id: MEDIA, file_path: `${USER}/../other/${MEDIA}.png`, storage_bucket: "media" },
    ],
    error: null,
  });
  const { fetcher } = fakeFetcher();
  const outcome = await deletePostMedia(depsFor(db, fetcher), {
    userId: USER,
    mediaFileIds: [MEDIA],
  });

  assertEquals(outcome, { removedIds: [], failedIds: [MEDIA] });
  assertEquals(db.removals.length, 0);
  assertEquals(db.calls.filter((call) => call.op === "delete").length, 0);
});

Deno.test("a media delete service whose body never arrives leaves the provider files in the library", async () => {
  const db = new FakeMediaDb({
    data: [storedFile(MEDIA, "cloudinary")],
    error: null,
  });
  const { fetcher, wasCancelled } = stalledBodyFetcher();
  const outcome = await deletePostMedia(
    depsFor(db, fetcher, { providerTimeoutMs: 20 }),
    { userId: USER, mediaFileIds: [MEDIA] },
  );

  // The service answered with its headers and then with nothing: it never
  // said which files it deleted, so none of them is gone.
  assertEquals(outcome, { removedIds: [], failedIds: [MEDIA] });
  assertEquals(db.calls.filter((call) => call.op === "delete").length, 0);
  // The body is cancelled, so the connection to the service is released.
  assertEquals(wasCancelled(), true);
});

Deno.test("a media delete service whose headers take most of the deadline fails within one deadline", async () => {
  // The headers arrive late and the body never does: the call must give up
  // at the end of the deadline it was given. The body read does not get a
  // deadline of its own, or the call would last twice as long.
  const timeoutMs = 200;
  const db = new FakeMediaDb({
    data: [storedFile(MEDIA, "cloudinary")],
    error: null,
  });
  const { fetcher } = slowHeadersStalledBodyFetcher(Math.round(timeoutMs * 0.8));
  const startedAt = Date.now();
  const outcome = await deletePostMedia(
    depsFor(db, fetcher, { providerTimeoutMs: timeoutMs }),
    { userId: USER, mediaFileIds: [MEDIA] },
  );
  const elapsed = Date.now() - startedAt;

  assertEquals(outcome, { removedIds: [], failedIds: [MEDIA] });
  assertEquals(db.calls.filter((call) => call.op === "delete").length, 0);
  // One deadline, not two: the body read gets what is left of it.
  assertEquals(elapsed < timeoutMs * 1.4, true);
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
