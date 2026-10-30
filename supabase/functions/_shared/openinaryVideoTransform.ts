/**
 * Pure planning for video processing through Openinary.
 *
 * Openinary's video grammar (docs.openinary.dev, `packages/core`): `w`, `h`, `c`, `q` (CRF),
 * `so`, `eo`, `f`, `t`, `tt`. H.264 is fixed, `c_fill` with both `w` and `h` is "cover, then
 * crop from the centre", and there are no crop offsets and no bitrate cap. Anything the
 * callers ask for beyond that is refused with a typed error, never approximated silently.
 *
 * The Cloudinary eager strings below exist only for the fallback in
 * cloudinaryVideoFallback.ts, used when the media lives nowhere but Cloudinary.
 */

export type OpeninaryVideoErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "MEDIA_NOT_FOUND"
  | "FORBIDDEN"
  | "UNSUPPORTED_CROP_REGION"
  | "UNSUPPORTED_CROP_TARGET"
  | "UNSUPPORTED_OPERATION"
  | "SOURCE_DIMENSIONS_UNKNOWN"
  | "SOURCE_NOT_AVAILABLE"
  | "SOURCE_TOO_LARGE"
  | "TRANSFORM_FAILED"
  | "TRANSFORM_STILL_PROCESSING"
  | "RESULT_TOO_LARGE"
  | "TARGET_SIZE_NOT_REACHED"
  | "COMPRESSION_NOT_SMALLER"
  | "STORE_FAILED"
  | "PROVIDER_UNAVAILABLE"
  | "LOOKUP_FAILED"
  | "METADATA_UNAVAILABLE";

const STATUS: Record<OpeninaryVideoErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  MEDIA_NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNSUPPORTED_CROP_REGION: 422,
  UNSUPPORTED_CROP_TARGET: 422,
  UNSUPPORTED_OPERATION: 422,
  SOURCE_DIMENSIONS_UNKNOWN: 422,
  SOURCE_NOT_AVAILABLE: 422,
  SOURCE_TOO_LARGE: 422,
  TRANSFORM_FAILED: 502,
  TRANSFORM_STILL_PROCESSING: 503,
  RESULT_TOO_LARGE: 422,
  TARGET_SIZE_NOT_REACHED: 422,
  COMPRESSION_NOT_SMALLER: 422,
  STORE_FAILED: 502,
  PROVIDER_UNAVAILABLE: 503,
  LOOKUP_FAILED: 503,
  METADATA_UNAVAILABLE: 422,
};

/** An expected refusal: stable code, user-safe message, HTTP status for the adapter. */
export class OpeninaryVideoError extends Error {
  readonly code: OpeninaryVideoErrorCode;
  readonly status: number;
  constructor(code: OpeninaryVideoErrorCode, message: string) {
    super(message);
    this.name = "OpeninaryVideoError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export interface Dimensions { width: number; height: number }

/** Percentages of the frame, 0-100, as the crop box in MediaCropper reports them. */
export interface CropRequest {
  x: number;
  y: number;
  width: number;
  height: number;
  targetWidth?: number;
  targetHeight?: number;
}

export interface CompressRequest { quality: number; maxSizeMB?: number }

export interface OpeninaryPlan {
  /** Transformation segment placed between `/t/` and the object path. */
  segment: string;
  /** Output size when the plan pins it. */
  output: Dimensions | null;
  warnings: string[];
}

export type TranscodePlatform = "tiktok" | "instagram" | "youtube";

/** A crop box edge may be off by this many percent of the frame and still count as aligned. */
const ALIGN_TOLERANCE_PERCENT = 0.5;
/** A target and the crop's own aspect ratio may differ by this fraction before we refuse. */
const TARGET_ASPECT_TOLERANCE = 0.02;
/** Cloudinary's auto-upscale rule for narrow verticals (TikTok minimum width). */
const NARROW_VERTICAL_RATIO = 0.7;
const MIN_VERTICAL_WIDTH = 720;
const MAX_DIMENSION = 16384;

const TRANSCODE_PRESETS: Record<TranscodePlatform, Dimensions> = {
  tiktok: { width: 720, height: 1280 },
  instagram: { width: 1080, height: 1920 },
  youtube: { width: 1920, height: 1080 },
};

/** Cloudinary `q_auto:best|good|eco` expressed as Openinary `q` (CRF 25, 31, 38). */
const QUALITY_TIER_Q = { best: 80, good: 60, eco: 40 } as const;
type QualityTier = keyof typeof QUALITY_TIER_Q;

/** H.264 needs even dimensions. */
export function evenDimension(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function invalid(message: string): OpeninaryVideoError {
  return new OpeninaryVideoError("INVALID_REQUEST", message);
}

export function parseDimensions(value: unknown): Dimensions | null {
  if (!value || typeof value !== "object") return null;
  const { width, height } = value as Record<string, unknown>;
  if (!isPositiveNumber(width) || !isPositiveNumber(height)) return null;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

export function qualityTier(quality: number): QualityTier {
  const clamped = Math.max(10, Math.min(100, quality));
  return clamped >= 80 ? "best" : clamped >= 50 ? "good" : "eco";
}

function assertCompress(request: CompressRequest): void {
  if (typeof request.quality !== "number" || !Number.isFinite(request.quality)) throw invalid("compress.quality must be a number");
  if (request.maxSizeMB !== undefined && request.maxSizeMB !== null && !isPositiveNumber(request.maxSizeMB)) {
    throw invalid("compress.maxSizeMB must be a positive number");
  }
}

export function planCompress(request: CompressRequest, source: Dimensions | null): OpeninaryPlan {
  assertCompress(request);
  const q = QUALITY_TIER_Q[qualityTier(request.quality)];
  if (!source) {
    return {
      segment: `q_${q},f_mp4`,
      output: null,
      warnings: ["Source resolution is unknown, so Openinary limits the output to 720p."],
    };
  }
  const output = { width: evenDimension(source.width), height: evenDimension(source.height) };
  return { segment: `w_${output.width},h_${output.height},c_scale,q_${q},f_mp4`, output, warnings: [] };
}

export function planTranscode(platform: string | undefined): OpeninaryPlan & { platform: TranscodePlatform } {
  const key = (platform ?? "tiktok") as TranscodePlatform;
  const preset = TRANSCODE_PRESETS[key];
  if (!preset) throw invalid("target_platform must be tiktok, instagram or youtube");
  // `ar_` and `g_center` of the Cloudinary preset are redundant here: the aspect ratio follows
  // from w/h and centre is the default gravity.
  return {
    platform: key,
    segment: `w_${preset.width},h_${preset.height},c_fill,q_${QUALITY_TIER_Q.best},f_mp4`,
    output: preset,
    warnings: [],
  };
}

interface CropRegion { width: number; height: number; fullFrame: boolean }

function assertCrop(crop: CropRequest): void {
  const edges = [crop?.x, crop?.y, crop?.width, crop?.height];
  if (edges.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw invalid("crop x, y, width and height must be numbers");
  if (crop.x < 0 || crop.y < 0 || !isPositiveNumber(crop.width) || !isPositiveNumber(crop.height)
    || crop.x + crop.width > 100 + ALIGN_TOLERANCE_PERCENT || crop.y + crop.height > 100 + ALIGN_TOLERANCE_PERCENT) {
    throw invalid("crop must be percentages (0-100) that stay inside the frame");
  }
  for (const target of [crop.targetWidth, crop.targetHeight]) {
    if (target !== undefined && target !== null && !isPositiveNumber(target)) throw invalid("crop target size must be positive");
  }
}

/**
 * Openinary can only crop from the centre. A box that spans the full height (or width) and is
 * centred on the other axis is exactly that, and it is what the aspect-ratio presets produce.
 */
function centredRegion(crop: CropRequest, source: Dimensions): CropRegion {
  const fullWidth = crop.width >= 100 - ALIGN_TOLERANCE_PERCENT;
  const fullHeight = crop.height >= 100 - ALIGN_TOLERANCE_PERCENT;
  if (fullWidth && fullHeight) return { width: source.width, height: source.height, fullFrame: true };
  if (fullHeight && Math.abs(crop.x + crop.width / 2 - 50) <= ALIGN_TOLERANCE_PERCENT) {
    return { width: Math.round((crop.width / 100) * source.width), height: source.height, fullFrame: false };
  }
  if (fullWidth && Math.abs(crop.y + crop.height / 2 - 50) <= ALIGN_TOLERANCE_PERCENT) {
    return { width: source.width, height: Math.round((crop.height / 100) * source.height), fullFrame: false };
  }
  throw new OpeninaryVideoError(
    "UNSUPPORTED_CROP_REGION",
    "This crop box cannot be applied to a video: only a crop centred in the frame that spans the full height or width is supported. Move the box back to the centre or pick an aspect-ratio preset.",
  );
}

export function planCrop(crop: CropRequest, source: Dimensions | null): OpeninaryPlan {
  assertCrop(crop);
  if (!source) {
    throw new OpeninaryVideoError("SOURCE_DIMENSIONS_UNKNOWN", "The video's width and height are unknown, so the crop cannot be sized. Re-open the video and try again.");
  }
  const region = centredRegion(crop, source);
  const cw = evenDimension(region.width);
  const ch = evenDimension(region.height);
  const { targetWidth, targetHeight } = crop;
  let output: Dimensions = { width: cw, height: ch };

  if (targetWidth && targetHeight) {
    // Cloudinary only ever scaled up: a crop already as large as the target keeps its size.
    if (cw < targetWidth || ch < targetHeight) {
      const drift = Math.abs(cw / ch / (targetWidth / targetHeight) - 1);
      if (drift > TARGET_ASPECT_TOLERANCE) {
        throw new OpeninaryVideoError(
          "UNSUPPORTED_CROP_TARGET",
          "The crop's shape does not match the target resolution, and Openinary cannot crop and then resize a video in one step. Choose the matching aspect-ratio preset.",
        );
      }
      output = { width: evenDimension(targetWidth), height: evenDimension(targetHeight) };
    }
  } else if (!targetWidth && !targetHeight && region.width / region.height < NARROW_VERTICAL_RATIO && cw < MIN_VERTICAL_WIDTH) {
    output = { width: MIN_VERTICAL_WIDTH, height: evenDimension(MIN_VERTICAL_WIDTH / (region.width / region.height)) };
  }

  const q = QUALITY_TIER_Q.good;
  return { segment: `w_${output.width},h_${output.height},c_fill,q_${q},f_mp4`, output, warnings: [] };
}

/* ── Cloudinary eager transformations (fallback provider only) ─────────────────── */

export function cloudinaryCompressTransformation(request: CompressRequest): string {
  assertCompress(request);
  const level = qualityTier(request.quality);
  if (request.maxSizeMB && request.maxSizeMB < 50) {
    const bitrate = request.maxSizeMB < 10 ? "500k" : request.maxSizeMB < 25 ? "1000k" : "2000k";
    return `vc_h264,br_${bitrate},q_auto:${level},f_mp4`;
  }
  return `vc_h264,q_auto:${level},f_mp4`;
}

export function cloudinaryCropTransformation(crop: CropRequest, source: Dimensions | null): string {
  assertCrop(crop);
  const { targetWidth, targetHeight } = crop;
  if (!source) {
    const f = (percent: number) => Number(Math.min(1, Math.max(0, percent / 100)).toFixed(4));
    let chain = `c_crop,fl_relative,x_${f(crop.x)},y_${f(crop.y)},w_${f(crop.width)},h_${f(crop.height)}`;
    if (targetWidth && targetHeight) chain += `/c_scale,w_${targetWidth},h_${targetHeight}`;
    return `${chain}/vc_h264,q_auto:good,f_mp4`;
  }
  const px = (percent: number, dimension: number) => Math.round((percent / 100) * dimension);
  const x = px(crop.x, source.width);
  const y = px(crop.y, source.height);
  const w = px(crop.width, source.width);
  const h = px(crop.height, source.height);
  let chain = `c_crop,x_${x},y_${y},w_${w},h_${h}`;
  if (targetWidth && targetHeight) {
    if (w < targetWidth || h < targetHeight) chain += `/c_scale,w_${targetWidth},h_${targetHeight}`;
  } else if (w / h < NARROW_VERTICAL_RATIO && w < MIN_VERTICAL_WIDTH) {
    chain += `/c_scale,w_${MIN_VERTICAL_WIDTH},h_${Math.round(MIN_VERTICAL_WIDTH / (w / h))}`;
  }
  return `${chain}/vc_h264,q_auto:good,f_mp4`;
}

export function cloudinaryTranscodeTransformation(platform: TranscodePlatform): string {
  const { width, height } = TRANSCODE_PRESETS[platform];
  const ratio = width > height ? "16:9" : "9:16";
  return `c_fill,w_${width},h_${height},ar_${ratio},g_center/vc_h264,q_auto:best,f_mp4`;
}
