// Partner media validation — the D10 control matrix's "accepted types" and
// "max size" rows, in code (deliverable 4.2).
//
// WHY THIS IS A SECOND SNIFFER AND NOT AN EDIT TO base64Media.ts
// --------------------------------------------------------------
// `normalizeBase64Media` deliberately TRUSTS a client's declared type when the
// payload arrives as a data URL — its own comment says the client knows its
// file better than a magic number does for formats that share one. That is a
// reasonable contract for the n8n/MCP path it serves, and n8n-api depends on
// it.
//
// It is the wrong contract here. Phase 4's exit criterion is "a file whose
// extension and real content disagree is rejected", which is precisely the
// case that one trusts. Widening `base64Media.ts` to refuse would change
// behaviour for an existing caller that has no security requirement for it; a
// separate strict gate changes nothing and cannot be bypassed by the shape the
// bytes arrived in. Two callers, two contracts, one honest module each.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
// No malware scan. None exists in Postora and this phase does not invent one;
// the decision record explains what the surface gives up instead and why the
// scan-state machine collapses to a single state. If that is ever revisited,
// it arrives as a column and a refusal, not as a change to this file.

/** The nine types a partner may upload. Sniffed, never taken on trust.
 *  MUST equal the allowlist table in
 *  docs/decisions/2026-09-01-d10-media-control-matrix.md. */
export const PARTNER_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "video/mp4",
  "video/3gpp",
  "audio/mpeg",
  "audio/ogg",
  "audio/aac",
  "audio/amr",
  "application/pdf",
] as const;

export type PartnerMediaType = typeof PARTNER_MEDIA_TYPES[number];

/** WhatsApp's own message-type names. The send payload keys off these. */
export type PartnerMediaKind = "image" | "video" | "audio" | "document";

const KIND_OF: Readonly<Record<PartnerMediaType, PartnerMediaKind>> = {
  "image/jpeg": "image",
  "image/png": "image",
  "video/mp4": "video",
  "video/3gpp": "video",
  "audio/mpeg": "audio",
  "audio/ogg": "audio",
  "audio/aac": "audio",
  "audio/amr": "audio",
  "application/pdf": "document",
};

/**
 * Byte ceilings per kind.
 *
 * The first three are WhatsApp Cloud's own caps: accepting a file the provider
 * will refuse is worse than refusing it here, because the partner would spend
 * a quota unit and burn an idempotency key to learn it from Meta.
 *
 * The document limit is 25 MB where WhatsApp allows 100. Lower on purpose: the
 * bytes pass through an edge worker with a bounded memory budget, and a 100 MB
 * upload would fail as a worker death rather than as a typed refusal. A limit
 * that can be enforced beats one that can only be advertised.
 */
export const MAX_BYTES_BY_KIND: Readonly<Record<PartnerMediaKind, number>> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 25 * 1024 * 1024,
};

/** The largest of the above — what a Content-Length check can reject before a
 *  single byte of body is read. The per-kind ceiling still applies after the
 *  type is known; this only stops the obviously impossible early. */
export const MAX_BYTES_ANY_KIND = Math.max(...Object.values(MAX_BYTES_BY_KIND));

/**
 * How long the signed URL handed to Meta stays valid, in seconds.
 *
 * A matrix number, so it lives beside the other matrix numbers. D10 asks for
 * "a number" and says so twice: "temporary" without one is not a contract.
 *
 * 900s is long enough for Meta to fetch a 16 MB video over a slow hop and
 * short enough that a leaked URL is worthless by the time anyone finds it in a
 * log. It is not a partner-facing TTL -- the partner never receives this URL.
 */
export const signedUrlTtlSeconds = 900;

/** Longest prefix any signature inspects. */
const SNIFF_BYTES = 12;

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((b, i) => bytes[offset + i] === b);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

/**
 * ISO-BMFF brands we accept as video.
 *
 * An allowlist rather than "anything with ftyp", because the container is
 * shared with things that are not video: `M4A ` is audio in an MP4 box, which
 * WhatsApp treats as a different message type, and accepting it as
 * `video/mp4` would produce a send Meta rejects. An unlisted brand is
 * unrecognised, which is the safe answer.
 */
const MP4_BRANDS = ["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "mmp4", "dash", "M4V "];

/**
 * The type these bytes ACTUALLY are, or null when they are not one of the
 * nine.
 *
 * Ordering matters in exactly one place and it is not stylistic: an AAC ADTS
 * frame begins `FF F1` or `FF F9`, and `0xF1 & 0xE0 === 0xE0` satisfies the
 * MPEG frame-sync mask too. AAC is therefore tested BEFORE MP3, or every AAC
 * file would be reported as `audio/mpeg` and sent with the wrong type.
 */
export function sniffPartnerMedia(bytes: Uint8Array): PartnerMediaType | null {
  if (bytes.length === 0) return null;

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf";
  if (startsWith(bytes, ascii("OggS"))) return "audio/ogg";
  if (startsWith(bytes, ascii("#!AMR"))) return "audio/amr";

  // ISO-BMFF: "ftyp" sits at offset 4 and the brand follows it at 8.
  if (startsWith(bytes, ascii("ftyp"), 4) && bytes.length >= 12) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    // 3GPP brands are "3gp" plus a profile digit, so the prefix is the test.
    if (brand.startsWith("3gp")) return "video/3gpp";
    return MP4_BRANDS.includes(brand) ? "video/mp4" : null;
  }

  // AAC before MP3 — see the note above.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] === 0xf1 || bytes[1] === 0xf9)) {
    return "audio/aac";
  }
  if (startsWith(bytes, ascii("ID3"))) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio/mpeg";

  return null;
}

/**
 * Spelling variants that are the SAME type, normalised before comparison.
 *
 * The exit criterion is "extension and real content disagree", not "the client
 * spelled it differently". A browser that labels a real JPEG `image/jpg` has
 * not lied about anything, and rejecting it would make the gate look broken
 * rather than strict. Nothing here maps one real type onto another.
 */
const MIME_SYNONYMS: Readonly<Record<string, PartnerMediaType>> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "audio/mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/aacp": "audio/aac",
  "audio/x-aac": "audio/aac",
  "audio/3gpp": "audio/amr",
  "video/3gp": "video/3gpp",
  "application/x-pdf": "application/pdf",
};

function canonicalise(declared: string): string {
  // Drop parameters ("image/jpeg; charset=binary") and case, which are not
  // part of the type's identity.
  const bare = declared.split(";")[0]!.trim().toLowerCase();
  return MIME_SYNONYMS[bare] ?? bare;
}

export type PartnerMediaRejection =
  | "empty"
  | "unrecognised_type"
  | "declared_mismatch"
  | "too_large";

export interface PartnerMedia {
  mimeType: PartnerMediaType;
  kind: PartnerMediaKind;
  byteLength: number;
}

export type PartnerMediaOutcome =
  | { ok: true; media: PartnerMedia }
  | { ok: false; reason: PartnerMediaRejection; kind?: PartnerMediaKind };

/**
 * The one gate every partner upload passes.
 *
 * `declaredMime` is what the client SAID; the bytes are what it sent. When
 * both are present and they name different types the upload is REFUSED rather
 * than silently corrected to the sniffed value. Silently correcting would be
 * the friendlier behaviour and the wrong one: a mismatch means the client's
 * idea of the file and the file itself have diverged, and the interesting case
 * is not a typo — it is a `.pdf` that is really something else. Phase 4's exit
 * criterion names this case specifically.
 *
 * Boundary cases, enumerated before the code: empty buffer; buffer shorter
 * than the shortest signature; a real type with no declared mime; a real type
 * with a synonym spelling; a real type with a contradicting mime; an
 * unrecognised payload; a payload exactly at its kind's limit; one byte over.
 */
export function validatePartnerMedia(
  bytes: Uint8Array,
  declaredMime?: string | null,
): PartnerMediaOutcome {
  if (bytes.length === 0) return { ok: false, reason: "empty" };

  const sniffed = sniffPartnerMedia(bytes.subarray(0, SNIFF_BYTES));
  if (!sniffed) return { ok: false, reason: "unrecognised_type" };

  const declared = declaredMime ? canonicalise(declaredMime) : null;
  // A declared type outside the allowlist entirely is still a mismatch: it
  // disagrees with the bytes, which is the condition being tested.
  if (declared && declared !== sniffed) {
    return { ok: false, reason: "declared_mismatch" };
  }

  const kind = KIND_OF[sniffed];
  // Inclusive: a file exactly at the limit is within it.
  if (bytes.length > MAX_BYTES_BY_KIND[kind]) {
    return { ok: false, reason: "too_large", kind };
  }

  return { ok: true, media: { mimeType: sniffed, kind, byteLength: bytes.length } };
}

/** What to tell the partner, in their terms, when the gate refuses. */
export function describePartnerMediaRejection(
  reason: PartnerMediaRejection,
  kind?: PartnerMediaKind,
): string {
  switch (reason) {
    case "empty":
      return "The uploaded file was empty.";
    case "unrecognised_type":
      return "That file type is not supported. Accepted: " + PARTNER_MEDIA_TYPES.join(", ") + ".";
    case "declared_mismatch":
      // Names the condition without echoing either value: the declared type is
      // caller-controlled text, and the sniffed one tells a prober what the
      // allowlist recognises.
      return "The declared content type does not match the file's actual contents.";
    case "too_large":
      return kind
        ? `That file is larger than the ${MAX_BYTES_BY_KIND[kind] / (1024 * 1024)} MB limit for ${kind} media.`
        : "That file is too large.";
  }
}
