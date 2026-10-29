/**
 * The facts `start` decided, carried to `complete` inside an HMAC-signed token.
 *
 * The browser holds the token between the two calls and uploads in between, so
 * nothing in it may be trusted unless the signature checks: the size cap, the
 * object names and the providers all come from here, never from the browser.
 */

import type { MediaKind, StoredFileType } from "../_shared/mediaTypes.ts";

export const SESSION_TTL_SECONDS = 2 * 60 * 60;

export interface DirectUploadSession {
  v: 1;
  uid: string;
  exp: number;
  /** postora_<date>_<userId>_<seq>: the object's base name on every provider. */
  publicId: string;
  /** Cloudinary folder, e.g. media/<user>/<date>. */
  folder: string;
  uploadDate: string;
  ext: string;
  mime: string;
  kind: MediaKind;
  storedFileType: StoredFileType;
  size: number;
  originalFilename: string;
  providers: string[];
  required: string[];
  readPreference: string;
  /** Openinary folder and file name the presigned upload must land on. */
  openinary?: { folder: string; fileName: string };
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function hmacKey(secret: string): Promise<CryptoKey> {
  // Domain-separated so a token minted here cannot be replayed as any other signed value.
  const material = new TextEncoder().encode(`media-direct-upload:v1:${secret}`);
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(session: DirectUploadSession, secret: string): Promise<string> {
  const body = base64Url(new TextEncoder().encode(JSON.stringify(session)));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${base64Url(new Uint8Array(mac))}`;
}

export type SessionCheck =
  | { ok: true; session: DirectUploadSession }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_user" };

export async function verifySession(
  token: string,
  secret: string,
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<SessionCheck> {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return { ok: false, reason: "malformed" };
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(mac);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, new TextEncoder().encode(body));
  if (!valid) return { ok: false, reason: "bad_signature" };
  let session: DirectUploadSession;
  try {
    session = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (session?.v !== 1) return { ok: false, reason: "malformed" };
  if (session.exp < nowSeconds) return { ok: false, reason: "expired" };
  if (session.uid !== userId) return { ok: false, reason: "wrong_user" };
  return { ok: true, session };
}
