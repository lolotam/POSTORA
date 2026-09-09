import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DOWNLOAD_URL_TTL_SECONDS,
  resolveSourceDownload,
  type SignerLike,
  type SourceReader,
  type SourceRow,
} from "./downloadSource.ts";

const OWNER = { userId: "11111111-1111-1111-1111-111111111111", email: "owner@example.com" };
const OTHER_USER = "22222222-2222-2222-2222-222222222222";
const SOURCE_ID = "33333333-3333-3333-3333-333333333333";

/**
 * Stands in for the Supabase client. The database is a system boundary, so the
 * assertions are on what comes back for a given set of filters -- in particular
 * that the user_id filter is applied on the read, not after it.
 */
function fakeReader(rows: Array<SourceRow & { user_id: string }>) {
  const filters: Record<string, unknown> = {};
  const query = {
    select: () => query,
    eq(column: string, value: unknown) {
      filters[column] = value;
      return query;
    },
    maybeSingle() {
      const match = rows.find(
        (row) => row.id === filters.id && row.user_id === filters.user_id,
      );
      return Promise.resolve({ data: match ? { ...match } : null });
    },
  };
  return { reader: { from: () => query } as unknown as SourceReader, filters };
}

function fakeSigner(signedUrl: string | null) {
  const calls: Array<{ bucket: string; path: string; ttl: number; download: string }> = [];
  const signer = {
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl(path: string, ttl: number, options: { download: string }) {
            calls.push({ bucket, path, ttl, download: options.download });
            return Promise.resolve(
              signedUrl
                ? { data: { signedUrl } }
                : { data: null, error: new Error("sign failed") },
            );
          },
        };
      },
    },
  } as unknown as SignerLike;
  return { signer, calls };
}

const ownedRow = {
  id: SOURCE_ID,
  user_id: OWNER.userId,
  file_name: "prices.csv",
  file_path: `supabase://ai-knowledge/${OWNER.userId}/prices.csv`,
};

Deno.test("a malformed or missing source id is not found", async () => {
  const { reader } = fakeReader([ownedRow]);
  const { signer } = fakeSigner("https://api.example.com/signed");

  for (const id of [undefined, null, "", 42, {}]) {
    const outcome = await resolveSourceDownload(reader, signer, OWNER, id);
    assertEquals(outcome, { ok: false, reason: "not_found", sourceId: null });
  }
});

Deno.test("another user's source is indistinguishable from one that does not exist", async () => {
  const foreign = { ...ownedRow, user_id: OTHER_USER };
  const { reader: foreignReader } = fakeReader([foreign]);
  const { reader: emptyReader } = fakeReader([]);
  const { signer } = fakeSigner("https://api.example.com/signed");

  const notMine = await resolveSourceDownload(foreignReader, signer, OWNER, SOURCE_ID);
  const unknown = await resolveSourceDownload(emptyReader, signer, OWNER, SOURCE_ID);

  // Identical outcomes: a different answer for "exists but not yours" would
  // confirm to a caller that the id exists in someone else's library.
  assertEquals(notMine, unknown);
  assertEquals(notMine.ok, false);
});

Deno.test("the ownership filter is applied on the read itself", async () => {
  const { reader, filters } = fakeReader([ownedRow]);
  const { signer } = fakeSigner("https://api.example.com/signed");

  await resolveSourceDownload(reader, signer, OWNER, SOURCE_ID);

  assertEquals(filters.id, SOURCE_ID);
  assertEquals(filters.user_id, OWNER.userId);
});

Deno.test("a file_path outside the owner's folder is not found", async () => {
  const escaping = {
    ...ownedRow,
    file_path: `supabase://ai-knowledge/${OTHER_USER}/secret.csv`,
  };
  const { reader } = fakeReader([escaping]);
  const { signer, calls } = fakeSigner("https://api.example.com/signed");

  const outcome = await resolveSourceDownload(reader, signer, OWNER, SOURCE_ID);

  assertEquals(outcome, { ok: false, reason: "not_found", sourceId: SOURCE_ID });
  // Nothing was signed: the resolver refused before a credential was minted.
  assertEquals(calls.length, 0);
});

Deno.test("a null file_path is not found", async () => {
  const { reader } = fakeReader([{ ...ownedRow, file_path: null }]);
  const { signer, calls } = fakeSigner("https://api.example.com/signed");

  const outcome = await resolveSourceDownload(reader, signer, OWNER, SOURCE_ID);

  assertEquals(outcome, { ok: false, reason: "not_found", sourceId: SOURCE_ID });
  assertEquals(calls.length, 0);
});

Deno.test("an owned storage file is signed with its own name as the download", async () => {
  const { reader } = fakeReader([ownedRow]);
  const { signer, calls } = fakeSigner("https://api.example.com/signed?token=abc");

  const outcome = await resolveSourceDownload(reader, signer, OWNER, SOURCE_ID);

  assertEquals(outcome, {
    ok: true,
    url: "https://api.example.com/signed?token=abc",
    sourceId: SOURCE_ID,
  });
  assertEquals(calls, [{
    bucket: "ai-knowledge",
    path: `${OWNER.userId}/prices.csv`,
    ttl: DOWNLOAD_URL_TTL_SECONDS,
    download: "prices.csv",
  }]);
});

Deno.test("a source with no file_name falls back to its id as the download name", async () => {
  const { reader } = fakeReader([{ ...ownedRow, file_name: null }]);
  const { signer, calls } = fakeSigner("https://api.example.com/signed");

  await resolveSourceDownload(reader, signer, OWNER, SOURCE_ID);

  assertEquals(calls[0].download, SOURCE_ID);
});

Deno.test("a signing failure is reported separately but is still not a success", async () => {
  const { reader } = fakeReader([ownedRow]);
  const { signer } = fakeSigner(null);

  const outcome = await resolveSourceDownload(reader, signer, OWNER, SOURCE_ID);

  assertEquals(outcome, { ok: false, reason: "sign_failed", sourceId: SOURCE_ID });
  // Distinct from not_found only so the caller can log it; both are 404s.
  assertNotEquals(outcome.ok, true);
});

Deno.test("a failed read is reported as read_failed, not as a missing row", async () => {
  const failingQuery: Record<string, unknown> = {};
  failingQuery.select = () => failingQuery;
  failingQuery.eq = () => failingQuery;
  failingQuery.maybeSingle = () =>
    Promise.resolve({ data: null, error: new Error("statement timeout") });
  const failing = { from: () => failingQuery } as unknown as SourceReader;
  const { signer, calls } = fakeSigner("https://api.example.com/signed");

  const outcome = await resolveSourceDownload(failing, signer, OWNER, SOURCE_ID);

  // Telling the owner of an existing source that it is gone, because PostgREST
  // timed out, is the failure this separates out.
  assertEquals(outcome, { ok: false, reason: "read_failed", sourceId: SOURCE_ID });
  assertEquals(calls.length, 0);
});

Deno.test("a source id that is not a uuid is refused before the query runs", async () => {
  let queried = false;
  const watchedQuery: Record<string, unknown> = {};
  watchedQuery.select = () => watchedQuery;
  watchedQuery.eq = () => watchedQuery;
  watchedQuery.maybeSingle = () => Promise.resolve({ data: null });
  const watching = {
    from: () => {
      queried = true;
      return watchedQuery;
    },
  } as unknown as SourceReader;
  const { signer } = fakeSigner("https://api.example.com/signed");

  const outcome = await resolveSourceDownload(watching, signer, OWNER, "not-a-uuid");

  // Refused up front so PostgREST's 22P02 cast error stays distinguishable from
  // a genuine outage now that read errors are propagated.
  assertEquals(outcome, { ok: false, reason: "not_found", sourceId: null });
  assertEquals(queried, false);
});
