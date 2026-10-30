/**
 * Verifies a Svix-signed webhook (Resend delivers its webhooks through Svix).
 *
 * The signed content is `${svix-id}.${svix-timestamp}.${raw body}`, signed with HMAC-SHA256
 * under the base64 secret after its `whsec_` prefix. The `svix-signature` header lists one or
 * more space-separated `v1,<base64>` signatures; any one matching is enough.
 *
 * Nothing is accepted without a matching signature. The timestamp is checked first, so a
 * replayed delivery is refused before any signing work, and the comparison is
 * crypto.subtle.verify, which is constant time.
 */

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
}

export type SvixVerdict =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "bad_timestamp" | "stale_timestamp" | "bad_secret" | "no_match" };

/** The decoded bytes as an ArrayBuffer (a BufferSource for WebCrypto), or null when not base64. */
function fromBase64(text: string): ArrayBuffer | null {
  try {
    const binary = atob(text);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return buffer;
  } catch {
    return null;
  }
}

export async function verifySvixSignature(
  payload: string,
  headers: SvixHeaders,
  secret: string,
  nowMs: number = Date.now(),
): Promise<SvixVerdict> {
  const { svixId, svixTimestamp, svixSignature } = headers;
  if (!svixId || !svixTimestamp || !svixSignature) return { ok: false, reason: "missing_headers" };

  if (!/^\d+$/.test(svixTimestamp)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(nowMs / 1000 - Number(svixTimestamp)) > SVIX_TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const secretBytes = fromBase64(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  if (!secretBytes || secretBytes.byteLength === 0) return { ok: false, reason: "bad_secret" };

  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${svixId}.${svixTimestamp}.${payload}`);

  for (const entry of svixSignature.split(" ")) {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) continue;
    const candidate = fromBase64(value);
    if (candidate && await crypto.subtle.verify("HMAC", key, candidate, signed)) return { ok: true };
  }
  return { ok: false, reason: "no_match" };
}
