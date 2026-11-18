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
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

/**
 * Media file data from the media_files table.
 */
export interface MediaFile {
  id: string;
  file_path: string;
  file_type: string;
  storage_bucket: string;
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
  preferenceOrder: string[],
): Promise<string | null> {
  const currentVersion = file.current_object_version ?? 1;
  const providers = (providerRowsByMedia[file.id] || []).filter((row) => (row.object_version ?? 1) === currentVersion);
  for (const provider of preferenceOrder) {
    const ready = providers.find((row) => row.provider === provider && row.status === "ready" && !!row.delivery_url);
    if (ready) return ready.delivery_url!;
  }
  if (file.storage_bucket === "cloudinary" || file.storage_bucket === "openinary" || file.file_path.startsWith("http")) {
    return file.file_path;
  }
  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from(file.storage_bucket)
    .createSignedUrl(file.file_path, 3600);
  if (signedUrlError) throw new Error(`Could not create a delivery URL for media ${file.id}`);
  if (!signedUrlData?.signedUrl) throw new Error(`Missing signed URL for media ${file.id}`);
  return signedUrlData.signedUrl;
}
