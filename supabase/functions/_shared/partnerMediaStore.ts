// Where partner media lives, and how the bytes reach Meta (deliverable 4.2).
//
// WHY NOT THE EXISTING UPLOADER
// -----------------------------
// `uploadFileFromBase64` in n8n-api delegates to `uploadToCloudinary`, and
// D10's first sentence forbids exactly what that produces: "partners never
// receive provider credentials or raw provider URLs; downloads are served
// through a Postora-controlled, time-bounded URL." A Cloudinary URL is a
// provider URL and it is unbounded in time.
//
// D10 says to reuse the existing PIPELINE, and this does — `media_files` stays
// the record, and the app's own sniffing modules are the precedent for
// partnerMediaSniff.ts. What it does not reuse is the uploader, because that
// one writes somewhere the contract cannot describe.

import { isMediaQuotaMessage, mediaQuotaHumanMessage, mediaQuotaBody, mediaQuotaPreflight } from "./mediaQuotaError.ts";
import { signedUrlTtlSeconds } from "./partnerMediaSniff.ts";
import type { PartnerMedia } from "./partnerMediaSniff.ts";

/** Private, service-role-only, created by migration 20260901190000. Separate
 *  from the app's `media` bucket, whose migration says `public = true` while
 *  production says otherwise — see the decision record. */
export const PARTNER_MEDIA_BUCKET = "partner-media";

const EXTENSION_OF: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "application/pdf": "pdf",
};

export interface StoredPartnerMedia {
  id: string;
  filePath: string;
  mimeType: string;
  kind: string;
  byteLength: number;
  createdAt: string | null;
  /** 9.3: the scan-state substrate. 'available' | 'pending' | 'rejected',
   *  per media_files_scan_state_chk. Normalized to 'available' when a
   *  projection predates the column — see loadPartnerMedia. */
  scanState: string;
}

export interface StorePartnerMediaInput {
  // deno-lint-ignore no-explicit-any
  admin: any;
  workspaceId: string;
  keyId: string;
  bytes: Uint8Array;
  media: PartnerMedia;
  /** The client's filename, kept for the WhatsApp document `filename` field.
   *  Never used to build the storage path — see below. */
  filename?: string | null;
}

export type StoreFailure = "no_workspace_owner" | "storage_failed" | "record_failed" | "media_quota";

/**
 * Write the bytes, then the row.
 *
 * That ORDER is the safe one, and the reverse is not. An object with no row is
 * invisible: nothing references it and nothing can reach it, so the worst case
 * is bytes nobody will ever read. A row with no object is a `media_id` a
 * partner holds and can put in a send, which then fails at the provider fetch
 * — a broken id that looks like a working one. Cheap garbage beats a lying
 * identifier.
 *
 * If the row insert fails the object is deleted, so the usual case leaves
 * nothing behind either.
 */
/**
 * The daily-limit refusal for this workspace's owner, or null to proceed. Run
 * before the idempotency claim so a refused upload never holds the key; a failed
 * read proceeds and the media_files INSERT trigger remains the backstop.
 */
export async function partnerMediaQuotaRefusal(
  // deno-lint-ignore no-explicit-any
  admin: any,
  workspaceId: string,
): Promise<string | null> {
  try {
    const { data: workspace, error } = await admin
      .from("workspaces")
      .select("owner_id")
      .eq("id", workspaceId)
      .maybeSingle();
    if (error || !workspace?.owner_id) return null;
    const blocked = await mediaQuotaPreflight(admin, workspace.owner_id);
    return blocked ? mediaQuotaBody(blocked.limit).error : null;
  } catch {
    return null;
  }
}

export async function storePartnerMedia(
  input: StorePartnerMediaInput,
): Promise<
  | { ok: true; stored: StoredPartnerMedia }
  | { ok: false; reason: Exclude<StoreFailure, "media_quota"> }
  | { ok: false; reason: "media_quota"; message: string }
> {
  const { admin, workspaceId, keyId, bytes, media } = input;

  // media_files.user_id is NOT NULL and predates workspaces, so a partner
  // upload still needs a user. The workspace owner is the defensible choice:
  // it keeps the row valid for the app's own user-scoped queries without
  // inventing a synthetic account. Ownership for PARTNER purposes is
  // workspace_id, which is what every partner read filters on.
  const { data: workspace, error: workspaceError } = await admin
    .from("workspaces")
    .select("owner_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (workspaceError || !workspace?.owner_id) return { ok: false, reason: "no_workspace_owner" };

  // The path is built from a fresh UUID and the SNIFFED type's extension —
  // never from the client's filename. A filename is attacker-controlled text,
  // and letting it reach a storage path is how "../" and a doubled extension
  // get to decide where bytes land and what they are served as.
  const objectName = `${crypto.randomUUID()}.${EXTENSION_OF[media.mimeType] ?? "bin"}`;
  const filePath = `${workspaceId}/${objectName}`;

  const { error: uploadError } = await admin.storage
    .from(PARTNER_MEDIA_BUCKET)
    .upload(filePath, bytes, { contentType: media.mimeType, upsert: false });
  if (uploadError) {
    console.error("[partner-api] media upload failed:", uploadError.message);
    return { ok: false, reason: "storage_failed" };
  }

  const { data: row, error: insertError } = await admin
    .from("media_files")
    .insert({
      user_id: workspace.owner_id,
      workspace_id: workspaceId,
      created_by_key_id: keyId,
      file_path: filePath,
      storage_bucket: PARTNER_MEDIA_BUCKET,
      file_type: media.kind,
      file_size: media.byteLength,
      mime_type: media.mimeType,
      metadata: {
        source: "partner_api",
        // The client's own name, kept only so a document send can carry it.
        // Stored as data, never interpolated into a path.
        original_filename: input.filename ?? null,
      },
    })
    .select("id, file_path, mime_type, file_type, file_size, created_at, scan_state")
    .maybeSingle();

  if (insertError || !row) {
    // Compensate: without this the object is unreferenced garbage that still
    // counts against storage forever. A quota refusal inserts no row either.
    await admin.storage.from(PARTNER_MEDIA_BUCKET).remove([filePath]);
    if (isMediaQuotaMessage(insertError?.message)) {
      return { ok: false, reason: "media_quota", message: mediaQuotaHumanMessage(insertError?.message) };
    }
    console.error("[partner-api] media record failed:", insertError?.message);
    return { ok: false, reason: "record_failed" };
  }

  return {
    ok: true,
    stored: {
      id: row.id,
      filePath: row.file_path,
      mimeType: row.mime_type,
      kind: row.file_type,
      byteLength: row.file_size ?? media.byteLength,
      createdAt: row.created_at ?? null,
      // The insert does not name scan_state on purpose: the column's DEFAULT
      // 'available' IS the D10 decision (uploads land available; there is no
      // scanner). The ?? below only absorbs a projection from a reader that
      // predates the column — in production the value is always present.
      scanState: row.scan_state ?? "available",
    },
  };
}

/**
 * Load one media row, scoped to a workspace.
 *
 * The workspace filter is part of the LOOKUP, not a check applied to the row
 * that came back. A row fetched first and rejected second is one refactor away
 * from being returned by mistake; a row that was never selected cannot be. The
 * same rule the /v1 read surface follows.
 *
 * Rows with `workspace_id IS NULL` — every media file the app uploaded before
 * this phase — match no workspace, so they are unreachable here without a
 * single policy saying so.
 */
export type LoadMediaResult =
  | { outcome: "found"; media: StoredPartnerMedia }
  | { outcome: "missing" }
  /** The read itself failed -- a timeout, a connection drop, a schema problem. */
  | { outcome: "error" };

export async function loadPartnerMedia(
  // deno-lint-ignore no-explicit-any
  admin: any,
  workspaceId: string,
  mediaId: string,
): Promise<LoadMediaResult> {
  const { data, error } = await admin
    .from("media_files")
    .select("id, file_path, mime_type, file_type, file_size, created_at, storage_bucket, metadata, scan_state")
    .eq("id", mediaId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  // An error is NOT an absence, and collapsing the two is how an outage gets
  // reported as a permanent fact. `resource_not_found` is non-retryable: a
  // partner told that during a database blip would stop retrying a file that
  // exists and is theirs. They are separated here so the caller can answer
  // `internal_error` (retryable) for one and `resource_not_found` for the
  // other.
  if (error) {
    console.error("[partner-api] media lookup failed:", error.message);
    return { outcome: "error" };
  }
  if (!data) return { outcome: "missing" };

  return {
    outcome: "found",
    media: {
      id: data.id,
      filePath: data.file_path,
      mimeType: data.mime_type,
      kind: data.file_type,
      byteLength: data.file_size ?? 0,
      createdAt: data.created_at ?? null,
      // The column is NOT NULL DEFAULT 'available' (20260902160000), so a
      // real row always carries one of the three states and 'available' is
      // what absence-of-projection means. The ?? is for readers and test
      // stubs whose select list predates the column — not a guess about the
      // row, the DB default restated.
      scanState: data.scan_state ?? "available",
    },
  };
}

/** The outcome of the 9.3 sendability rule. The codes and their
 *  status/retryable verdicts live in partner-api/v1/errors.ts — this type
 *  names only which refusal applies, so the publishing route (when it lands)
 *  maps it through its own envelope with the same words. */
export type MediaSendability =
  | { ok: true }
  | { ok: false; code: "media_pending" | "media_rejected"; message: string };

/**
 * Can this stored file be sent? THE one shared rule, so that every send
 * path — POST /v1/messages today, the publishing seam when Phase 8 lands —
 * refuses the same rows for the same reasons instead of each growing its
 * own copy of the state machine.
 *
 * This is the substrate D10's "Malware handling" row named, without building
 * the scanner: `pending` → `media_pending` (409, retryable — the state is
 * expected to change on its own, so the partner's move is to retry the SAME
 * request shortly, not re-upload); `rejected` → `media_rejected` (422,
 * permanent — a fact about these bytes). Everything else — which, given
 * media_files_scan_state_chk, can only be `available` — sends, exactly as it
 * did before the column existed.
 */
export function mediaSendability(stored: { scanState?: string | null }): MediaSendability {
  switch (stored.scanState) {
    case "pending":
      return {
        ok: false,
        code: "media_pending",
        message: "The media file is pending a security scan; retry the same request shortly",
      };
    case "rejected":
      return {
        ok: false,
        code: "media_rejected",
        message: "The media file was rejected and cannot be sent",
      };
    default:
      return { ok: true };
  }
}

/**
 * A short-lived URL for Meta to fetch the bytes from.
 *
 * This URL is NOT part of the partner-facing contract and must never reach a
 * partner, a response body, a log line, or the dispatch intent's
 * `request_summary`. It is a live capability: anyone holding it can read the
 * object until it expires, which is why it expires in
 * `signedUrlTtlSeconds` and why `GET /v1/media/{id}/download` — the endpoint
 * that WOULD hand a partner a URL — is deliberately not part of this phase.
 */
export async function signPartnerMediaUrl(
  // deno-lint-ignore no-explicit-any
  admin: any,
  filePath: string,
): Promise<string | null> {
  const { data, error } = await admin.storage
    .from(PARTNER_MEDIA_BUCKET)
    .createSignedUrl(filePath, signedUrlTtlSeconds);
  if (error || !data?.signedUrl) {
    console.error("[partner-api] signing media url failed:", error?.message);
    return null;
  }
  return data.signedUrl;
}
