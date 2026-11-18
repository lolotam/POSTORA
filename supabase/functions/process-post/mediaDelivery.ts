/**
 * Where a media file is read from.
 *
 * There is ONE way to resolve a media file to a URL, and every path that
 * reads one uses it: the publishing path, and the YouTube continuation that
 * carries a half written upload on. A second way would let the two disagree
 * about which object is being published, and a continuation that uploaded
 * different bytes than the publish would have is a video nobody asked for.
 *
 * Three things decide the URL, and they are all properties of the file
 * itself:
 *
 *   * the BUCKET the file lives in, which is part of its identity: the same
 *     path in another bucket is another object, and a signed URL is only made
 *     for the bucket the object is really in;
 *   * the CONTENT VERSION, because a rename bumps the version and the old
 *     provider rows stay "ready" with dead URLs;
 *   * the PROVIDER ROWS that match that version.
 *
 * The order the providers are read in is an admin setting, so it is read
 * through one function that every path calls.
 *
 * WHAT THE WORKER MAY READ
 * ------------------------
 * A media row is a row an authenticated user may write: the policies on
 * `media_files` check the OWNER and nothing else. The worker reads media with
 * the service role, which can sign an object in ANY bucket, so the row cannot
 * be trusted to name a file the customer owns.
 *
 * Four rules close that gap, and they are the rules this resolver owns:
 *
 *   * the BUCKET has to be one of the buckets Postora writes to;
 *   * the FILE has to be the media of this post: a post names its media by id,
 *     and the ids are written by the customer, so a post may name a media file
 *     of somebody else;
 *   * an object in a storage bucket has to sit under the PREFIX of its own
 *     tenancy, which is where the storage policies put it, before it is signed;
 *   * a delivery URL has to be an approved HTTPS host, so a crafted path
 *     cannot point the worker at an address inside the deployment.
 *
 * The host policy is the one the YouTube read path already enforces, so there
 * is a single rule about which hosts the worker may read from.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { isApprovedMediaUrl } from "./youtubeUploadPolicy.ts";

/**
 * Media file data from the media_files table.
 */
export interface MediaFile {
  id: string;
  /** The owner of the file. It is the prefix a storage object lives under. */
  user_id: string;
  file_path: string;
  file_type: string;
  storage_bucket: string;
  /**
   * The workspace the file belongs to.
   *
   * The partner API writes its media into the workspace's own prefix, so this
   * is the prefix of a partner object and nothing else.
   */
  workspace_id?: string | null;
  mime_type?: string | null;
  current_object_version?: number | null;
  file_size?: number | null;
}

/** One provider row of a media file. */
export interface MediaProviderRow {
  provider: string;
  object_version: number | null;
  status: string;
  delivery_url: string | null;
}

/** The provider rows of the media files, keyed by media file id. */
export type MediaProviderRows = Record<string, MediaProviderRow[]>;

/**
 * The order the CDN providers are read in.
 *
 * It is an admin setting, and every path that reads a media file has to agree
 * on it: the publishing path and the YouTube continuation must resolve the
 * same object, or a continuation would upload bytes that the publish did not.
 */
export async function cdnReadPreferenceOrder(supabase: SupabaseClient): Promise<string[]> {
  let readPreference = "openinary";
  try {
    const { data: cdnSetting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "cdn_storage")
      .maybeSingle();
    if (typeof cdnSetting?.value?.read_preference === "string") {
      readPreference = cdnSetting.value.read_preference;
    }
  } catch (e) {
    console.warn("[process-post] cdn_storage read failed, defaulting read_preference to openinary:", e);
  }
  return readPreference === "openinary"
    ? ["openinary", "cloudinary"]
    : ["cloudinary", "openinary"];
}

/**
 * The provider rows of the media files, keyed by media file id.
 *
 * The rows are matched against each file's own content version: a rename
 * bumps the version, and the stale rows stay 'ready' with dead URLs.
 */
export async function loadMediaProviderRows(
  supabase: SupabaseClient,
  mediaFiles: MediaFile[],
): Promise<MediaProviderRows> {
  const providerRowsByMedia: MediaProviderRows = {};
  if (mediaFiles.length === 0) return providerRowsByMedia;
  try {
    const { data: providerRows } = await supabase
      .from("media_file_providers")
      .select("media_file_id, provider, object_version, status, delivery_url")
      .in("media_file_id", mediaFiles.map((file) => file.id));
    if (providerRows) {
      for (const row of providerRows) {
        (providerRowsByMedia[row.media_file_id] ||= []).push(row);
      }
    }
  } catch (e) {
    console.warn("[process-post] media provider rows read failed:", e);
  }
  return providerRowsByMedia;
}

/**
 * The buckets a media file may live in.
 *
 * The two storage buckets are Postora's own: the object sits under the owner's
 * prefix and the worker signs it. The partner bucket is the partner API's:
 * its object sits under the workspace's prefix. The two CDN buckets carry the
 * delivery URL in their file path.
 *
 * A bucket that is not on this list is refused: the service role can sign an
 * object in ANY bucket, so a bucket the worker does not write to is a bucket a
 * crafted row must not be able to reach.
 */
const STORAGE_BUCKETS = new Set(["media", "supabase"]);
const CDN_BUCKETS = new Set(["cloudinary", "openinary"]);

/** The bucket the partner API writes to. Its objects live under a workspace prefix. */
const PARTNER_MEDIA_BUCKET = "partner-media";

/**
 * What the resolver needs to know to decide whether a file may be read.
 */
export interface MediaDeliveryOptions {
  /** The order the CDN providers are read in. */
  preferenceOrder: string[];
  /** The user the post belongs to. */
  ownerUserId: string;
  /**
   * The workspaces the post publishes into.
   *
   * They are the workspaces of the post's own accounts, so a partner media
   * file of one of them may be read and the media of another one may not.
   */
  allowedWorkspaceIds: ReadonlySet<string>;
  /** The hosts a delivery URL may point at. */
  approvedHosts: Set<string>;
}

/** Why a media file may not be read. */
export type MediaDeliveryRefusal = "bucket_not_allowed" | "not_owned" | "origin_not_approved";

/**
 * A media file that may not be read.
 *
 * It names the rule that refused it and never the path or the URL: a
 * delivery URL is a credential, and this refusal ends up in a log line.
 */
export class MediaDeliveryRefusedError extends Error {
  readonly reason: MediaDeliveryRefusal;

  constructor(reason: MediaDeliveryRefusal, message: string) {
    super(message);
    this.name = "MediaDeliveryRefusedError";
    this.reason = reason;
  }
}

/** Whether a media path is a delivery URL rather than a storage object path. */
function isDeliveryUrl(path: string): boolean {
  return path.startsWith("https://") || path.startsWith("http://");
}

/** Whether a bucket is one Postora writes to. */
function isAllowedBucket(bucket: string): boolean {
  return STORAGE_BUCKETS.has(bucket) || CDN_BUCKETS.has(bucket) || bucket === PARTNER_MEDIA_BUCKET;
}

/** Whether a storage path is the owner's own object. */
function isOwnedPath(path: string, prefix: string | null | undefined): boolean {
  if (typeof prefix !== "string" || prefix.length === 0 || !path.startsWith(`${prefix}/`)) return false;
  // `OWNER/../VICTIM/x` starts with the owner's prefix but names another
  // tenant's object once the storage layer resolves it. Dot segments, empty
  // segments, backslashes and encoded separators are never part of an object
  // key Postora writes.
  if (/[\\\u0000-\u001f]|%2e|%2f|%5c/i.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Whether the file is the media of the post that names it.
 *
 * A post names its media by id, and the ids are written by the customer, so a
 * post may name a media file of somebody else. The file belongs to the post
 * when the owner of the file is the owner of the post. A partner file belongs
 * to a workspace instead, and the post may only publish from a workspace it
 * targets.
 */
function belongsToPost(file: MediaFile, options: MediaDeliveryOptions): boolean {
  if (file.storage_bucket === PARTNER_MEDIA_BUCKET) {
    const workspaceId = file.workspace_id;
    return typeof workspaceId === "string" && options.allowedWorkspaceIds.has(workspaceId);
  }
  return file.user_id === options.ownerUserId;
}

/**
 * The delivery URL of the provider that is ready for this file's version.
 *
 * The rows are matched against the file's own content version: a rename bumps
 * the version, and the stale rows stay 'ready' with dead URLs.
 */
function readyProviderUrl(
  file: MediaFile,
  providerRowsByMedia: MediaProviderRows,
  preferenceOrder: string[],
): string | null {
  const currentVersion = file.current_object_version ?? 1;
  const providers = (providerRowsByMedia[file.id] || []).filter((row) => (row.object_version ?? 1) === currentVersion);
  for (const provider of preferenceOrder) {
    const ready = providers.find((row) => row.provider === provider && row.status === "ready" && !!row.delivery_url);
    if (ready) return ready.delivery_url!;
  }
  return null;
}

/**
 * A delivery URL the worker may fetch.
 *
 * The host policy is the one the YouTube read path already enforces, so the
 * worker has a single rule about which hosts it may read from.
 */
function approvedDeliveryUrl(url: string, approvedHosts: Set<string>): string {
  if (!isApprovedMediaUrl(url, approvedHosts)) {
    throw new MediaDeliveryRefusedError(
      "origin_not_approved",
      "The media is stored on a host this worker may not read from.",
    );
  }
  return url;
}

/** The signed URL of a storage object. */
async function signStorageObject(supabase: SupabaseClient, file: MediaFile): Promise<string> {
  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from(file.storage_bucket)
    .createSignedUrl(file.file_path, 3600);
  if (signedUrlError) throw new Error(`Could not create a delivery URL for media ${file.id}`);
  if (!signedUrlData?.signedUrl) throw new Error(`Missing signed URL for media ${file.id}`);
  return signedUrlData.signedUrl;
}

/**
 * Whether the path of a storage object is inside the namespace of its tenancy.
 *
 * The app's buckets put every object under the owner's prefix; the partner
 * bucket puts it under the workspace's. The service role can sign an object
 * in ANY bucket, so the path has to be inside the namespace of the media's
 * own tenancy before it is signed.
 */
function isOwnedStoragePath(file: MediaFile, options: MediaDeliveryOptions): boolean {
  const prefix = file.storage_bucket === PARTNER_MEDIA_BUCKET ? file.workspace_id : options.ownerUserId;
  return isOwnedPath(file.file_path, prefix);
}

/**
 * The URL one media file is read from.
 *
 * The provider's delivery URL is preferred, because that is the one the CDN
 * serves, and a storage signed URL is the fallback. The two CDN buckets carry
 * the whole URL in their file path.
 */
export async function resolveMediaUrl(
  supabase: SupabaseClient,
  file: MediaFile,
  providerRowsByMedia: MediaProviderRows,
  options: MediaDeliveryOptions,
): Promise<string | null> {
  if (!isAllowedBucket(file.storage_bucket)) {
    throw new MediaDeliveryRefusedError(
      "bucket_not_allowed",
      `The media bucket ${file.storage_bucket} is not one this worker may read.`,
    );
  }

  if (!belongsToPost(file, options)) {
    throw new MediaDeliveryRefusedError(
      "not_owned",
      "The media is not this post's media.",
    );
  }

  const providerUrl = readyProviderUrl(file, providerRowsByMedia, options.preferenceOrder);
  if (providerUrl) return approvedDeliveryUrl(providerUrl, options.approvedHosts);

  if (CDN_BUCKETS.has(file.storage_bucket) || isDeliveryUrl(file.file_path)) {
    return approvedDeliveryUrl(file.file_path, options.approvedHosts);
  }

  if (!isOwnedStoragePath(file, options)) {
    throw new MediaDeliveryRefusedError(
      "not_owned",
      "The media is not stored under its own prefix.",
    );
  }
  return await signStorageObject(supabase, file);
}
