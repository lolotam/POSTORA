import type { UploadedFile } from "@/hooks/usePostForm";

export function readLibraryDuration(file: UploadedFile): number | null {
  // MediaLibraryPicker sets duration from metadata, but UploadedFile does not declare it.
  if (!("duration" in file)) return null;
  const duration = file.duration;
  return typeof duration === "number" && Number.isFinite(duration) ? duration : null;
}

export function measureVideoDuration(previewUrl: string): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 8000);
    video.onloadedmetadata = () => {
      finish(Number.isFinite(video.duration) ? video.duration : null);
    };
    video.onerror = () => finish(null);
    video.src = previewUrl;
  });
}
