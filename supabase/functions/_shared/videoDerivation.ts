/**
 * Use case shared by process-video and transcode-video: take a user's stored video, produce a
 * transformed rendition through Openinary, and add it to the library as a new media file.
 * Cloudinary is the fallback for a video that exists only there.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  derivedObjectTarget,
  knownDimensions,
  loadOwnedVideo,
  recordDerivedVideo,
  resolveVideoSource,
  type VideoMediaRow,
} from "./derivedVideoMedia.ts";
import { type CloudinaryCredentials, deriveWithCloudinary } from "./cloudinaryVideoFallback.ts";
import { destroyCloudinary } from "./cloudinaryDestroy.ts";
import { logToDatabase } from "./logging.ts";
import { deleteFromOpeninary, type OpeninaryConfig } from "./openinary.ts";
import {
  declaredBytes,
  type DeliveryDeps,
  fetchVideoVariant,
  type IngestedVideo,
  ingestVariant,
} from "./openinaryVideoDelivery.ts";
import { type Dimensions, type OpeninaryPlan, OpeninaryVideoError } from "./openinaryVideoTransform.ts";

/** The 60 s edge budget, less a margin for answering. */
const WALL_CLOCK_BUDGET_MS = 57_000;
const MIN_INGEST_TIMEOUT_MS = 5_000;

export interface DeriveRequest {
  mediaFileId: string;
  userId: string;
  /** Used in the derived object's name: crop, compress, tiktok... */
  label: string;
  /** Width and height the caller reports; only used when the row records none. */
  claimedDimensions?: unknown;
  openinaryPlan: (source: Dimensions | null) => OpeninaryPlan;
  cloudinaryTransformation: (source: Dimensions | null) => string;
  /** Handler-specific settings recorded on the new media file. */
  metadata: Record<string, unknown>;
  maxSizeMB?: number;
  /** Fail when the result is not smaller than the original (compression). */
  mustShrink?: boolean;
}

export interface DeriveResult {
  mediaFileId: string;
  url: string;
  bytes: number | null;
  provider: "openinary" | "cloudinary";
  transformation: string;
  outputDimensions: Dimensions | null;
  sourceDimensions: Dimensions | null;
  warnings: string[];
}

export interface DeriveIo {
  fetchVariant: typeof fetchVideoVariant;
  ingest: typeof ingestVariant;
  deleteObject: typeof deleteFromOpeninary;
  cloudinary: typeof deriveWithCloudinary;
  destroyCloudinaryObject: typeof destroyCloudinary;
}

export interface DeriveDeps {
  adminDb: SupabaseClient;
  openinary: OpeninaryConfig | null;
  cloudinary: CloudinaryCredentials | null;
  delivery?: DeliveryDeps;
  now?: () => number;
  io?: Partial<DeriveIo>;
  /** Where a failed cleanup is recorded. Defaults to system_logs. */
  log?: (entry: CleanupLogEntry) => Promise<void>;
}

export interface CleanupLogEntry {
  message: string;
  userId: string;
  metadata: Record<string, unknown>;
}

const MB = 1024 * 1024;

function assertAcceptable(bytes: number | null, request: DeriveRequest, original: VideoMediaRow): void {
  if (bytes === null) return;
  if (request.maxSizeMB && bytes > request.maxSizeMB * MB) {
    throw new OpeninaryVideoError(
      "TARGET_SIZE_NOT_REACHED",
      `The compressed video is ${(bytes / MB).toFixed(1)} MB, above your ${request.maxSizeMB} MB target. Choose a lower quality or a larger target.`,
    );
  }
  if (request.mustShrink && original.file_size && bytes >= original.file_size) {
    throw new OpeninaryVideoError(
      "COMPRESSION_NOT_SMALLER",
      "Compression did not make this video smaller. It is already well compressed; keep the original.",
    );
  }
}

/**
 * Remove a rendition we are throwing away. Neither a rejection nor `{ success: false }` may hide:
 * the object stays in storage, so its key is logged for whoever cleans up. No retry queue.
 */
async function discardRendition(
  deps: DeriveDeps,
  userId: string,
  provider: "openinary" | "cloudinary",
  objectKey: string,
  remove: () => Promise<{ success: boolean; error?: string }>,
): Promise<void> {
  let failure: string | null = null;
  try {
    const result = await remove();
    if (!result.success) failure = result.error ?? "provider refused";
  } catch (error) {
    failure = error instanceof Error ? error.message : "unexpected error";
  }
  if (failure === null) return;
  console.error(`[video-derivation] could not remove ${provider} object ${objectKey}: ${failure}`);
  const entry: CleanupLogEntry = {
    message: "Could not remove a discarded video rendition",
    userId,
    metadata: { provider, object_key: objectKey, error: failure },
  };
  const log = deps.log ?? ((e: CleanupLogEntry) =>
    logToDatabase(deps.adminDb, { level: "error", category: "system", source: "video-derivation", message: e.message, user_id: e.userId, metadata: e.metadata }));
  try {
    await log(entry);
  } catch {
    console.error("[video-derivation] cleanup failure could not be logged");
  }
}

/** A size limit that cannot be checked is not a limit that was met. */
function assertVerifiable(bytes: number | null, request: DeriveRequest): void {
  if (bytes === null && (request.maxSizeMB || request.mustShrink)) {
    throw new OpeninaryVideoError("SIZE_NOT_VERIFIABLE", "The size of the processed video could not be confirmed, so the size limit cannot be guaranteed. Try again.");
  }
}

export async function deriveVideo(deps: DeriveDeps, request: DeriveRequest): Promise<DeriveResult> {
  const io: DeriveIo = {
    fetchVariant: fetchVideoVariant,
    ingest: ingestVariant,
    deleteObject: deleteFromOpeninary,
    cloudinary: deriveWithCloudinary,
    destroyCloudinaryObject: destroyCloudinary,
    ...deps.io,
  };
  const now = deps.now ?? Date.now;
  const startedAt = now();

  const { row, providers } = await loadOwnedVideo(deps.adminDb, request.mediaFileId, request.userId);
  const source = resolveVideoSource(row, providers, deps.openinary);
  const sourceDimensions = knownDimensions(row, request.claimedDimensions);

  if (source.kind === "cloudinary") {
    // Only reachable for media Openinary does not hold.
    const transformation = request.cloudinaryTransformation(sourceDimensions);
    const derived = await io.cloudinary({
      credentials: deps.cloudinary,
      publicId: source.publicId,
      deliveryUrl: source.deliveryUrl,
      label: request.label,
      transformation,
    });
    const discardDerived = () => discardRendition(deps, request.userId, "cloudinary", derived.publicId, () => io.destroyCloudinaryObject(derived.publicId, "video"));
    try {
      assertVerifiable(derived.bytes, request);
      assertAcceptable(derived.bytes, request, row);
    } catch (error) {
      await discardDerived();
      throw error;
    }
    const { id } = await recordDerivedVideo(deps.adminDb, {
      userId: request.userId,
      original: row,
      stored: { provider: "cloudinary", objectKey: derived.publicId, url: derived.url, bytes: derived.bytes },
      // Cloudinary does not report the rendition's dimensions here, so none is recorded as its own.
      metadata: { ...request.metadata, source_video_dimensions: sourceDimensions, provider: "cloudinary", transformation },
      discardStored: discardDerived,
    });
    return {
      mediaFileId: id, url: derived.url, bytes: derived.bytes, provider: "cloudinary", transformation,
      outputDimensions: null, sourceDimensions, warnings: [],
    };
  }

  const config = deps.openinary as OpeninaryConfig; // resolveVideoSource only returns "openinary" with a config
  const plan = request.openinaryPlan(sourceDimensions);
  const response = await io.fetchVariant(config, plan.segment, source.path, deps.delivery);

  const announced = declaredBytes(response);
  try {
    assertAcceptable(announced, request, row);
  } catch (error) {
    try { await response.body?.cancel(); } catch { /* released */ }
    throw error;
  }

  const target = derivedObjectTarget(source.path, request.label, now());
  const ingested: IngestedVideo = await io.ingest(config, response, target.folder, target.fileName, {
    timeoutMs: Math.max(MIN_INGEST_TIMEOUT_MS, WALL_CLOCK_BUDGET_MS - (now() - startedAt)),
  });
  const discardStored = () => discardRendition(deps, request.userId, "openinary", ingested.path, () => io.deleteObject(config, ingested.path));

  try {
    assertAcceptable(ingested.bytes, request, row);
  } catch (error) {
    await discardStored();
    throw error;
  }

  const { id } = await recordDerivedVideo(deps.adminDb, {
    userId: request.userId,
    original: row,
    stored: { provider: "openinary", objectKey: ingested.path, url: ingested.url, bytes: ingested.bytes },
    // The rendition's own size: a later crop or compress plans from it, not from the original's.
    metadata: {
      ...request.metadata,
      ...(plan.output ? { video_dimensions: plan.output } : {}),
      source_video_dimensions: sourceDimensions,
      provider: "openinary",
      transformation: plan.segment,
    },
    discardStored,
  });

  return {
    mediaFileId: id, url: ingested.url, bytes: ingested.bytes, provider: "openinary", transformation: plan.segment,
    outputDimensions: plan.output, sourceDimensions, warnings: plan.warnings,
  };
}
