import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  derivedObjectTarget,
  isSafeObjectPath,
  knownDimensions,
  loadOwnedVideo,
  MediaQuotaRefusal,
  recordDerivedVideo,
  resolveVideoSource,
  storedVideoMetadata,
} from "./derivedVideoMedia.ts";
import type { OpeninaryConfig } from "./openinary.ts";
import { OpeninaryVideoError } from "./openinaryVideoTransform.ts";
import { fakeDb, readyOpeninary, videoRow } from "./videoMediaTestSupport.ts";

const config: OpeninaryConfig = { serverUrl: "https://cdn.example.test", apiKey: "k", folderPrefix: "postora.cloud" };
const KEY = "postora.cloud/media/u_at_x_com/2026-10-29/postora_2026-10-29_user-1_1.mp4";

function refusal(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert(error instanceof OpeninaryVideoError, "expected a typed refusal");
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
}

Deno.test("the source is the newest ready Openinary provider row", () => {
  const providers = [
    { ...readyOpeninary("old/path.mp4", 1) },
    { ...readyOpeninary(KEY, 2) },
    { ...readyOpeninary("pending/path.mp4", 3), status: "pending" },
  ];
  assertEquals(resolveVideoSource(videoRow(), providers, config), { kind: "openinary", path: KEY });
});

Deno.test("without a provider row, the path of an Openinary delivery URL is used", () => {
  assertEquals(resolveVideoSource(videoRow(), [], config), { kind: "openinary", path: KEY });
});

Deno.test("a delivery URL with encoded characters resolves to the decoded storage path", () => {
  const row = videoRow({ file_path: "https://cdn.example.test/t/postora.cloud/media/a%20b/clip%20(1).mp4" });
  assertEquals(resolveVideoSource(row, [], config), { kind: "openinary", path: "postora.cloud/media/a b/clip (1).mp4" });
});

Deno.test("a path that would climb out of /t/ is never used", () => {
  const row = videoRow({ file_path: "https://cdn.example.test/t/postora.cloud/../../api/storage/x.mp4", cloudinary_public_id: null });
  refusal(() => resolveVideoSource(row, [], config), "SOURCE_NOT_AVAILABLE");
  const evil = [{ ...readyOpeninary("a/../../etc/passwd") }];
  refusal(() => resolveVideoSource(videoRow({ file_path: "https://elsewhere.test/x.mp4" }), evil, config), "SOURCE_NOT_AVAILABLE");
  assertEquals(isSafeObjectPath("a/b/c.mp4"), true);
  assertEquals(isSafeObjectPath("a//c.mp4"), false);
  assertEquals(isSafeObjectPath("./c.mp4"), false);
  assertEquals(isSafeObjectPath(""), false);
});

Deno.test("a file_path on some other host is not treated as Openinary", () => {
  const row = videoRow({ file_path: "https://evil.example/t/postora.cloud/x.mp4" });
  refusal(() => resolveVideoSource(row, [], config), "SOURCE_NOT_AVAILABLE");
});

Deno.test("Openinary wins even when the row also carries a Cloudinary id", () => {
  const row = videoRow({ cloudinary_public_id: "legacy/id" });
  assertEquals(resolveVideoSource(row, [], config).kind, "openinary");
});

Deno.test("a video only Cloudinary holds falls back to Cloudinary", () => {
  const row = videoRow({
    file_path: "https://res.cloudinary.com/dur1soa8n/video/upload/v1/legacy/id.mp4",
    storage_bucket: "cloudinary",
    cloudinary_public_id: "legacy/id",
  });
  assertEquals(resolveVideoSource(row, [], config), {
    kind: "cloudinary",
    publicId: "legacy/id",
    deliveryUrl: "https://res.cloudinary.com/dur1soa8n/video/upload/v1/legacy/id.mp4",
  });
});

Deno.test("a video held only by Supabase Storage cannot be served by Openinary", () => {
  const row = videoRow({ file_path: "user-1/clip.mp4", storage_bucket: "media" });
  refusal(() => resolveVideoSource(row, [], config), "SOURCE_NOT_AVAILABLE");
});

Deno.test("with Openinary unconfigured and nothing in Cloudinary the provider is unavailable", () => {
  refusal(() => resolveVideoSource(videoRow(), [], null), "PROVIDER_UNAVAILABLE");
});

Deno.test("dimensions recorded on the row win over the caller's claim", () => {
  assertEquals(knownDimensions(videoRow(), { width: 10, height: 10 }), { width: 1920, height: 1080 });
  assertEquals(knownDimensions(videoRow({ metadata: { video_dimensions: { width: 640, height: 360 } } }), { width: 10, height: 10 }), { width: 640, height: 360 });
  assertEquals(knownDimensions(videoRow({ metadata: {} }), { width: 1280, height: 720 }), { width: 1280, height: 720 });
  assertEquals(knownDimensions(videoRow({ metadata: null }), "nonsense"), null);
});

Deno.test("the derived object sits next to the original with a unique mp4 name", () => {
  const target = derivedObjectTarget(KEY, "crop", 1_761_800_000_999, () => "abc123");
  assertEquals(target, { folder: "postora.cloud/media/u_at_x_com/2026-10-29", fileName: "postora_crop_1761800000_abc123.mp4" });
});

Deno.test("loading a video is scoped to its owner and to videos", async () => {
  const { db } = fakeDb({ mediaFiles: [videoRow(), videoRow({ id: "img-1", file_type: "image" })] });
  const loaded = await loadOwnedVideo(db, "media-1", "user-1");
  assertEquals(loaded.row.id, "media-1");
  const other = await assertRejects(() => loadOwnedVideo(db, "media-1", "someone-else"), OpeninaryVideoError);
  assertEquals(other.code, "MEDIA_NOT_FOUND");
  const image = await assertRejects(() => loadOwnedVideo(db, "img-1", "user-1"), OpeninaryVideoError);
  assertEquals(image.code, "INVALID_REQUEST");
});

Deno.test("a failed read is a retryable lookup failure, never a missing video or a missing Openinary copy", async () => {
  const rows = { mediaFiles: [videoRow()] };
  const media = await assertRejects(() => loadOwnedVideo(fakeDb({ ...rows, readError: { media_files: "timeout" } }).db, "media-1", "user-1"), OpeninaryVideoError);
  assertEquals([media.code, media.status], ["LOOKUP_FAILED", 503]);
  const providers = await assertRejects(() => loadOwnedVideo(fakeDb({ ...rows, readError: { media_file_providers: "timeout" } }).db, "media-1", "user-1"), OpeninaryVideoError);
  assertEquals([providers.code, providers.status], ["LOOKUP_FAILED", 503]);
});

Deno.test("a derived Openinary video is recorded as a library row plus a ready provider row", async () => {
  const { db, state } = fakeDb();
  const result = await recordDerivedVideo(db, {
    userId: "user-1",
    original: videoRow(),
    stored: { provider: "openinary", objectKey: "postora.cloud/media/u/d/v.mp4", url: "https://cdn.example.test/t/postora.cloud/media/u/d/v.mp4", bytes: 4242 },
    metadata: { source: "processed", operation: "crop" },
    discardStored: () => Promise.reject(new Error("must not be called")),
  });
  assertEquals(result, { id: "new-media-id" });
  const [media, provider] = state.inserted;
  assertEquals(media.table, "media_files");
  assertEquals(media.row.storage_bucket, "openinary");
  assertEquals(media.row.cloudinary_public_id, null);
  assertEquals(media.row.file_path, "https://cdn.example.test/t/postora.cloud/media/u/d/v.mp4");
  assertEquals(media.row.file_size, 4242);
  assertEquals(media.row.platforms, ["tiktok"]);
  assertEquals(media.row.social_account_ids, ["acct-1"]);
  assertEquals((media.row.metadata as Record<string, unknown>).operation, "crop");
  assertEquals(provider.table, "media_file_providers");
  assertEquals(provider.row, {
    media_file_id: "new-media-id",
    provider: "openinary",
    object_version: 1,
    object_key: "postora.cloud/media/u/d/v.mp4",
    status: "ready",
    delivery_url: "https://cdn.example.test/t/postora.cloud/media/u/d/v.mp4",
    bytes: 4242,
    mime_type: "video/mp4",
  });
});

Deno.test("a Cloudinary fallback result is recorded with its public id", async () => {
  const { db, state } = fakeDb();
  await recordDerivedVideo(db, {
    userId: "user-1",
    original: videoRow(),
    stored: { provider: "cloudinary", objectKey: "postora_crop_1_x", url: "https://res.cloudinary.com/c/video/upload/e/postora_crop_1_x.mp4", bytes: null },
    metadata: {},
    discardStored: () => Promise.resolve(),
  });
  assertEquals(state.inserted[0].row.storage_bucket, "cloudinary");
  assertEquals(state.inserted[0].row.cloudinary_public_id, "postora_crop_1_x");
});

Deno.test("a daily-quota refusal removes the stored object and surfaces the human message", async () => {
  const { db, state } = fakeDb({ mediaInsertError: "MEDIA_QUOTA_DAILY_EXCEEDED: Daily upload limit of 20 reached." });
  let discarded = 0;
  const error = await assertRejects(
    () => recordDerivedVideo(db, { userId: "user-1", original: videoRow(), stored: { provider: "openinary", objectKey: "k", url: "u", bytes: 1 }, metadata: {}, discardStored: () => { discarded++; return Promise.resolve(); } }),
    MediaQuotaRefusal,
  );
  assertEquals(error.message, "Daily upload limit of 20 reached.");
  assertEquals(discarded, 1);
  assertEquals(state.inserted.length, 1, "no provider row for a refused library row");
});

Deno.test("any other insert failure also removes the object and hides the database message", async () => {
  const { db } = fakeDb({ mediaInsertError: 'duplicate key value violates unique constraint "media_files_pkey"' });
  let discarded = 0;
  const error = await assertRejects(
    () => recordDerivedVideo(db, { userId: "user-1", original: videoRow(), stored: { provider: "openinary", objectKey: "k", url: "u", bytes: 1 }, metadata: {}, discardStored: () => { discarded++; return Promise.resolve(); } }),
    OpeninaryVideoError,
  );
  assertEquals(error.code, "STORE_FAILED");
  assert(!error.message.includes("media_files_pkey"));
  assertEquals(discarded, 1);
});

Deno.test("a lost provider row is logged, not turned into a failure", async () => {
  const { db } = fakeDb({ providerInsertError: "boom" });
  const result = await recordDerivedVideo(db, { userId: "user-1", original: videoRow(), stored: { provider: "openinary", objectKey: "k", url: "u", bytes: 1 }, metadata: {}, discardStored: () => Promise.reject(new Error("no")) });
  assertEquals(result.id, "new-media-id");
});

Deno.test("stored metadata is whatever the row already records, or nothing", () => {
  assertEquals(storedVideoMetadata(videoRow({ metadata: { width: 1280, height: 720, duration: 12.5, format: "mp4", unrelated: 1 } })), { width: 1280, height: 720, duration: 12.5, format: "mp4" });
  assertEquals(storedVideoMetadata(videoRow({ metadata: { width: 1280, height: 720 } })), { width: 1280, height: 720 });
  assertEquals(storedVideoMetadata(videoRow({ metadata: { width: null, height: null, duration: null } })), null);
});
