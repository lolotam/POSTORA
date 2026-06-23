/**
 * Shared OAuth state helper for Postora edge functions.
 *
 * Signs the JSON payload with HMAC-SHA256 using OAUTH_STATE_SECRET so each
 * provider edge function can reliably round-trip user-specific context
 * (profile_id, flow, return_to) without storing per-flow rows server-side.
 *
 * Payload contract:
 *   {
 *     platform: string,          // "instagram", "linkedin", ...
 *     flow?: string,             // "personal" | "organization" | "direct" | "facebook_business" | ...
 *     user_id: string,           // Supabase auth.uid
 *     profile_id?: string|null,  // social_profiles.id
 *     return_to?: string,        // safe post-redirect landing
 *     nonce: string,             // CSRF protection
 *     iat: number                // issued-at (seconds since epoch)
 *   }
 *
 * Default TTL: 10 minutes.
 */

const DEFAULT_TTL_SECONDS = 60 * 10;

export interface OAuthStatePayload {
  platform: string;
  flow?: string;
  user_id: string;
  profile_id?: string | null;
  return_to?: string;
  nonce: string;
  iat: number;
  [key: string]: unknown;
}

export interface CreateStateInput {
  platform: string;
  flow?: string;
  user_id: string;
  profile_id?: string | null;
  return_to?: string;
  extra?: Record<string, unknown>;
}

function base64UrlEncode(bytes: Uint8Array | string): string {
  const bin =
    typeof bytes === "string"
      ? bytes
      : Array.from(bytes)
          .map((b) => String.fromCharCode(b))
          .join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToString(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (base64.length % 4)) % 4;
  return atob(base64 + "=".repeat(pad));
}

async function hmacSign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return base64UrlEncode(new Uint8Array(sig));
}

function getSecret(): string {
  const s =
    Deno.env.get("OAUTH_STATE_SECRET") ??
    Deno.env.get("SUPABASE_JWT_SECRET") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!s) {
    throw new Error(
      "OAUTH_STATE_SECRET (or SUPABASE_JWT_SECRET fallback) is not configured",
    );
  }
  return s;
}

export async function createOAuthState(input: CreateStateInput): Promise<string> {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const payload: OAuthStatePayload = {
    platform: input.platform,
    flow: input.flow,
    user_id: input.user_id,
    profile_id: input.profile_id ?? null,
    return_to: input.return_to,
    nonce: base64UrlEncode(nonceBytes),
    iat: Math.floor(Date.now() / 1000),
    ...(input.extra ?? {}),
  };
  const raw = JSON.stringify(payload);
  const sig = await hmacSign(raw, getSecret());
  return `${base64UrlEncode(raw)}.${sig}`;
}

export async function verifyOAuthState(
  state: string,
  options: { ttlSeconds?: number; expectedPlatform?: string } = {},
): Promise<OAuthStatePayload> {
  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) throw new Error("Invalid state format");

  const raw = base64UrlDecodeToString(encoded);
  const expected = await hmacSign(raw, getSecret());
  if (expected !== sig) throw new Error("Invalid state signature");

  const payload = JSON.parse(raw) as OAuthStatePayload;

  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const age = Math.floor(Date.now() / 1000) - (payload.iat ?? 0);
  if (age > ttl) throw new Error("State expired");

  if (
    options.expectedPlatform &&
    payload.platform !== options.expectedPlatform
  ) {
    throw new Error("State platform mismatch");
  }

  return payload;
}
