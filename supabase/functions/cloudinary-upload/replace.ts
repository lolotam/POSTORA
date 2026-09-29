import { logToDatabase } from "../_shared/logging.ts";
import { destroyCloudinary } from "../_shared/cloudinaryDestroy.ts";
import { openinaryObjectKeyMatches } from "../_shared/mediaDeletePlan.ts";
import { deleteFromOpeninary, getOpeninaryConfig } from "../_shared/openinary.ts";
import { mediaTypeForMime, type MediaKind } from "../_shared/mediaTypes.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "audio", "document", "archive"];

const KIND_MISMATCH = "The new file must be the same kind as the old one";
const LOST_RACE = "The file changed while replacing; try again";
const FILE_MISSING = "File not found";
const FILE_DELETING = "This file is being deleted from your library";
const SAVE_FAILED = "Could not save the replacement";
const SCHEDULED_REWRITE_FAILED = "Pending scheduled messages could not be updated";

export interface ReplaceTargetRow {
  id: string;
  file_path: string | null;
  file_type: string;
  mime_type: string | null;
  storage_bucket: string | null;
  metadata: unknown;
  current_object_version: number | null;
  retention_state: string | null;
}

export interface ReplaceProviderRow {
  id: string;
  provider: string;
  object_version: number | null;
  object_key: string | null;
  status: string;
  delivery_url: string | null;
}

export type RetirementDecision =
  | { action: "skip"; id: string; reason: "deleted" | "failed" | "current_version" }
  | { action: "refuse"; id: string; reason: "key_mismatch" }
  | { action: "retire"; id: string };

export interface ReplaceUploadFacts {
  userId: string;
  primaryUrl: string | null;
  bytes: number | null;
  mimeType: string;
  storedFileType: string;
  kind: MediaKind;
  width: number | null;
  height: number | null;
  format: string | null;
  duration: number | null;
  storageBucket: string;
  storedIn: string[];
  errors: string[];
  providersAttempted: string[];
  cloudinaryPublicId: string | null;
  cloudinaryDeliveryUrl: string | null;
  cloudinaryFallbackKey: string;
  openinaryPath: string | null;
  openinaryUrl: string | null;
  openinaryFallbackKey: string;
}

export function isReplaceUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Absent field is a normal upload. A present non-UUID is a 400. */
export function parseReplaceMediaFileId(body: { replaceMediaFileId?: unknown }): { id?: string; error?: string } {
  if (!Object.prototype.hasOwnProperty.call(body, "replaceMediaFileId")) return {};
  if (!isReplaceUuid(body.replaceMediaFileId)) return { error: "replaceMediaFileId must be a UUID" };
  return { id: body.replaceMediaFileId };
}

export function kindFromMetadata(metadata: unknown): MediaKind | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const kind = (metadata as { kind?: unknown }).kind;
  return typeof kind === "string" && (MEDIA_KINDS as readonly string[]).includes(kind) ? kind as MediaKind : null;
}

/** metadata.kind wins. Older rows are classified from mime, then from file_type. */
export function targetMediaKind(row: { metadata?: unknown; file_type: string; mime_type?: string | null }): MediaKind {
  const recorded = kindFromMetadata(row.metadata);
  if (recorded) return recorded;
  const fromMime = mediaTypeForMime(row.mime_type);
  if (fromMime) return fromMime.entry.kind;
  if (row.file_type === "gif" || row.file_type === "image") return "image";
  if (row.file_type === "video") return "video";
  if (row.file_type === "audio") return "audio";
  if (row.file_type === "document") return "document";
  return "image";
}

export function replaceKindsMatch(targetKind: MediaKind, incomingKind: MediaKind): boolean {
  return targetKind === incomingKind;
}

/** max(current || 1, every provider object_version || 1) + 1. An empty provider list uses current only. */
export function nextObjectVersion(current: number | null | undefined, providerVersions: Array<number | null | undefined>): number {
  return Math.max(current || 1, ...providerVersions.map((version) => version || 1)) + 1;
}

/**
 * Old provider rows are retired. The version just written, and rows that never
 * stored an object (failed) or are already gone (deleted), are skipped.
 * Openinary is refused when object_key is not the path of its delivery URL
 * (or of file_path when the delivery URL is empty).
 */
export function planProviderRetirement(
  rows: ReplaceProviderRow[],
  nextVersion: number,
  oldFilePath: string | null | undefined,
): RetirementDecision[] {
  return rows.map((row) => {
    if (row.status === "deleted") return { action: "skip", id: row.id, reason: "deleted" };
    if (row.status === "failed") return { action: "skip", id: row.id, reason: "failed" };
    if ((row.object_version ?? 0) >= nextVersion) return { action: "skip", id: row.id, reason: "current_version" };
    if (row.provider === "openinary" && !openinaryObjectKeyMatches(row.object_key ?? "", row.delivery_url, oldFilePath)) {
      return { action: "refuse", id: row.id, reason: "key_mismatch" };
    }
    return { action: "retire", id: row.id };
  });
}

/** file_path plus every old provider delivery_url, trimmed and de-duplicated. */
export function scheduledMatchUrls(filePath: string | null | undefined, deliveryUrls: Array<string | null | undefined>): string[] {
  const urls: string[] = [];
  const push = (value: string | null | undefined) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || urls.includes(trimmed)) return;
    urls.push(trimmed);
  };
  push(filePath);
  for (const url of deliveryUrls) push(url);
  return urls;
}

/** New dimensions replace the old ones. The display name stays on original_filename. */
export function mergeReplaceMetadata(
  oldMetadata: unknown,
  incoming: { width: number | null; height: number | null; format: string | null; duration: number | null; kind: MediaKind },
): Record<string, unknown> {
  const old = oldMetadata && typeof oldMetadata === "object" && !Array.isArray(oldMetadata)
    ? { ...(oldMetadata as Record<string, unknown>) }
    : {};
  const merged: Record<string, unknown> = {
    ...old,
    width: incoming.width,
    height: incoming.height,
    format: incoming.format,
    duration: incoming.duration,
    kind: incoming.kind,
  };
  if ("original_filename" in old) merged.original_filename = old.original_filename;
  return merged;
}

export function buildReplacementProviderRows(mediaFileId: string, nextVersion: number, facts: ReplaceUploadFacts): Record<string, unknown>[] {
  return facts.providersAttempted.map((provider) => {
    const delivery = provider === "cloudinary" ? facts.cloudinaryDeliveryUrl : facts.openinaryUrl;
    const stored = facts.storedIn.includes(provider) && typeof delivery === "string" && delivery.length > 0;
    const providerError = facts.errors.find((entry) => entry.startsWith(`${provider}:`)) || "upload failed";
    return {
      media_file_id: mediaFileId,
      provider,
      object_version: nextVersion,
      object_key: provider === "cloudinary"
        ? (facts.cloudinaryPublicId || facts.cloudinaryFallbackKey)
        : (facts.openinaryPath || facts.openinaryFallbackKey),
      status: stored ? "ready" : "failed",
      delivery_url: stored ? delivery : null,
      error: stored ? null : providerError,
      bytes: facts.bytes,
      mime_type: facts.mimeType,
    };
  });
}

export type PreparedReplace =
  | { ok: true; row: ReplaceTargetRow }
  | { ok: false; status: number; body: { success: false; error: string }; refusal?: { message: string; metadata: Record<string, unknown> } };

export async function prepareMediaReplace(
  db: { from: (table: string) => any },
  mediaFileId: string,
  userId: string,
  incomingKind: MediaKind,
): Promise<PreparedReplace> {
  const { data, error } = await db.from("media_files")
    .select("id, file_path, file_type, mime_type, storage_bucket, metadata, current_object_version, retention_state")
    .eq("id", mediaFileId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[cloudinary-upload] replace target lookup failed");
    return { ok: false, status: 500, body: { success: false, error: SAVE_FAILED } };
  }
  if (!data) return { ok: false, status: 404, body: { success: false, error: FILE_MISSING } };
  if (data.retention_state === "deleting") return { ok: false, status: 409, body: { success: false, error: FILE_DELETING } };
  const targetKind = targetMediaKind(data);
  if (!replaceKindsMatch(targetKind, incomingKind)) {
    return {
      ok: false,
      status: 400,
      body: { success: false, error: KIND_MISMATCH },
      refusal: { message: "Rejected replace: file kind does not match", metadata: { reason: "replace_kind_mismatch", targetKind, incomingKind } },
    };
  }
  return { ok: true, row: data as ReplaceTargetRow };
}

async function deleteNewRemote(facts: ReplaceUploadFacts): Promise<void> {
  if (facts.storedIn.includes("openinary") && facts.openinaryPath) {
    const config = getOpeninaryConfig();
    if (config) {
      try { await deleteFromOpeninary(config, facts.openinaryPath); } catch { console.error("[cloudinary-upload] replace cleanup openinary failed"); }
    }
  }
  if (facts.storedIn.includes("cloudinary") && facts.cloudinaryPublicId) {
    const resourceType = facts.kind === "video" ? "video" : "image";
    try { await destroyCloudinary(facts.cloudinaryPublicId, resourceType); } catch { console.error("[cloudinary-upload] replace cleanup cloudinary failed"); }
  }
}

async function markVersionDeleted(db: { from: (table: string) => any }, mediaFileId: string, objectVersion: number, reason: string): Promise<void> {
  const { error } = await db.from("media_file_providers").update({
    status: "deleted",
    deleted_at: new Date().toISOString(),
    deleted_reason: reason,
  }).eq("media_file_id", mediaFileId).eq("object_version", objectVersion);
  if (error) console.error("[cloudinary-upload] replace provider mark-deleted failed");
}

async function retireOneProvider(
  db: { from: (table: string) => any },
  row: ReplaceTargetRow,
  provider: ReplaceProviderRow,
): Promise<boolean> {
  let reason = "superseded by replace";
  try {
    if (provider.provider === "openinary" && provider.object_key) {
      const config = getOpeninaryConfig();
      if (!config) {
        reason = "superseded by replace (remote delete failed)";
      } else {
        const removed = await deleteFromOpeninary(config, provider.object_key);
        if (!removed.success) reason = "superseded by replace (remote delete failed)";
      }
    } else if (provider.provider === "cloudinary" && provider.object_key) {
      const resourceType = targetMediaKind(row) === "video" ? "video" : "image";
      const destroyed = await destroyCloudinary(provider.object_key, resourceType);
      if (destroyed.reason === "provider_disabled") reason = "superseded by replace (provider disabled)";
      else if (!destroyed.success) reason = "superseded by replace (remote delete failed)";
    }
  } catch {
    reason = "superseded by replace (remote delete failed)";
  }
  const { error } = await db.from("media_file_providers").update({
    status: "deleted",
    deleted_at: new Date().toISOString(),
    deleted_reason: reason,
  }).eq("id", provider.id);
  if (error) console.error("[cloudinary-upload] replace retire update failed");
  return !error;
}

export async function commitMediaReplace(
  db: { from: (table: string) => any; storage: { from: (bucket: string) => { remove: (paths: string[]) => Promise<unknown> } } },
  row: ReplaceTargetRow,
  facts: ReplaceUploadFacts,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!facts.primaryUrl) {
    await deleteNewRemote(facts);
    return { status: 500, body: { success: false, error: SAVE_FAILED } };
  }

  const { data: existingProviders, error: providerReadError } = await db.from("media_file_providers")
    .select("id, provider, object_version, object_key, status, delivery_url")
    .eq("media_file_id", row.id);
  if (providerReadError) {
    console.error("[cloudinary-upload] replace provider lookup failed");
    await deleteNewRemote(facts);
    return { status: 500, body: { success: false, error: SAVE_FAILED } };
  }
  const oldProviders = (existingProviders || []) as ReplaceProviderRow[];
  const nextVersion = nextObjectVersion(row.current_object_version, oldProviders.map((provider) => provider.object_version));
  const oldUrls = scheduledMatchUrls(row.file_path, oldProviders.map((provider) => provider.delivery_url));

  const { error: insertError } = await db.from("media_file_providers").insert(buildReplacementProviderRows(row.id, nextVersion, facts));
  if (insertError) {
    console.error("[cloudinary-upload] replace provider insert failed");
    await deleteNewRemote(facts);
    return { status: 500, body: { success: false, error: SAVE_FAILED } };
  }

  const usedAt = new Date().toISOString();
  let update = db.from("media_files").update({
    file_path: facts.primaryUrl,
    file_size: facts.bytes,
    mime_type: facts.mimeType,
    file_type: facts.storedFileType,
    storage_bucket: facts.storageBucket,
    cloudinary_public_id: facts.cloudinaryPublicId,
    metadata: mergeReplaceMetadata(row.metadata, {
      width: facts.width,
      height: facts.height,
      format: facts.format,
      duration: facts.duration,
      kind: facts.kind,
    }),
    current_object_version: nextVersion,
    last_used_at: usedAt,
    expires_at: null,
    retention_state: null,
    retention_claimed_at: null,
  }).eq("id", row.id).eq("user_id", facts.userId);
  update = row.current_object_version == null
    ? update.is("current_object_version", null)
    : update.eq("current_object_version", row.current_object_version);
  const { data: updated, error: updateError } = await update
    .or("retention_state.is.null,retention_state.neq.deleting")
    .select("id");
  if (updateError) {
    console.error("[cloudinary-upload] replace file update failed");
    await deleteNewRemote(facts);
    await markVersionDeleted(db, row.id, nextVersion, "replace save failed");
    return { status: 500, body: { success: false, error: SAVE_FAILED } };
  }
  if (!updated || updated.length === 0) {
    await deleteNewRemote(facts);
    await markVersionDeleted(db, row.id, nextVersion, "replace lost race");
    return { status: 409, body: { success: false, error: LOST_RACE } };
  }

  const responseErrors = [...facts.errors];
  let scheduledMessagesUpdated = 0;
  if (oldUrls.length > 0) {
    const { data: scheduled, error: scheduledError } = await db.from("whatsapp_scheduled_messages")
      .update({ media_url: facts.primaryUrl })
      .eq("user_id", facts.userId)
      .eq("status", "pending")
      .in("media_url", oldUrls)
      .select("id");
    if (scheduledError) {
      console.error("[cloudinary-upload] replace scheduled rewrite failed");
      responseErrors.push(SCHEDULED_REWRITE_FAILED);
      try {
        await logToDatabase(db, {
          level: "error",
          category: "system",
          source: "cloudinary-upload",
          message: "Replace updated the file but could not rewrite pending scheduled messages",
          user_id: facts.userId,
          metadata: { mediaFileId: row.id, reason: "scheduled_rewrite_failed" },
        });
      } catch {
        console.error("[cloudinary-upload] replace scheduled log failed");
      }
    } else {
      scheduledMessagesUpdated = scheduled?.length ?? 0;
    }
  }

  let retired = 0;
  const decisions = planProviderRetirement(oldProviders, nextVersion, row.file_path);
  for (const decision of decisions) {
    if (decision.action !== "retire") continue;
    const provider = oldProviders.find((candidate) => candidate.id === decision.id);
    if (!provider) continue;
    if (await retireOneProvider(db, row, provider)) retired += 1;
  }

  if (oldProviders.length === 0 && row.storage_bucket === "media" && row.file_path) {
    try { await db.storage.from("media").remove([row.file_path]); } catch { console.error("[cloudinary-upload] replace legacy storage remove failed"); }
  }

  return {
    status: 200,
    body: {
      success: true,
      mediaFileId: row.id,
      url: facts.primaryUrl,
      replaced: true,
      storedIn: facts.storedIn,
      scheduledMessagesUpdated,
      retired,
      errors: responseErrors.length ? responseErrors : undefined,
    },
  };
}
