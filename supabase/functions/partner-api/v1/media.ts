// POST /v1/media and GET /v1/media/{id} (deliverables 4.3 and part of 4.4).
//
// The controls these routes enforce are not invented here — they are the D10
// control matrix, filled in at
// docs/decisions/2026-09-01-d10-media-control-matrix.md, and D10 makes reuse
// of the existing pipeline CONDITIONAL on that document existing first. The
// numbers live in _shared/partnerMediaSniff.ts so there is one place to read
// them and one place a test can compare against the document.
//
// GET /v1/media/{id}/download is deliberately NOT here. It is the endpoint
// that creates a partner-facing URL TTL contract, and it is not needed to send
// a message — the only URL this phase mints goes to Meta and never to a
// partner. Deferring it keeps the phase's exposure to one consumer whose
// behaviour we control.

import { claimIdempotency, completeIdempotency, hashRequest } from "../../_shared/partnerApiIdempotency.ts";
import {
  describePartnerMediaRejection,
  MAX_BYTES_ANY_KIND,
  validatePartnerMedia,
} from "../../_shared/partnerMediaSniff.ts";
import { loadPartnerMedia, storePartnerMedia } from "../../_shared/partnerMediaStore.ts";
import { decodeId, encodeId } from "./ids.ts";
import { v1ErrorResponse } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";
import type { V1AuthedContext } from "./authenticated.ts";

/** The published shape of an uploaded file. No URL: the partner never receives
 *  one in this phase (see the header), and a field that exists only to be null
 *  is worse than one added later. */
function present(stored: {
  id: string;
  mimeType: string;
  kind: string;
  byteLength: number;
  createdAt: string | null;
}): Record<string, unknown> {
  return {
    id: encodeId("media", stored.id),
    mime_type: stored.mimeType,
    kind: stored.kind,
    size_bytes: stored.byteLength,
    created_at: stored.createdAt,
  };
}

/** SHA-256 of the bytes, so the idempotency hash covers WHAT was uploaded.
 *  Hashing only the filename would let one key replay a different file. */
async function digestOf(bytes: Uint8Array): Promise<string> {
  // `.slice()` rather than the view: SubtleCrypto wants a BufferSource backed
  // by an ArrayBuffer, and a Uint8Array may be backed by a SharedArrayBuffer.
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface UploadPayload {
  bytes: Uint8Array;
  filename: string | null;
  /** What the CLIENT said the type is. Compared against the bytes, never
   *  trusted in place of them. */
  declaredMime: string | null;
}

/**
 * Read the upload out of either shape a partner might send.
 *
 * multipart is what a browser or curl produces; JSON base64 is what an
 * automation platform produces. Both end at the same validator, so neither
 * shape is a way around the controls.
 */
async function readUpload(
  req: Request,
): Promise<{ ok: true; payload: UploadPayload } | { ok: false; message: string }> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return { ok: false, message: "Could not parse the multipart body" };
    const file = form.get("file");
    if (!(file instanceof File)) return { ok: false, message: "A `file` part is required" };
    return {
      ok: true,
      payload: {
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name || null,
        // A browser's part header. Data, not authority.
        declaredMime: file.type || null,
      },
    };
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return { ok: false, message: "Send multipart/form-data with a `file` part, or JSON with `data`" };
  }
  const payload = body as Record<string, unknown>;
  const data = typeof payload.data === "string" ? payload.data.replace(/\s+/g, "") : "";
  if (!data) return { ok: false, message: "`data` (base64) is required" };

  // A data URL is accepted for convenience; its declared type is taken as a
  // CLAIM and checked against the bytes like any other. This is the one place
  // where the partner path deliberately differs from normalizeBase64Media,
  // which trusts a data URL's declared type — see partnerMediaSniff.ts.
  const asDataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(data);
  const base64 = asDataUrl ? asDataUrl[2]! : data;
  const declaredMime = asDataUrl
    ? asDataUrl[1]!
    : (typeof payload.mime_type === "string" ? payload.mime_type : null);

  let bytes: Uint8Array;
  try {
    const binary = atob(base64);
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return { ok: false, message: "`data` is not valid base64" };
  }

  return {
    ok: true,
    payload: {
      bytes,
      filename: typeof payload.filename === "string" ? payload.filename : null,
      declaredMime,
    },
  };
}

export async function postMedia(
  req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  // Sends and uploads both cost something durable, so the key is required —
  // the same rule POST /v1/messages applies. Checked before the body is read:
  // a request that cannot proceed should not cost a megabyte of transfer.
  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) return v1ErrorResponse("missing_idempotency_key", requestId);

  // Cheap refusal first, on the CLIENT'S claim about the size. It is only a
  // claim — the real byte length is checked after decoding — but refusing an
  // obviously impossible upload before reading it is the difference between a
  // 413 and an edge worker that dies holding 100 MB.
  const declaredLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES_ANY_KIND * 2) {
    return v1ErrorResponse("payload_too_large", requestId);
  }

  const upload = await readUpload(req);
  if (!upload.ok) {
    return v1ErrorResponse("invalid_request", requestId, { message: upload.message });
  }

  // THE gate. Sniffed always; a declared type that disagrees with the bytes is
  // refused rather than corrected, which is Phase 4's exit criterion.
  const validated = validatePartnerMedia(upload.payload.bytes, upload.payload.declaredMime);
  if (!validated.ok) {
    const message = describePartnerMediaRejection(validated.reason, validated.kind);
    if (validated.reason === "too_large") {
      return v1ErrorResponse("payload_too_large", requestId, { message });
    }
    // A type outside the allowlist is a permanent fact about the file, not a
    // permission problem and not an outage — the same verdict a misspelled
    // message type gets.
    if (validated.reason === "unrecognised_type") {
      return v1ErrorResponse("unsupported_capability", requestId, { message });
    }
    return v1ErrorResponse("invalid_request", requestId, { message });
  }

  // The hash covers the BYTES, not just the metadata: two different files sent
  // under one key must not look like a replay of each other.
  const claim = await claimIdempotency(
    admin,
    record.id,
    idempotencyKey,
    await hashRequest({
      action: "upload_media",
      digest: await digestOf(upload.payload.bytes),
      filename: upload.payload.filename,
    }),
  );
  if (claim.outcome === "conflict") return v1ErrorResponse("idempotency_conflict", requestId);
  if (claim.outcome === "in_progress") return v1ErrorResponse("idempotency_in_progress", requestId);
  if (claim.outcome === "indeterminate") {
    return v1ErrorResponse("idempotency_indeterminate", requestId);
  }
  if (claim.outcome === "replay") {
    return v1JsonResponse(claim.body, requestId, claim.httpStatus);
  }

  const stored = await storePartnerMedia({
    admin,
    workspaceId: record.workspaceId,
    keyId: record.id,
    bytes: upload.payload.bytes,
    media: validated.media,
    filename: upload.payload.filename,
  });
  if (!stored.ok) {
    console.error(`[partner-api] media store failed (request ${requestId}): ${stored.reason}`);
    return v1ErrorResponse("internal_error", requestId);
  }

  const body = present(stored.stored);
  // Settled so a retry with the same key replays this id rather than storing
  // the same bytes a second time. An upload reaches no customer, so an
  // unsettled claim is wasted storage rather than a duplicate message — but
  // wasted storage is still the partner's bill.
  await completeIdempotency(admin, record.id, idempotencyKey, claim.attemptToken, 201, body);
  return v1JsonResponse(body, requestId, 201);
}

export async function getMedia(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const mediaId = decodeId("media", params.id ?? "");
  // Malformed answers exactly as unknown does — see ids.ts.
  if (mediaId === null) return v1ErrorResponse("resource_not_found", requestId);

  // Workspace-scoped in the LOOKUP. Every media_files row that predates this
  // phase has workspace_id NULL and therefore matches nothing, so the app's
  // existing uploads are unreachable from any partner key without a policy
  // having to say so.
  const stored = await loadPartnerMedia(admin, record.workspaceId, mediaId);
  if (!stored) return v1ErrorResponse("resource_not_found", requestId);

  return v1JsonResponse(present(stored), requestId);
}
