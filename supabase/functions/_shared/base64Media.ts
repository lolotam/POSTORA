// Turning whatever a client called "base64" into the one shape the uploader accepts.
//
// `uploadFileFromBase64` requires a full data URL. The MCP tool's own description promises
// "data URL or raw base64", and an LLM client handed a file has no reason to know the
// difference -- so raw payloads arrived and were rejected with a format error that read
// like the image was corrupt. Sniffing the type is what lets the documented contract be
// true instead of aspirational.

/** Longest magic-number prefix we inspect, so callers know how little needs decoding. */
const SNIFF_BYTES = 12;

interface Signature {
  mimeType: string;
  /** Bytes that must match, or null for a byte at that offset we do not constrain. */
  magic: (number | null)[];
  offset?: number;
}

// Only the types Cloudinary accepts for a social post. An unrecognised payload is refused
// rather than guessed: uploading an unknown blob as image/jpeg produces a broken post
// rather than an error the caller can act on.
const SIGNATURES: Signature[] = [
  { mimeType: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mimeType: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  // RIFF....WEBP -- the four size bytes in between are the payload length, not a constant.
  {
    mimeType: "image/webp",
    magic: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  },
  { mimeType: "video/webm", magic: [0x1a, 0x45, 0xdf, 0xa3] },
  // MP4 and MOV both carry "ftyp" at offset 4; the brand that follows distinguishes them
  // and Cloudinary does not need us to.
  { mimeType: "video/mp4", magic: [0x66, 0x74, 0x79, 0x70], offset: 4 },
];

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

function decodePrefix(payload: string): Uint8Array | null {
  // 4 base64 chars carry 3 bytes, so this is the smallest slice covering SNIFF_BYTES.
  const head = payload.slice(0, Math.ceil(SNIFF_BYTES / 3) * 4);
  try {
    const binary = atob(head);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function matches(bytes: Uint8Array, signature: Signature): boolean {
  const offset = signature.offset ?? 0;
  if (bytes.length < offset + signature.magic.length) return false;
  return signature.magic.every((byte, i) => byte === null || bytes[offset + i] === byte);
}

/** The media type a raw base64 payload actually is, or null when we do not recognise it. */
export function sniffBase64MimeType(payload: string): string | null {
  const bytes = decodePrefix(payload);
  if (!bytes) return null;
  return SIGNATURES.find((signature) => matches(bytes, signature))?.mimeType ?? null;
}

export type Base64MediaFailure = "empty" | "unrecognised_type";

export type Base64MediaOutcome =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: Base64MediaFailure };

/**
 * Normalises one client-supplied media payload to a data URL.
 *
 * A payload that is already a data URL is returned untouched -- including its declared
 * type, because the client knows its own file better than a magic number does for the
 * formats that share one. A raw payload is sniffed, and `mimeHint` is consulted only when
 * sniffing fails, since a hint is what the caller *said* rather than what the bytes are.
 *
 * Boundary cases, enumerated before the code: already a data URL; raw base64 of a known
 * type; raw base64 of an unknown type with a usable hint; the same with no hint; empty or
 * whitespace-only input; input that is not valid base64 at all.
 */
export function normalizeBase64Media(
  payload: string | null | undefined,
  mimeHint?: string | null,
): Base64MediaOutcome {
  const trimmed = (payload ?? "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  if (DATA_URL.test(trimmed)) return { ok: true, dataUrl: trimmed };

  // A client that sent a data: prefix we could not parse meant to send a data URL; do not
  // silently reinterpret the whole string as a base64 payload.
  if (trimmed.startsWith("data:")) return { ok: false, reason: "unrecognised_type" };

  const stripped = trimmed.replace(/\s+/g, "");
  const mimeType = sniffBase64MimeType(stripped) ?? (mimeHint?.trim() || null);
  if (!mimeType) return { ok: false, reason: "unrecognised_type" };

  return { ok: true, dataUrl: `data:${mimeType};base64,${stripped}` };
}

/** What to tell the caller, in their terms, when normalisation refuses a payload. */
export function describeBase64Failure(reason: Base64MediaFailure): string {
  return reason === "empty"
    ? "Media payload was empty."
    : "Could not determine the media type. Send a data URL (data:image/png;base64,...) " +
      "or pass mime_type alongside the raw base64.";
}
