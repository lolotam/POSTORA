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
    const { id } = await recordDerivedVideo(deps.adminDb, {
      userId: request.userId,
      original: row,
      stored: { provider: "cloudinary", objectKey: derived.publicId, url: derived.url, bytes: null },
      metadata: { ...request.metadata, video_dimensions: sourceDimensions, provider: "cloudinary", transformation },
      discardStored: async () => { await io.destroyCloudinaryObject(derived.publicId, "video"); },
    });
    return {
      mediaFileId: id, url: derived.url, bytes: null, provider: "cloudinary", transformation,
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
  const discardStored = async () => { await io.deleteObject(config, ingested.path); };

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
    metadata: { ...request.metadata, video_dimensions: sourceDimensions, provider: "openinary", transformation: plan.segment },
    discardStored,
  });

  return {
    mediaFileId: id, url: ingested.url, bytes: ingested.bytes, provider: "openinary", transformation: plan.segment,
    outputDimensions: plan.output, sourceDimensions, warnings: plan.warnings,
  };
}
