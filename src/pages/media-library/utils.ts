import { resolveMediaPublicUrl, type StorageUrlResolver } from "@/lib/mediaUrl";

export function libraryFilePublicUrl(
  file: { file_path: string; storage_bucket?: string | null; current_object_version?: number | null },
  storageResolver?: StorageUrlResolver,
): string {
  return resolveMediaPublicUrl(file, storageResolver);
}

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
};

export const extractCloudName = (url: string): string => {
  const match = url.match(/res\.cloudinary\.com\/([^\/]+)/);
  return match ? match[1] : "";
};

export const isProcessedFile = (filePath: string): boolean => {
  const fileName = filePath.split("/").pop() || "";
  return (
    fileName.includes("bg-removed") ||
    fileName.includes("filtered") ||
    fileName.includes("upscaled") ||
    fileName.includes("_square") ||
    fileName.includes("_portrait") ||
    fileName.includes("_landscape") ||
    fileName.includes("_custom")
  );
};
