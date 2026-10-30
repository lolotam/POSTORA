/**
 * The `prediction_id` a caller gets back while an AtlasCloud job is still running.
 *
 * It is not the provider's id: it is a signed envelope that remembers what the follow-up
 * request needs (the provider id, the staged input to remove, what the response reports) and
 * is bound to the user it was issued to, so one user cannot redeem another's job. No table:
 * the server's own secret is the only state.
 *
 *   token = base64url(JSON payload) "." base64url(HMAC-SHA256(secret, context + userId + "." + payload))
 */

export interface JobTokenPayload {
  /** AtlasCloud prediction id. */
  prediction: string;
  /** Openinary path of the staged input still to remove, if any. */
  staged: string | null;
  operation: "upscale" | "background_removal";
  /** Where the finished result is stored. */
  area: "upscaled" | "processed";
  issuedAt: number;
  /** Small values the final response reports (target resolution, scale, ...). */
  meta: Record<string, string | number | null>;
}

/** The longest string a token carries; anything longer is reported as null inside the token. */
export const MAX_TOKEN_STRING_CHARS = 512;

/**
 * `meta` as it travels inside the token, which is returned to the browser and sent back on every
 * follow-up: a long value (a signed image URL) is dropped to null there. The response of the
 * request that produced the meta still carries it in full.
 */
export function tokenMeta(meta: JobTokenPayload["meta"]): JobTokenPayload["meta"] {
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => [key, typeof value === "string" && value.length > MAX_TOKEN_STRING_CHARS ? null : value]),
  );
}

export type VerifiedToken =
  | { ok: true; payload: JobTokenPayload }
  /** An expired token is still genuine, so its payload is returned for cleanup. */
  | { ok: false; reason: "expired"; payload: JobTokenPayload }
  | { ok: false; reason: "malformed" | "forged" };

const CONTEXT = "postora-ai-image-job-v1:";
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function signedText(userId: string, encodedPayload: string): Uint8Array {
  return encoder.encode(`${CONTEXT}${userId}.${encodedPayload}`);
}

export async function signJobToken(secret: string, userId: string, payload: JobTokenPayload): Promise<string> {
  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), signedText(userId, encodedPayload)));
  return `${encodedPayload}.${toBase64Url(mac)}`;
}

export async function verifyJobToken(input: {
  secret: string;
  userId: string;
  token: string;
  maxAgeMs: number;
  now?: number;
}): Promise<VerifiedToken> {
  const [encodedPayload, encodedMac, extra] = input.token.split(".");
  if (!encodedPayload || !encodedMac || extra !== undefined) return { ok: false, reason: "malformed" };
  const mac = fromBase64Url(encodedMac);
  if (!mac) return { ok: false, reason: "malformed" };

  // crypto.subtle.verify compares in constant time.
  const genuine = await crypto.subtle.verify("HMAC", await hmacKey(input.secret, "verify"), mac, signedText(input.userId, encodedPayload));
  if (!genuine) return { ok: false, reason: "forged" };

  const bytes = fromBase64Url(encodedPayload);
  let payload: JobTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload?.prediction !== "string" || typeof payload.issuedAt !== "number") return { ok: false, reason: "malformed" };
  if ((input.now ?? Date.now()) - payload.issuedAt > input.maxAgeMs) return { ok: false, reason: "expired", payload };
  return { ok: true, payload };
}
