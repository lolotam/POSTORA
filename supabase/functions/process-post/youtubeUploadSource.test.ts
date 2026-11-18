/**
 * Rebuilding the source of an owned video.
 *
 * The continuation that carries a YouTube upload on has to read the video
 * again. It has to read THE video: the file the post names, at the content
 * version the upload started with, out of the bucket the file really lives
 * in.
 *
 * These are the cases where a shortcut would put the wrong bytes on the
 * customer's channel:
 *
 *   * a hard-coded bucket: the same path in another bucket is another
 *     object, and a file in the `media` bucket must not be signed in the
 *     `supabase` bucket;
 *   * a provider row of a STALE content version: a rename bumps the version
 *     and the old row stays "ready" with a dead URL;
 *   * a provider row of a version that is not the file's: the delivery URL
 *     of another file is not this file;
 *   * a host outside the approved policy: it must never receive a request.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createOwnedVideoSource, VideoSourceUnavailableError } from "./youtubeUploadSource.ts";
import { YOUTUBE_UPLOAD_REASON } from "./youtubeUploadPolicy.ts";

const MEDIA_ID = "media-1";
const OWNER = "user-1";
/** The path of the file inside its bucket: the owner's own prefix. */
const FILE_PATH = `${OWNER}/video.mp4`;
const HOST = "https://media.fixture.invalid";
const SIGNED_PATH = `/storage/v1/object/sign/media/${OWNER}/video.mp4?token=secret-token`;

/** What the fake database was asked for. */
interface Fixture {
  /** The buckets a signed URL was asked for. */
  signedBuckets: string[];
  /** The paths a signed URL was asked for. */
  signedPaths: string[];
  /** The URLs the source asked for over the network. */
  fetched: string[];
}

interface FixtureOptions {
  bucket?: string;
  filePath?: string;
  currentVersion?: number;
  providerRows?: Array<{ provider: string; object_version: number | null; status: string; delivery_url: string | null }>;
  readPreference?: string;
  /** The URL the signed URL resolves to. */
  signedUrl?: string;
  /** The answer the media host gives to the probe. */
  probeStatus?: number;
}

/**
 * A Supabase client that answers only what the resolver asks for.
 *
 * Everything it is asked is recorded, so the test can prove that the source
 * was rebuilt from the file's own bucket and rows.
 */
function fixture(options: FixtureOptions = {}): { client: unknown; seen: Fixture } {
  const seen: Fixture = { signedBuckets: [], signedPaths: [], fetched: [] };
  const bucket = options.bucket ?? "media";
  const filePath = options.filePath ?? FILE_PATH;
  const signedUrl = options.signedUrl ?? `${HOST}${SIGNED_PATH}`;
  const rows = options.providerRows ?? [];

  const client = {
    from(table: string) {
      const builder = {
        select(_columns: string) {
          return builder;
        },
        eq(_column: string, _value: unknown) {
          return builder;
        },
        in(_column: string, _values: unknown) {
          return builder;
        },
        maybeSingle() {
          if (table === "app_settings") {
            return Promise.resolve({
              data: { value: { read_preference: options.readPreference ?? "openinary" } },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(onFulfilled: (value: unknown) => unknown) {
          const value = table === "media_file_providers"
            ? { data: rows.map((row) => ({ media_file_id: MEDIA_ID, ...row })), error: null }
            : { data: [], error: null };
          onFulfilled(value);
          return Promise.resolve(value);
        },
      };
      return builder;
    },
    storage: {
      from(requestedBucket: string) {
        return {
          createSignedUrl(requestedPath: string, _expires: number) {
            seen.signedBuckets.push(requestedBucket);
            seen.signedPaths.push(requestedPath);
            return Promise.resolve({ data: { signedUrl }, error: null });
          },
        };
      },
    },
  };
  return { client, seen };
}

/** A media host that answers the probe with a range and a size. */
function mediaFetch(seen: Fixture, status = 206) {
  return (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    seen.fetched.push(url);
    if (status === 200) {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-length": "4", "content-type": "video/mp4" },
      }));
    }
    return Promise.resolve(new Response(new Uint8Array([1]), {
      status: 206,
      headers: {
        "content-range": "bytes 0-0/4",
        "content-length": "1",
        "content-type": "video/mp4",
      },
    }));
  };
}

// The approved media hosts are HOSTS, not origins.
const hosts = new Set(["media.fixture.invalid"]);

for (const bucket of ["media", "supabase"]) {
  Deno.test(`a file in the ${bucket} bucket is signed in the ${bucket} bucket`, async () => {
    const { client, seen } = fixture({ bucket, filePath: FILE_PATH });
    const source = await createOwnedVideoSource({
      supabase: client as never,
      file: {
        id: MEDIA_ID,
        userId: OWNER,
        filePath: FILE_PATH,
        storageBucket: bucket,
        mimeType: "video/mp4",
        currentObjectVersion: 1,
      },
      mediaHosts: hosts,
      fetchImpl: mediaFetch(seen) as unknown as typeof fetch,
    });

    assertEquals(source.size, 4);
    // The bucket is the file's own. It is not hard-coded.
    assertEquals(seen.signedBuckets, [bucket]);
    assertEquals(seen.signedPaths, [FILE_PATH]);
  });
}

Deno.test("a provider row of the current version is used instead of the bucket", async () => {
  const { client, seen } = fixture({
    bucket: "media",
    currentVersion: 3,
    providerRows: [
      { provider: "openinary", object_version: 3, status: "ready", delivery_url: `${HOST}/cdn/openinary/video.mp4` },
    ],
  });
  const source = await createOwnedVideoSource({
    supabase: client as never,
    file: {
      id: MEDIA_ID,
      userId: OWNER,
      filePath: FILE_PATH,
      storageBucket: "media",
      mimeType: "video/mp4",
      currentObjectVersion: 3,
    },
    mediaHosts: hosts,
    fetchImpl: mediaFetch(seen) as unknown as typeof fetch,
  });

  assertEquals(source.size, 4);
  // No signed URL was needed: the provider already had the delivery URL.
  assertEquals(seen.signedBuckets, []);
  // And the bytes came from the provider's URL.
  assertEquals(seen.fetched.length, 1);
  assert(seen.fetched[0].includes("/cdn/openinary/video.mp4"));
});

// A provider row is only usable when it belongs to the file's CURRENT content
// version and says it is ready. A stale row and an unfinished row are both
// ignored, so the file is signed for its own bucket instead.
for (const row of [
  { name: "stale", object_version: 1, status: "ready", delivery_url: `${HOST}/cdn/openinary/stale.mp4` },
  { name: "unfinished", object_version: 2, status: "uploading", delivery_url: `${HOST}/cdn/openinary/pending.mp4` },
]) {
  Deno.test(`a provider row that is ${row.name} is not used`, async () => {
    const { client, seen } = fixture({
      bucket: "media",
      currentVersion: 2,
      providerRows: [{ provider: "openinary", ...row }],
    });
    await createOwnedVideoSource({
      supabase: client as never,
      file: {
        id: MEDIA_ID,
        userId: OWNER,
        filePath: FILE_PATH,
        storageBucket: "media",
        mimeType: "video/mp4",
        currentObjectVersion: 2,
      },
      mediaHosts: hosts,
      fetchImpl: mediaFetch(seen) as unknown as typeof fetch,
    });

    // The row was ignored, so the file was signed for its own bucket.
    assertEquals(seen.signedBuckets, ["media"]);
    assertEquals(seen.fetched.every((url) => !url.includes("/cdn/openinary/")), true);
  });
}

Deno.test("the read preference decides which provider is used", async () => {
  const rows = [
    { provider: "openinary", object_version: 1, status: "ready", delivery_url: `${HOST}/cdn/openinary/video.mp4` },
    { provider: "cloudinary", object_version: 1, status: "ready", delivery_url: `${HOST}/cdn/cloudinary/video.mp4` },
  ];

  const openinary = fixture({ providerRows: rows, readPreference: "openinary" });
  await createOwnedVideoSource({
    supabase: openinary.client as never,
    file: {
      id: MEDIA_ID,
      userId: OWNER,
      filePath: FILE_PATH,
      storageBucket: "media",
      mimeType: "video/mp4",
      currentObjectVersion: 1,
    },
    mediaHosts: hosts,
    fetchImpl: mediaFetch(openinary.seen) as unknown as typeof fetch,
  });
  assert(openinary.seen.fetched[0].includes("/cdn/openinary/video.mp4"));

  const cloudinary = fixture({ providerRows: rows, readPreference: "cloudinary" });
  await createOwnedVideoSource({
    supabase: cloudinary.client as never,
    file: {
      id: MEDIA_ID,
      userId: OWNER,
      filePath: FILE_PATH,
      storageBucket: "media",
      mimeType: "video/mp4",
      currentObjectVersion: 1,
    },
    mediaHosts: hosts,
    fetchImpl: mediaFetch(cloudinary.seen) as unknown as typeof fetch,
  });
  assert(cloudinary.seen.fetched[0].includes("/cdn/cloudinary/video.mp4"));
});

Deno.test("a host outside the approved policy is refused before any request", async () => {
  const { client, seen } = fixture({ bucket: "media" });
  let refused: unknown;
  try {
    await createOwnedVideoSource({
      supabase: client as never,
      file: {
        id: MEDIA_ID,
        userId: OWNER,
        filePath: FILE_PATH,
        storageBucket: "media",
        mimeType: "video/mp4",
        currentObjectVersion: 1,
      },
      mediaHosts: new Set<string>(),
      fetchImpl: mediaFetch(seen) as unknown as typeof fetch,
    });
  } catch (error) {
    refused = error;
  }

  assert(refused instanceof VideoSourceUnavailableError);
  assertEquals((refused as VideoSourceUnavailableError).reason, YOUTUBE_UPLOAD_REASON.media_origin_not_approved);
  // The host never received a request.
  assertEquals(seen.fetched, []);
});

Deno.test("a source that cannot be read names a stable reason and no URL", async () => {
  const { client, seen } = fixture({ bucket: "media" });
  let refused: unknown;
  try {
    await createOwnedVideoSource({
      supabase: client as never,
      file: {
        id: MEDIA_ID,
        userId: OWNER,
        filePath: FILE_PATH,
        storageBucket: "media",
        mimeType: "video/mp4",
        currentObjectVersion: 1,
      },
      mediaHosts: hosts,
      // A host that answers with a status the probe cannot use.
      fetchImpl: (() => Promise.resolve(new Response(null, { status: 500 }))) as unknown as typeof fetch,
    });
  } catch (error) {
    refused = error;
  }

  assert(refused instanceof VideoSourceUnavailableError);
  assertEquals((refused as VideoSourceUnavailableError).reason, YOUTUBE_UPLOAD_REASON.media_read_failed);
  // The message names no host and no signed URL.
  assertEquals((refused as VideoSourceUnavailableError).message.includes("secret-token"), false);
  assertEquals((refused as VideoSourceUnavailableError).message.includes(HOST), false);
});
