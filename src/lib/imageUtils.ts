/**
 * Image optimization and format validation utilities
 */

import { 
  formatFileSize, 
  PLATFORM_MEDIA_SPECS, 
  type PlatformMediaSpec 
} from "./platformMediaSpecs";

// Re-export for backwards compatibility
export { formatFileSize } from "./platformMediaSpecs";

// Legacy alias for backwards compatibility
export const platformSpecs = PLATFORM_MEDIA_SPECS;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateMediaForPlatforms(
  file: File,
  platforms: string[]
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');

  for (const platform of platforms) {
    const specs = PLATFORM_MEDIA_SPECS[platform];
    if (!specs) continue;

    // Check format
    if (isImage && !specs.supportedImageFormats.includes(file.type)) {
      errors.push(
        `${platform}: ${file.type} format not supported. Use: ${specs.supportedImageFormats.join(', ')}`
      );
    }
    if (isVideo && !specs.supportedVideoFormats.includes(file.type)) {
      errors.push(
        `${platform}: ${file.type} format not supported. Use: ${specs.supportedVideoFormats.join(', ')}`
      );
    }

    // Check file size
    const maxSize = isImage ? specs.maxImageSize : specs.maxVideoSize;
    if (file.size > maxSize) {
      errors.push(
        `${platform}: File size (${formatFileSize(file.size)}) exceeds limit (${formatFileSize(maxSize)})`
      );
    }

    // Size warning for optimization
    if (isImage && file.size > 2 * 1024 * 1024) {
      warnings.push(
        `${platform}: Image is large (${formatFileSize(file.size)}), consider compressing for faster uploads`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// Compress image using Canvas API
export async function compressImage(
  file: File,
  quality: number = 0.8,
  maxWidth: number = 2048,
  maxHeight: number = 2048
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Revoked on both paths: reference-image uploads call this repeatedly, and
    // an unreleased object URL holds the whole blob for the page's lifetime.
    const objectUrl = URL.createObjectURL(file);
    const settle = <T,>(finish: (value: T) => void, value: T) => {
      URL.revokeObjectURL(objectUrl);
      finish(value);
    };

    img.onload = () => {
      let { width, height } = img;

      // Calculate new dimensions while maintaining aspect ratio
      if (width > maxWidth) {
        height = (height * maxWidth) / width;
        width = maxWidth;
      }
      if (height > maxHeight) {
        width = (width * maxHeight) / height;
        height = maxHeight;
      }

      canvas.width = width;
      canvas.height = height;

      if (!ctx) {
        settle(reject, new Error('Failed to get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (blob) {
            settle(resolve, blob);
          } else {
            settle(reject, new Error('Failed to compress image'));
          }
        },
        'image/jpeg',
        quality
      );
    };

    img.onerror = () => settle(reject, new Error('Failed to load image'));
    img.src = objectUrl;
  });
}

// Get image dimensions
export function getImageDimensions(
  file: File
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.width, height: img.height });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
}

export function getVideoMetadata(
  file: File
): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        video.removeAttribute('src');
        video.load();
      } catch {
        // ignore
      }
    };

    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      cleanup();
      resolve({ width, height, duration });
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('Failed to load video metadata'));
    };

    video.src = objectUrl;
  });
}

export function getVideoMetadataFromUrl(
  url: string
): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');

    const cleanup = () => {
      try {
        video.removeAttribute('src');
        video.load();
      } catch {
        // ignore
      }
    };

    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';

    video.onloadedmetadata = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      cleanup();
      resolve({ width, height, duration });
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('Failed to load video metadata'));
    };

    video.src = url;
  });
}

export async function validateMediaForPlatformsAsync(
  file: File,
  platforms: string[]
): Promise<ValidationResult> {
  const base = validateMediaForPlatforms(file, platforms);
  const errors = [...base.errors];
  const warnings = [...base.warnings];

  const isVideo = file.type.startsWith('video/');
  const includesTikTok = platforms.includes('tiktok');

  if (includesTikTok && isVideo) {
    try {
      const meta = await getVideoMetadata(file);

      // TikTok strongly prefers vertical 9:16. Enforce a sane minimum.
      // (These are conservative values meant to prevent the common TikTok error: picture_size_check_failed)
      if (meta.width > 0 && meta.height > 0) {
        const ratio = meta.width / meta.height;
        const isVertical = meta.height >= meta.width;

        if (!isVertical) {
          errors.push(
            `tiktok: Video must be vertical (9:16). Your video is ${meta.width}×${meta.height}.`
          );
        }

        // Minimum resolution guidance (conservative)
        if (meta.width < 540 || meta.height < 960) {
          errors.push(
            `tiktok: Video resolution is too small (${meta.width}×${meta.height}). Use at least 540×960 (recommended 720×1280+).`
          );
        }

        // Ratio hint (not strict)
        if (ratio < 0.50 || ratio > 0.65) {
          warnings.push(
            `tiktok: Video aspect ratio looks off for 9:16 (${meta.width}×${meta.height}). For best results, export as 720×1280 (9:16).`
          );
        }
      }

      if (meta.duration === 0) {
        warnings.push('tiktok: Could not detect video duration; TikTok may reject unsupported exports.');
      }

      // Extra heuristic: extremely small files often get rejected as "picture_size_check_failed"
      if (file.size < 1024 * 1024) {
        warnings.push(
          `tiktok: This video is very small (${formatFileSize(file.size)}). Very low-res exports are commonly rejected by TikTok.`
        );
      }
    } catch {
      warnings.push(
        'tiktok: Could not read video metadata to validate resolution/aspect ratio. If TikTok fails, re-export as a vertical 9:16 MP4.'
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// Calculate optimal compression quality based on target size
export async function optimizeForSize(
  file: File,
  targetSizeBytes: number,
  maxWidth: number = 2048,
  maxHeight: number = 2048
): Promise<Blob> {
  let quality = 0.9;
  let compressed = await compressImage(file, quality, maxWidth, maxHeight);

  // Binary search for optimal quality
  let minQuality = 0.1;
  let maxQuality = 0.9;

  while (maxQuality - minQuality > 0.05) {
    quality = (minQuality + maxQuality) / 2;
    compressed = await compressImage(file, quality, maxWidth, maxHeight);

    if (compressed.size > targetSizeBytes) {
      maxQuality = quality;
    } else {
      minQuality = quality;
    }
  }

  return compressed;
}
