/**
 * Rebuilding the bytes of an owned video.
 *
 * A continuation that carries a YouTube upload on has to read the video
 * again, and it has to read THE video: the file the post names, at the
 * content version the upload started with, out of the bucket it lives in.
 *
 * So the source is rebuilt the way the publishing path builds it, through the
 * one resolver in mediaDelivery.ts. Nothing here hard-codes a bucket, and
 * nothing here reaches outside the approved media hosts: the URL that comes
 * back from the resolver is checked against the host policy before the first
 * byte is asked for, exactly as the publishing path checks it.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  cdnReadPreferenceOrder,
  loadMediaProviderRows,
  MediaDeliveryRefusedError,
  resolveMediaUrl,
  type MediaFile,
} from "./mediaDelivery.ts";
import { createVideoByteSource, VideoSourceError } from "./youtubeVideoSource.ts";
import type { UploadByteSource } from "./youtubeResumableUpload.ts";
import {
  isApprovedMediaUrl,
  redactProviderText,
  YOUTUBE_UPLOAD_REASON,
  youtubeStorageReadUrl,
} from "./youtubeUploadPolicy.ts";

/** An owned media file, as the continuation knows it. */
export interface OwnedVideoFile {
  id: string;
  userId: string;
  filePath: string;
  storageBucket: string;
  /** The workspace the media belongs to. The partner API writes under it. */
  workspaceId?: string | null;
  mimeType: string | null;
  fileSize?: number | null;
  currentObjectVersion: number | null;
}

/** Why a source could not be rebuilt. */
export class VideoSourceUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "VideoSourceUnavailableError";
    this.reason = reason;
  }
}

/**
 * The row the resolver reads.
 *
 * It is the file's own bucket and the content version the upload started
 * with: the same path in another bucket is another object, and a stale
 * version is a file that has been replaced.
 */
function ownedVideoRow(file: OwnedVideoFile): MediaFile {
  return {
    id: file.id,
    user_id: file.userId,
    file_path: file.filePath,
    file_type: "video",
    storage_bucket: file.storageBucket,
    workspace_id: file.workspaceId ?? null,
    mime_type: file.mimeType,
    current_object_version: file.currentObjectVersion,
  };
}

/** The URL the owned video is read from, through the normal resolver. */
async function ownedVideoUrl(
  supabase: SupabaseClient,
  file: OwnedVideoFile,
  mediaHosts: Set<string>,
  allowedWorkspaceIds: ReadonlySet<string>,
): Promise<string | null> {
  const row = ownedVideoRow(file);
  const providerRowsByMedia = await loadMediaProviderRows(supabase, [row]);
  const preferenceOrder = await cdnReadPreferenceOrder(supabase);
  return await resolveMediaUrl(supabase, row, providerRowsByMedia, {
    preferenceOrder,
    ownerUserId: file.userId,
    // The set is the caller's authority, never the media row itself: the row
    // is one the owner may rewrite after the admission, and a partner row
    // that renamed its workspace must not carry the read along with it.
    allowedWorkspaceIds,
    approvedHosts: mediaHosts,
  });
}

/**
 * The source of an owned video, or a refusal that says why there is none.
 *
 * The refusal names a stable reason and never the URL: a signed media URL is
 * a credential, and it must not end up in an error a customer reads.
 */
export async function createOwnedVideoSource(args: {
  supabase: SupabaseClient;
  file: OwnedVideoFile;
  /**
   * The workspaces the post publishes into.
   *
   * They are read independently of the media row -- from the post's own
   * target accounts -- because the row is one the owner may rewrite: after
   * the admission it can name another workspace's partner media, and the
   * read authority has to be the post's targets, not the row's own word.
   */
  allowedWorkspaceIds: ReadonlySet<string>;
  mediaHosts: Set<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<UploadByteSource> {
  const { supabase, file, mediaHosts, allowedWorkspaceIds } = args;

  let url: string | null;
  try {
    const deliveryUrl = await ownedVideoUrl(supabase, file, mediaHosts, allowedWorkspaceIds);
    url = deliveryUrl ? youtubeStorageReadUrl(deliveryUrl) : null;
  } catch (error) {
    console.error(
      `[youtube] the delivery URL for media ${file.id} could not be signed:`,
      redactProviderText(error),
    );
    // A file on a host this upload may not read from is not a file that is
    // gone, so it gets the reason that says so.
    if (error instanceof MediaDeliveryRefusedError && error.reason === "origin_not_approved") {
      throw new VideoSourceUnavailableError(
        YOUTUBE_UPLOAD_REASON.media_origin_not_approved,
        "The video is stored on a host this upload may not read from.",
      );
    }
    throw new VideoSourceUnavailableError(
      YOUTUBE_UPLOAD_REASON.media_unavailable,
      "The video for this post is no longer available in the media library.",
    );
  }
  if (!url) {
    console.error(`[youtube] no delivery URL could be resolved for media ${file.id}`);
    throw new VideoSourceUnavailableError(
      YOUTUBE_UPLOAD_REASON.media_unavailable,
      "The video for this post is no longer available in the media library.",
    );
  }

  // The host policy is checked before the first request, so an unapproved
  // host never receives one.
  if (!isApprovedMediaUrl(url, mediaHosts)) {
    throw new VideoSourceUnavailableError(
      YOUTUBE_UPLOAD_REASON.media_origin_not_approved,
      "The video is stored on a host this upload may not read from.",
    );
  }

  try {
    return await createVideoByteSource({
      url,
      mimeType: file.mimeType,
      declaredSize: file.fileSize,
      approvedHosts: mediaHosts,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    });
  } catch (error) {
    if (error instanceof VideoSourceError && error.reason === YOUTUBE_UPLOAD_REASON.media_origin_not_approved) {
      throw new VideoSourceUnavailableError(error.reason, error.message);
    }
    // The exception a failed media read throws carries the URL it was given,
    // and a signed media URL is a credential. The raw text is redacted into
    // the log line; the message the caller sees names no host and no URL.
    console.error(
      `[youtube] the video for media ${file.id} could not be read:`,
      redactProviderText(error),
    );
    throw new VideoSourceUnavailableError(
      YOUTUBE_UPLOAD_REASON.media_read_failed,
      "The video could not be read from the media host. Retry the publish.",
    );
  }
}
