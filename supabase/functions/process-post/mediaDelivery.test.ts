/**
 * Where a media file may be read from.
 *
 * A media row is a row an authenticated user may write: the policies on
 * `media_files` check the owner and nothing else. The worker reads media with
 * the service role, which can sign an object in ANY bucket, so the row cannot
 * be trusted to name a file the customer owns.
 *
 * What the tests below prove is that a crafted row buys the worker nothing:
 *
 *   * a bucket that is not Postora's own is refused;
 *   * a media file of somebody else is not the media of this post;
 *   * an object outside the prefix of its own tenancy is not signed;
 *   * a delivery URL on a host the deployment did not name is refused, and so
 *     is one that is not HTTPS at all;
 *   * the provider's own delivery URL is held to the same host policy.
 */

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertMediaRowAdmissible,
  MediaDeliveryRefusedError,
  resolveMediaUrl,
  type MediaFile,
  type MediaProviderRow,
} from "./mediaDelivery.ts";
import { approvedMediaHosts } from "./youtubeUploadPolicy.ts";

const OWNER = "e1000000-0000-4000-8000-000000000011";
const WORKSPACE = "e2000000-0000-4000-8000-000000000022";
const MEDIA_ID = "media-1";
const STORAGE_BUCKET = "media";
const CDN_BUCKET = "openinary";
const PARTNER_BUCKET = "partner-media";
const APPROVED = approvedMediaHosts({
  supabaseUrl: "https://api.example.test",
  cdnOrigins: ["https://cdn.example.test"],
});

/** The options every case resolves with. */
const OPTIONS = {
  preferenceOrder: ["openinary", "cloudinary"],
  ownerUserId: OWNER,
  allowedWorkspaceIds: new Set<string>(),
  approvedHosts: APPROVED,
};

/** What the fake storage was asked to sign. */
interface Signed {
  buckets: string[];
  paths: string[];
}

/**
 * A Supabase client that answers only what the resolver asks for.
 *
 * The signed URL it mints is on an approved host, so the host policy is not
 * what a storage case is about.
 */
function storageClient(): { client: unknown; signed: Signed } {
  const signed: Signed = { buckets: [], paths: [] };
  const client = {
    storage: {
      from(bucket: string) {
        return {
          async createSignedUrl(path: string) {
            signed.buckets.push(bucket);
            signed.paths.push(path);
            return { data: { signedUrl: `https://api.example.test/storage/v1/object/sign/${bucket}/${path}` }, error: null };
          },
        };
      },
    },
  };
  return { client, signed };
}

function mediaFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    id: MEDIA_ID,
    user_id: OWNER,
    file_path: `${OWNER}/video.mp4`,
    file_type: "video",
    storage_bucket: STORAGE_BUCKET,
    mime_type: "video/mp4",
    current_object_version: 1,
    ...overrides,
  };
}

function providerRows(rows: Array<Partial<MediaProviderRow>>): Record<string, MediaProviderRow[]> {
  return {
    [MEDIA_ID]: rows.map((row) => ({
      provider: "openinary",
      object_version: 1,
      status: "ready",
      delivery_url: null,
      ...row,
    })),
  };
}

Deno.test("a bucket that is not Postora's own is refused", async () => {
  const { client, signed } = storageClient();
  const error = await assertRejects(
    () =>
      resolveMediaUrl(
        client as never,
        mediaFile({ storage_bucket: "secrets", file_path: `${OWNER}/video.mp4` }),
        {},
        OPTIONS,
      ),
    MediaDeliveryRefusedError,
  );
  assertEquals(error.reason, "bucket_not_allowed");
  // Nothing was signed.
  assertEquals(signed.buckets, []);
});

Deno.test("a media file of somebody else is not the media of this post", async () => {
  const { client, signed } = storageClient();
  const error = await assertRejects(
    () =>
      resolveMediaUrl(
        client as never,
        mediaFile({ user_id: "other-user", file_path: "other-user/video.mp4" }),
        {},
        OPTIONS,
      ),
    MediaDeliveryRefusedError,
  );
  assertEquals(error.reason, "not_owned");
  assertEquals(signed.buckets, []);
});

Deno.test("partner media of a workspace the post publishes into is signed under the workspace", async () => {
  const { client, signed } = storageClient();
  const url = await resolveMediaUrl(
    client as never,
    mediaFile({
      storage_bucket: PARTNER_BUCKET,
      workspace_id: WORKSPACE,
      file_path: `${WORKSPACE}/video.mp4`,
    }),
    {},
    { ...OPTIONS, allowedWorkspaceIds: new Set([WORKSPACE]) },
  );
  assertEquals(url, `https://api.example.test/storage/v1/object/sign/${PARTNER_BUCKET}/${WORKSPACE}/video.mp4`);
  assertEquals(signed.buckets, [PARTNER_BUCKET]);
  assertEquals(signed.paths, [`${WORKSPACE}/video.mp4`]);
});

Deno.test("partner media of another workspace is refused", async () => {
  const { client, signed } = storageClient();
  const error = await assertRejects(
    () =>
      resolveMediaUrl(
        client as never,
        mediaFile({
          storage_bucket: PARTNER_BUCKET,
          workspace_id: "other-workspace",
          file_path: "other-workspace/video.mp4",
        }),
        {},
        { ...OPTIONS, allowedWorkspaceIds: new Set([WORKSPACE]) },
      ),
    MediaDeliveryRefusedError,
  );
  assertEquals(error.reason, "not_owned");
  assertEquals(signed.buckets, []);
});

Deno.test("an object outside the owner's own prefix is not signed", async () => {
  const { client, signed } = storageClient();
  const error = await assertRejects(
    () =>
      resolveMediaUrl(
        client as never,
        mediaFile({ file_path: "other-user/video.mp4" }),
        {},
        OPTIONS,
      ),
    MediaDeliveryRefusedError,
  );
  assertEquals(error.reason, "not_owned");
  assertEquals(signed.buckets, []);
});

// A path that starts with the owner's prefix but climbs out of it names another
// tenant's object once the storage layer resolves it.
for (
  const path of [
    `${OWNER}/../victim/video.mp4`,
    `${OWNER}/./video.mp4`,
    `${OWNER}//video.mp4`,
    `${OWNER}/a/../../victim/video.mp4`,
    `${OWNER}/..%2Fvictim/video.mp4`,
    `${OWNER}/%2e%2e/victim/video.mp4`,
    `${OWNER}\\..\\victim\\video.mp4`,
  ]
) {
  Deno.test(`an owner-prefixed path with traversal is not signed: ${path}`, async () => {
    const { client, signed } = storageClient();
    const error = await assertRejects(
      () => resolveMediaUrl(client as never, mediaFile({ file_path: path }), {}, OPTIONS),
      MediaDeliveryRefusedError,
    );
    assertEquals(error.reason, "not_owned");
    assertEquals(signed.buckets, []);
  });
}

Deno.test("a delivery URL that is not HTTPS is refused", async () => {
  const { client } = storageClient();
  const error = await assertRejects(
    () =>
      resolveMediaUrl(
        client as never,
        mediaFile({ storage_bucket: CDN_BUCKET, file_path: "http://cdn.example.test/video.mp4" }),
        {},
        OPTIONS,
      ),
    MediaDeliveryRefusedError,
  );
  assertEquals(error.reason, "origin_not_approved");
});

Deno.test("a delivery URL on a host that is not approved is refused", async () => {
  const { client } = storageClient();
  const error = await assertRejects(
    () =>
      resolveMediaUrl(
        client as never,
        mediaFile({ storage_bucket: CDN_BUCKET, file_path: "https://elsewhere.example/video.mp4" }),
        {},
        OPTIONS,
      ),
    MediaDeliveryRefusedError,
  );
  assertEquals(error.reason, "origin_not_approved");
});

Deno.test("a provider delivery URL on a host that is not approved is refused", async () => {
  const { client } = storageClient();
  const error = await assertRejects(
    () =>
      resolveMediaUrl(
        client as never,
        mediaFile(),
        providerRows([{ delivery_url: "https://elsewhere.example/video.mp4" }]),
        OPTIONS,
      ),
    MediaDeliveryRefusedError,
  );
  assertEquals(error.reason, "origin_not_approved");
});

Deno.test("an object inside the owner's own prefix is signed in its own bucket", async () => {
  const { client, signed } = storageClient();
  const url = await resolveMediaUrl(client as never, mediaFile(), {}, OPTIONS);
  assertEquals(url, `https://api.example.test/storage/v1/object/sign/${STORAGE_BUCKET}/${OWNER}/video.mp4`);
  assertEquals(signed.buckets, [STORAGE_BUCKET]);
  assertEquals(signed.paths, [`${OWNER}/video.mp4`]);
});

Deno.test("an approved CDN delivery URL is returned as it is", async () => {
  const { client, signed } = storageClient();
  const url = await resolveMediaUrl(
    client as never,
    mediaFile({ storage_bucket: CDN_BUCKET, file_path: "https://cdn.example.test/video.mp4" }),
    {},
    OPTIONS,
  );
  assertEquals(url, "https://cdn.example.test/video.mp4");
  // A CDN object is not signed: it is already a delivery URL.
  assertEquals(signed.buckets, []);
});

Deno.test("the provider delivery URL wins over the file path, and it is held to the host policy", async () => {
  const { client } = storageClient();
  const url = await resolveMediaUrl(
    client as never,
    mediaFile({ storage_bucket: CDN_BUCKET, file_path: "https://cdn.example.test/video.mp4" }),
    providerRows([{ delivery_url: "https://cdn.example.test/openinary/video.mp4" }]),
    OPTIONS,
  );
  assertEquals(url, "https://cdn.example.test/openinary/video.mp4");
  assert(url !== "https://cdn.example.test/video.mp4");
});

Deno.test("pre-sign admission refuses a foreign owner, an unapproved bucket and a foreign prefix", () => {
  const options = { ownerUserId: OWNER, allowedWorkspaceIds: new Set<string>() };
  // A valid row passes.
  assertMediaRowAdmissible(mediaFile(), options);

  const rejections: Array<[string, MediaFile]> = [
    ["bucket_not_allowed", mediaFile({ storage_bucket: "private-bucket" })],
    ["not_owned", mediaFile({ user_id: "another-owner" })],
    ["not_owned", mediaFile({ file_path: "another-owner/video.mp4" })],
    ["not_owned", mediaFile({ file_path: `${OWNER}/../another-owner/video.mp4` })],
  ];
  for (const [reason, file] of rejections) {
    try {
      assertMediaRowAdmissible(file, options);
      throw new Error(`expected ${reason} to be refused`);
    } catch (error) {
      assert(error instanceof MediaDeliveryRefusedError);
      assertEquals(error.reason, reason);
    }
  }
});
