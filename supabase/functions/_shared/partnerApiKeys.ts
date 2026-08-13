// Partner API key generation and authentication.
//
// Keys are shown to the operator exactly once and stored only as a SHA-256
// hex digest, following the mcp_oauth_tokens precedent — a database leak
// yields no usable credentials.

const KEY_PREFIX = "pk_live_";
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type PartnerScope =
  | "whatsapp:template.send"
  | "whatsapp:templates.read"
  | "whatsapp:webhooks.manage";

export interface PartnerKeyRecord {
  id: string;
  workspaceId: string;
  socialAccountId: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  monthlyQuota: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export class PartnerAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PartnerAuthError";
  }
}

/** Async because SubtleCrypto's digest is the only hash available in the
 *  edge runtime — node:crypto is not reliably present. */
export async function generatePartnerKey(): Promise<{
  key: string;
  prefix: string;
  hash: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const b of bytes) body += BASE62[b % BASE62.length];
  const key = KEY_PREFIX + body;
  return { key, prefix: key.slice(0, 12), hash: await hashPartnerKey(key) };
}

export async function hashPartnerKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function authenticatePartnerKey(
  // deno-lint-ignore no-explicit-any
  client: any,
  presentedKey: string,
  now: Date = new Date(),
): Promise<PartnerKeyRecord> {
  if (!presentedKey || !presentedKey.startsWith(KEY_PREFIX)) {
    throw new PartnerAuthError("Invalid API key", "invalid_key", 401);
  }

  const hash = await hashPartnerKey(presentedKey);
  const { data, error } = await client
    .from("partner_api_keys")
    .select(
      "id, workspace_id, social_account_id, key_prefix, scopes, " +
        "rate_limit_per_min, monthly_quota, expires_at, revoked_at",
    )
    .eq("key_hash", hash)
    .maybeSingle();

  if (error) throw new PartnerAuthError("Key lookup failed", "internal_error", 500);
  // Same response for "no such key" as for a malformed one: non-enumerable.
  if (!data) throw new PartnerAuthError("Invalid API key", "invalid_key", 401);

  if (data.revoked_at) {
    throw new PartnerAuthError("API key revoked", "key_revoked", 401);
  }
  if (data.expires_at && new Date(data.expires_at) <= now) {
    throw new PartnerAuthError("API key expired", "key_expired", 401);
  }

  return {
    id: data.id,
    workspaceId: data.workspace_id,
    socialAccountId: data.social_account_id,
    keyPrefix: data.key_prefix,
    scopes: data.scopes ?? [],
    rateLimitPerMin: data.rate_limit_per_min,
    monthlyQuota: data.monthly_quota,
    expiresAt: data.expires_at,
    revokedAt: data.revoked_at,
  };
}

export function assertScope(
  record: PartnerKeyRecord,
  scope: PartnerScope,
): void {
  if (!record.scopes.includes(scope)) {
    throw new PartnerAuthError(
      `This key lacks the ${scope} scope`,
      "insufficient_scope",
      403,
    );
  }
}
