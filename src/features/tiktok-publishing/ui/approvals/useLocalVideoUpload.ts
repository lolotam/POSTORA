import { useRef, useState, type ChangeEvent } from "react";
import { mediaTypeForFileName, MEDIA_DECODED_BYTE_CAP } from "@/lib/mediaTypes";
import { useTikTokMediaUploader } from "../../application/mediaUploadPort";
import { measureVideoDuration } from "../mediaDuration";
import { describeError } from "../reviewCopy";
import type { DraftReview } from "../useDraftReview";

export const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm";
const CAP_MB = Math.round(MEDIA_DECODED_BYTE_CAP / (1024 * 1024));

/**
 * "Add video" / "Change": opens the computer's file picker, uploads the chosen video to the
 * media library and attaches it to the draft. Videos already in the library stay available
 * through the separate "Choose from library" action.
 */
export function useLocalVideoUpload(review: DraftReview) {
  const uploader = useTikTokMediaUploader();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  function open() {
    inputRef.current?.click();
  }

  async function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const entry = mediaTypeForFileName(file.name);
    if (entry?.kind !== "video") {
      review.setMediaNotice("Choose an MP4, MOV or WebM video.");
      return;
    }
    if (file.size > entry.maxBytes) {
      review.setMediaNotice(`That video is over the ${CAP_MB} MB upload limit. Compress it or pick a shorter clip.`);
      return;
    }
    review.setMediaNotice(null);
    setUploading(true);
    try {
      const uploaded = await uploader.uploadVideo(file);
      const durationSec = uploaded.durationSec ?? await measureVideoDuration(uploaded.url);
      await review.attachVideo(uploaded.mediaFileId, durationSec);
    } catch (error) {
      review.setMediaNotice(describeError(review.translate, error));
    } finally {
      setUploading(false);
    }
  }

  return { inputRef, open, uploading, onFileChosen };
}
