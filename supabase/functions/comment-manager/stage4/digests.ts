// Intent and logical digests for Stage 4.
//
// These are HMAC-SHA-256 over a canonical string, computed with the SQL-held
// keys returned by `youtube_comment_digest_keys()`. The handler NEVER logs a
// key and NEVER returns one. A key is used only in this module.
//
// Text normalisation is fixed and versioned with the key:
//   - Unicode NFC
//   - CRLF and CR to LF
//   - surrounding whitespace trimmed
//
// The canonical parent is empty for a top-level comment and the TOP-LEVEL
// comment id for every reply, including a reply aimed at a reply.

export const TEXT_NORMALISATION_VERSION = 1;

export function normaliseText(raw: string): string {
  return (raw ?? "").normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

async function hmacHex(keyBase64: string, message: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface DigestKeys {
  activeVersion: number;
  keys: Array<{ version: number; key: string }>;
}

export async function computeIntentDigest(
  keys: DigestKeys,
  parts: {
    action: string;
    accountId: string;
    bindingGeneration: number;
    videoId: string;
    targetIds: string[];
    moderationStatus: string | null;
    banAuthor: boolean;
    text: string;
  },
): Promise<{ digest: string; version: number }> {
  const canonical = [
    "intent",
    TEXT_NORMALISATION_VERSION,
    parts.action,
    parts.accountId,
    String(parts.bindingGeneration),
    parts.videoId,
    parts.targetIds.join(","),
    parts.moderationStatus ?? "",
    parts.banAuthor ? "1" : "0",
    normaliseText(parts.text),
  ].join("\u0000");
  return { digest: await hmacHex(keys.keys.find((k) => k.version === keys.activeVersion)!.key, canonical), version: keys.activeVersion };
}

export async function computeLogicalDigests(
  keys: DigestKeys,
  parts: {
    channelId: string;
    videoId: string;
    canonicalParent: string;
    text: string;
  },
): Promise<Record<string, string>> {
  const normalised = normaliseText(parts.text);
  const canonical = [
    "logical",
    TEXT_NORMALISATION_VERSION,
    parts.channelId,
    parts.videoId,
    parts.canonicalParent,
    normalised,
  ].join("\u0000");
  const out: Record<string, string> = {};
  for (const k of keys.keys) {
    out[String(k.version)] = await hmacHex(k.key, canonical);
  }
  return out;
}
