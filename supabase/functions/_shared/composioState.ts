export interface ConnectState {
  connectionId: string;
  workspaceId: string;
  nonce: string;
  exp: number;
}

export const COMPOSIO_STATE_NONCE_BYTES = 16;

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

// Returns a view over a plain ArrayBuffer (not a SharedArrayBuffer-capable
// ArrayBufferLike) because crypto.subtle.verify's BufferSource parameter
// refuses the wider type under Deno 2.8's TypeScript lib.
function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function isConnectState(value: unknown): value is ConnectState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return typeof state.connectionId === "string" &&
    state.connectionId.length > 0 &&
    typeof state.workspaceId === "string" && state.workspaceId.length > 0 &&
    typeof state.nonce === "string" && state.nonce.length > 0 &&
    typeof state.exp === "number" && Number.isFinite(state.exp);
}

export async function signConnectState(
  state: ConnectState,
  secret: string,
): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(state)));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(secret),
      encoder.encode(payload),
    ),
  );
  return `${payload}.${base64UrlEncode(signature)}`;
}

export async function verifyConnectState(
  token: string,
  secret: string,
  now: () => number = Date.now,
): Promise<ConnectState | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const signature = base64UrlDecode(parts[1]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      signature,
      encoder.encode(parts[0]),
    );
    if (!valid) return null;
    const payload = new TextDecoder().decode(base64UrlDecode(parts[0]));
    const state: unknown = JSON.parse(payload);
    if (!isConnectState(state)) return null;
    if (state.exp <= Math.floor(now() / 1_000)) return null;
    return state;
  } catch {
    return null;
  }
}

export function newNonce(): string {
  const bytes = crypto.getRandomValues(
    new Uint8Array(COMPOSIO_STATE_NONCE_BYTES),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
