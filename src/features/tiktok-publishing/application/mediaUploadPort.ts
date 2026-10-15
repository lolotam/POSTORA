import { createContext, createElement, useContext, type ReactNode } from "react";

export interface UploadedVideo {
  /** media_files.id, the value a draft stores as mediaFileId. */
  mediaFileId: string;
  url: string;
  /** Seconds, when the upload service reports it. */
  durationSec: number | null;
}

/** Uploads a video picked from the user's computer into their media library. */
export interface TikTokMediaUploader {
  uploadVideo(file: File): Promise<UploadedVideo>;
}

const TikTokMediaUploaderContext = createContext<TikTokMediaUploader | null>(null);

export function TikTokMediaUploaderProvider({
  uploader,
  children,
}: {
  uploader: TikTokMediaUploader;
  children: ReactNode;
}) {
  return createElement(TikTokMediaUploaderContext.Provider, { value: uploader }, children);
}

export function useTikTokMediaUploader(): TikTokMediaUploader {
  const uploader = useContext(TikTokMediaUploaderContext);
  if (!uploader) throw new Error("useTikTokMediaUploader must be used within TikTokMediaUploaderProvider");
  return uploader;
}
