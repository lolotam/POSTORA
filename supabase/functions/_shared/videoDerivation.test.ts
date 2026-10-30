import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MediaQuotaRefusal } from "./derivedVideoMedia.ts";
import type { OpeninaryConfig } from "./openinary.ts";
import { type DeriveDeps, deriveVideo, type DeriveRequest } from "./videoDerivation.ts";
import { OpeninaryVideoError, planCompress, planCrop, planTranscode } from "./openinaryVideoTransform.ts";
import { fakeDb, readyOpeninary, videoRow } from "./videoMediaTestSupport.ts";

const config: OpeninaryConfig = { serverUrl: "https://cdn.example.test", apiKey: "k", folderPrefix: "postora.cloud" };
const KEY = "postora.cloud/media/u_at_x_com/2026-10-29/postora_2026-10-29_user-1_1.mp4";
const FOLDER = "postora.cloud/media/u_at_x_com/2026-10-29";

/** Records every call at the network boundary; the pure planning and the DB writes run for real. */
function harness(options: {
  variantBytes?: number | null;
  ingestedBytes?: number;
  dbState?: Parameters<typeof fakeDb>[0];
} = {}) {
  const { db, state } = fakeDb({ mediaFiles: [videoRow()], providers: [readyOpeninary(KEY)], ...options.dbState });
  const calls = { variant: [] as { segment: string; path: string }[], ingest: [] as { folder: string; fileName: string }[], deleted: [] as string[], cancelled: 0, cloudinary: 0 };
  const deps: DeriveDeps = {
    adminDb: db,
    openinary: config,
    cloudinary: { cloudName: "demo", apiKey: "k", apiSecret: "s" },
    io: {
      fetchVariant: (_config, segment, path) => {
        calls.variant.push({ segment, path });
        const body = new ReadableStream<Uint8Array>({ cancel() { calls.cancelled++; } });
        const length = options.variantBytes === undefined ? 4_000_000 : options.variantBytes;
        return Promise.resolve(new Response(body, { headers: length === null ? {} : { "content-length": String(length) } }));
      },
      ingest: (_config, _response, folder, fileName) => {
        calls.ingest.push({ folder, fileName });
        return Promise.resolve({ path: `${folder}/${fileName}`, url: `https://cdn.example.test/t/${folder}/${fileName}`, bytes: options.ingestedBytes ?? 4_000_000 });
      },
      deleteObject: (_config, path) => { calls.deleted.push(path); return Promise.resolve({ success: true }); },
      cloudinary: () => { calls.cloudinary++; return Promise.reject(new OpeninaryVideoError("PROVIDER_UNAVAILABLE", "gone")); },
    },
  };
  return { deps, state, calls };
}

function compressRequest(overrides: Partial<DeriveRequest> = {}): DeriveRequest {
  return {
    mediaFileId: "media-1",
    userId: "user-1",
    label: "compress",
    openinaryPlan: (dims) => planCompress({ quality: 60 }, dims),
    cloudinaryTransformation: () => "vc_h264,q_auto:good,f_mp4",
    metadata: { source: "processed", operation: "compress", original_file_id: "media-1" },
    mustShrink: true,
    ...overrides,
  };
}

Deno.test("a stored Openinary video is processed through Openinary and recorded as a new Openinary media file", async () => {
  const { deps, state, calls } = harness();
  const result = await deriveVideo(deps, compressRequest());
  assertEquals(calls.variant, [{ segment: "w_1920,h_1080,c_scale,q_60,f_mp4", path: KEY }]);
  assertEquals(calls.ingest.length, 1);
  assertEquals(calls.ingest[0].folder, FOLDER);
  assert(/^postora_compress_\d+_[0-9a-f]{12}\.mp4$/.test(calls.ingest[0].fileName));
  assertEquals(calls.cloudinary, 0);
  assertEquals(result.mediaFileId, "new-media-id");
  assertEquals(result.provider, "openinary");
  assertEquals(result.bytes, 4_000_000);
  assertEquals(result.url, `https://cdn.example.test/t/${FOLDER}/${calls.ingest[0].fileName}`);
  const [media, provider] = state.inserted;
  assertEquals(media.row.storage_bucket, "openinary");
  assertEquals(media.row.user_id, "user-1");
  assertEquals((media.row.metadata as Record<string, unknown>).original_file_id, "media-1");
  assertEquals((media.row.metadata as Record<string, unknown>).transformation, "w_1920,h_1080,c_scale,q_60,f_mp4");
  assertEquals(provider.row.provider, "openinary");
  assertEquals(provider.row.status, "ready");
});

Deno.test("Cloudinary is never touched for a video Openinary holds, even with credentials configured", async () => {
  const { deps, calls } = harness();
  await deriveVideo(deps, compressRequest());
  assertEquals(calls.cloudinary, 0);
});

Deno.test("an unsupported crop is refused before any network or database write", async () => {
  const { deps, state, calls } = harness();
  const request = compressRequest({ label: "crop", openinaryPlan: (dims) => planCrop({ x: 0, y: 0, width: 31.64, height: 100 }, dims) });
  const error = await assertRejects(() => deriveVideo(deps, request), OpeninaryVideoError);
  assertEquals(error.code, "UNSUPPORTED_CROP_REGION");
  assertEquals(calls.variant.length + calls.ingest.length, 0);
  assertEquals(state.inserted.length, 0);
});

Deno.test("dimensions the row lacks come from the caller; without either, a crop cannot be planned", async () => {
  const noDims = { mediaFiles: [videoRow({ metadata: {} })], providers: [readyOpeninary(KEY)] };
  const crop = (claimed?: unknown) => compressRequest({ label: "crop", claimedDimensions: claimed, mustShrink: false, openinaryPlan: (dims) => planCrop({ x: 0, y: 0, width: 100, height: 100 }, dims) });
  const refused = harness({ dbState: noDims });
  const error = await assertRejects(() => deriveVideo(refused.deps, crop()), OpeninaryVideoError);
  assertEquals(error.code, "SOURCE_DIMENSIONS_UNKNOWN");
  const claimed = harness({ dbState: noDims });
  await deriveVideo(claimed.deps, crop({ width: 1280, height: 720 }));
  assertEquals(claimed.calls.variant[0].segment, "w_1280,h_720,c_fill,q_60,f_mp4");
});

Deno.test("a compression that would not shrink the file fails before storing anything", async () => {
  const { deps, state, calls } = harness({ variantBytes: 12_000_000 });
  const error = await assertRejects(() => deriveVideo(deps, compressRequest()), OpeninaryVideoError);
  assertEquals(error.code, "COMPRESSION_NOT_SMALLER");
  assertEquals(calls.ingest.length, 0);
  assertEquals(calls.cancelled, 1, "the unread rendition is released");
  assertEquals(state.inserted.length, 0);
});

Deno.test("a result above the requested size target is refused up front when the size is announced", async () => {
  const { deps, calls } = harness({ variantBytes: 9_000_000 });
  const error = await assertRejects(() => deriveVideo(deps, compressRequest({ maxSizeMB: 5 })), OpeninaryVideoError);
  assertEquals(error.code, "TARGET_SIZE_NOT_REACHED");
  assert(error.message.includes("5 MB"));
  assertEquals(calls.ingest.length, 0);
});

Deno.test("when the size is only known after storing, an oversize result is deleted again", async () => {
  const { deps, state, calls } = harness({ variantBytes: null, ingestedBytes: 9_000_000 });
  const error = await assertRejects(() => deriveVideo(deps, compressRequest({ maxSizeMB: 5 })), OpeninaryVideoError);
  assertEquals(error.code, "TARGET_SIZE_NOT_REACHED");
  assertEquals(calls.deleted, [`${calls.ingest[0].folder}/${calls.ingest[0].fileName}`]);
  assertEquals(state.inserted.length, 0);
});

Deno.test("a result within the size target is accepted", async () => {
  const { deps } = harness({ variantBytes: 4_000_000 });
  const result = await deriveVideo(deps, compressRequest({ maxSizeMB: 5 }));
  assertEquals(result.bytes, 4_000_000);
});

Deno.test("a library refusal after storing (daily quota) deletes the stored Openinary object", async () => {
  const { deps, calls } = harness({ dbState: { mediaInsertError: "MEDIA_QUOTA_DAILY_EXCEEDED: Daily upload limit of 5 reached." } });
  const error = await assertRejects(() => deriveVideo(deps, compressRequest()), MediaQuotaRefusal);
  assertEquals(error.message, "Daily upload limit of 5 reached.");
  assertEquals(calls.deleted, [`${calls.ingest[0].folder}/${calls.ingest[0].fileName}`]);
});

Deno.test("someone else's video is not found, and nothing is fetched", async () => {
  const { deps, calls } = harness();
  const error = await assertRejects(() => deriveVideo(deps, compressRequest({ userId: "intruder" })), OpeninaryVideoError);
  assertEquals(error.code, "MEDIA_NOT_FOUND");
  assertEquals(calls.variant.length, 0);
});

Deno.test("a transcode names the platform and uses its preset", async () => {
  const { deps, calls, state } = harness();
  const plan = planTranscode("tiktok");
  await deriveVideo(deps, compressRequest({ label: "tiktok", openinaryPlan: () => plan, mustShrink: false, metadata: { transcoded_from: "media-1", target_platform: "tiktok" } }));
  assertEquals(calls.variant[0].segment, "w_720,h_1280,c_fill,q_80,f_mp4");
  assert(calls.ingest[0].fileName.startsWith("postora_tiktok_"));
  // The new row carries the rendition's size, so a later crop plans from 720x1280, not the original.
  const metadata = state.inserted[0].row.metadata as Record<string, unknown>;
  assertEquals(metadata.video_dimensions, { width: 720, height: 1280 });
  assertEquals(metadata.source_video_dimensions, { width: 1920, height: 1080 });
});

Deno.test("a Cloudinary-only video uses the fallback and is recorded as a Cloudinary file", async () => {
  const cloudinaryRow = videoRow({
    file_path: "https://res.cloudinary.com/demo/video/upload/v1/legacy/id.mp4",
    storage_bucket: "cloudinary",
    cloudinary_public_id: "legacy/id",
  });
  const { deps, state, calls } = harness({ dbState: { mediaFiles: [cloudinaryRow], providers: [] } });
  let sent: Record<string, unknown> | null = null;
  deps.io!.cloudinary = (args) => {
    sent = { publicId: args.publicId, transformation: args.transformation, label: args.label };
    return Promise.resolve({ publicId: "postora_compress_1_x", url: "https://res.cloudinary.com/demo/e.mp4" });
  };
  const result = await deriveVideo(deps, compressRequest({ mustShrink: false }));
  assertEquals(sent, { publicId: "legacy/id", transformation: "vc_h264,q_auto:good,f_mp4", label: "compress" });
  assertEquals(calls.variant.length, 0);
  assertEquals(result.provider, "cloudinary");
  assertEquals(state.inserted[0].row.storage_bucket, "cloudinary");
  assertEquals(state.inserted[1].row.provider, "cloudinary");
});

Deno.test("a Cloudinary-only video whose cloud is disabled fails clearly and stores nothing", async () => {
  const cloudinaryRow = videoRow({ file_path: "https://res.cloudinary.com/demo/video/upload/v1/legacy/id.mp4", storage_bucket: "cloudinary", cloudinary_public_id: "legacy/id" });
  const { deps, state } = harness({ dbState: { mediaFiles: [cloudinaryRow], providers: [] } });
  const error = await assertRejects(() => deriveVideo(deps, compressRequest()), OpeninaryVideoError);
  assertEquals(error.code, "PROVIDER_UNAVAILABLE");
  assertEquals(state.inserted.length, 0);
});

Deno.test("a video in neither Openinary nor Cloudinary is an explicit unavailable-source error", async () => {
  const { deps } = harness({ dbState: { mediaFiles: [videoRow({ file_path: "user-1/clip.mp4", storage_bucket: "media" })], providers: [] } });
  const error = await assertRejects(() => deriveVideo(deps, compressRequest()), OpeninaryVideoError);
  assertEquals(error.code, "SOURCE_NOT_AVAILABLE");
});
