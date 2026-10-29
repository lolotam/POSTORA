/**
 * Records a browser-direct upload in the library once its bytes are confirmed.
 *
 * Writes the same rows as the edge-function upload (cloudinary-upload/index.ts):
 * one media_files row through the caller's client, so RLS and the daily-quota
 * trigger apply, and one media_file_providers row per attempted provider through
 * the admin client.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteJustUploaded, quotaInsertRefusal } from "../cloudinary-upload/mediaQuota.ts";
import type { DirectUploadSession } from "./session.ts";

export interface CloudinaryStored {
  public_id: string;
  secure_url: string;
  bytes?: number;
  width?: number;
  height?: number;
  format?: string;
  duration?: number;
}

export interface DirectUploadFacts {
  session: DirectUploadSession;
  cloudinary: CloudinaryStored | null;
  openinary: { path: string; url: string } | null;
  /** One "provider: reason" entry per attempted provider that holds nothing. */
  errors: string[];
  cloudName?: string;
}

export interface RegisterOutcome {
  status: number;
  body: Record<string, unknown>;
}

const OBJECT_VERSION = 1;

export function storedProviders(facts: Pick<DirectUploadFacts, "cloudinary" | "openinary">): string[] {
  return [facts.openinary ? "openinary" : null, facts.cloudinary ? "cloudinary" : null].filter((p): p is string => !!p);
}

/** The URL the app serves first: the admin's read preference when that provider holds the file. */
export function primaryDeliveryUrl(facts: Pick<DirectUploadFacts, "cloudinary" | "openinary" | "session">): string | null {
  const openinaryUrl = facts.openinary?.url ?? null;
  const cloudinaryUrl = facts.cloudinary?.secure_url ?? null;
  return facts.session.readPreference === "openinary"
    ? (openinaryUrl || cloudinaryUrl)
    : (cloudinaryUrl || openinaryUrl);
}

function successBody(facts: DirectUploadFacts, mediaFileId: string, url: string | null): Record<string, unknown> {
  const storedIn = storedProviders(facts);
  const requiredSatisfied = facts.session.required.every((provider) => storedIn.includes(provider));
  return {
    success: true,
    url,
    publicId: facts.cloudinary?.public_id,
    cloudName: facts.cloudName,
    mediaFileId,
    width: facts.cloudinary?.width,
    height: facts.cloudinary?.height,
    format: facts.cloudinary?.format || facts.session.ext,
    bytes: facts.cloudinary?.bytes ?? facts.session.size,
    duration: facts.cloudinary?.duration,
    isDuplicate: false,
    storedIn,
    partial: !requiredSatisfied || facts.errors.length > 0,
    errors: facts.errors.length ? facts.errors : undefined,
  };
}

export async function registerDirectUpload(userDb: SupabaseClient, adminDb: SupabaseClient, facts: DirectUploadFacts): Promise<RegisterOutcome> {
  const { session } = facts;
  const storedIn = storedProviders(facts);
  if (storedIn.length === 0) {
    return { status: 502, body: { success: false, storedIn, errors: facts.errors, error: facts.errors.join("; ") || "Upload failed" } };
  }

  // `complete` may be retried after a dropped response; the same session must not add a second row.
  const { data: existing } = await userDb
    .from("media_files")
    .select("id, file_path")
    .eq("user_id", session.uid)
    .eq("metadata->>direct_upload_id", session.publicId)
    .maybeSingle();
  if (existing?.id) return { status: 200, body: successBody(facts, existing.id, existing.file_path) };

  const url = primaryDeliveryUrl(facts);
  const { data: row, error: insertError } = await userDb
    .from("media_files")
    .insert({
      user_id: session.uid,
      file_path: url,
      file_type: session.storedFileType,
      file_size: facts.cloudinary?.bytes ?? session.size,
      mime_type: session.mime,
      storage_bucket: facts.cloudinary ? "cloudinary" : "openinary",
      cloudinary_public_id: facts.cloudinary?.public_id ?? null,
      platforms: [],
      social_account_ids: [],
      upload_date: session.uploadDate,
      metadata: {
        width: facts.cloudinary?.width || null,
        height: facts.cloudinary?.height || null,
        format: facts.cloudinary?.format || session.ext,
        duration: facts.cloudinary?.duration || null,
        original_filename: session.originalFilename,
        kind: session.kind,
        direct_upload_id: session.publicId,
      },
    })
    .select("id")
    .single();

  if (insertError || !row) {
    const quotaRace = await quotaInsertRefusal(insertError?.message ?? "", () => deleteJustUploaded({
      storedIn,
      openinaryPath: facts.openinary?.path ?? null,
      cloudinaryPublicId: facts.cloudinary?.public_id ?? null,
      kind: session.kind,
    }));
    if (quotaRace) return { status: quotaRace.status, body: quotaRace.body };
    console.error("[media-direct-upload] media_files insert failed");
    return { status: 500, body: { success: false, error: "Could not save the upload to your library" } };
  }

  const providerRows = session.providers.map((provider) => {
    const failure = facts.errors.find((error) => error.startsWith(`${provider}:`));
    const ready = provider === "openinary" ? facts.openinary : facts.cloudinary;
    return {
      media_file_id: row.id,
      provider,
      object_version: OBJECT_VERSION,
      object_key: provider === "cloudinary"
        ? (facts.cloudinary?.public_id ?? `${session.folder}/${session.publicId}`)
        : (facts.openinary?.path ?? (session.openinary ? `${session.openinary.folder}/${session.openinary.fileName}` : session.publicId)),
      status: ready ? "ready" : "failed",
      delivery_url: provider === "openinary" ? facts.openinary?.url ?? null : facts.cloudinary?.secure_url ?? null,
      error: ready ? null : (failure ?? `${provider}: upload failed`),
      bytes: facts.cloudinary?.bytes ?? session.size,
      mime_type: session.mime,
    };
  });
  const { error: providerError } = await adminDb.from("media_file_providers").insert(providerRows);
  // The library row already points at a stored object, so a lost bookkeeping row is
  // reported rather than turned into a failed upload the user would retry.
  const errors = providerError ? [...facts.errors, "provider state: could not record provider rows"] : facts.errors;
  if (providerError) console.error("[media-direct-upload] media_file_providers insert failed");

  return { status: 200, body: successBody({ ...facts, errors }, row.id, url) };
}
