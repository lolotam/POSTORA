/** One mapping from a video-processing failure to the reply the UI shows and the log line we keep. */

import { MediaQuotaRefusal } from "./derivedVideoMedia.ts";
import { MEDIA_QUOTA_CODE } from "./mediaQuotaError.ts";
import { OpeninaryVideoError } from "./openinaryVideoTransform.ts";

export interface VideoFailureReply {
  status: number;
  body: { success: false; error: string; error_code: string };
  logLevel: "warn" | "error";
  /** Stable code for the log line; the same as error_code. */
  code: string;
}

export function mapVideoFailure(error: unknown): VideoFailureReply {
  if (error instanceof OpeninaryVideoError) {
    return { status: error.status, body: { success: false, error: error.message, error_code: error.code }, logLevel: "warn", code: error.code };
  }
  if (error instanceof MediaQuotaRefusal) {
    return { status: 429, body: { success: false, error: error.message, error_code: MEDIA_QUOTA_CODE }, logLevel: "warn", code: MEDIA_QUOTA_CODE };
  }
  // Unexpected: the cause goes to the log by the caller, never to the client.
  return {
    status: 500,
    body: { success: false, error: "Video processing failed. Please try again.", error_code: "PROCESSING_ERROR" },
    logLevel: "error",
    code: "PROCESSING_ERROR",
  };
}
