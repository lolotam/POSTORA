// Partner API key generation and authentication.
//
// Keys are shown to the operator exactly once and stored only as a SHA-256
// hex digest, following the mcp_oauth_tokens precedent — a database leak
// yields no usable credentials.

// One prefix per environment (10.5). The prefix is the door's first check,
// before any lookup, so a staging key never costs production a database read
// and a restored production dump cannot make production keys usable in
// staging. The database's partner_key_environment_for_prefix() is the same
// rule; a row whose prefix disagrees with its environment is refused there.
const KEY_PREFIX_BY_ENVIRONMENT = {
  production: "pk_live_",
  staging: "pk_test_",
} as const;
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// The scope vocabularies live in partnerScopes.ts, which owns decision D3's
// legacy allowlist. Re-exported here so existing importers keep one import.
export type { PartnerScope } from "./partnerScopes.ts";
import type { PartnerScope } from "./partnerScopes.ts";

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

export type PartnerEnvironment = keyof typeof KEY_PREFIX_BY_ENVIRONMENT;

/**
 * Which environment this door is. Read from PARTNER_API_ENVIRONMENT; unset
 * means production, because the one deployment that exists today has it
 * unset and must keep working unchanged. Any other value is a misconfigured
 * door, and a misconfigured door refuses every key rather than guessing —
 * the log names the variable and never its value or any key.
 */
export function doorEnvironment(
  raw: string | undefined = Deno.env.get("PARTNER_API_ENVIRONMENT"),
): PartnerEnvironment {
  if (raw === undefined || raw === "") return "production";
  if (raw === "staging" || raw === "production") return raw;
  console.error("[partner-api] PARTNER_API_ENVIRONMENT is not staging or production; refusing all keys");
  throw new PartnerAuthError("Server misconfigured", "internal_error", 500);
}

/** Async because SubtleCrypto's digest is the only hash available in the
 *  edge runtime — node:crypto is not reliably present. */
export async function generatePartnerKey(
  environment: PartnerEnvironment = "production",
): Promise<{
  key: string;
  prefix: string;
  hash: string;
}> {
  const prefix = KEY_PREFIX_BY_ENVIRONMENT[environment];
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const b of bytes) body += BASE62[b % BASE62.length];
  const key = prefix + body;
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
  // Evaluated before the body runs, so a misconfigured door throws before any
  // key is hashed or looked up. Tests pass it explicitly to drive either door.
  doorEnv: PartnerEnvironment = doorEnvironment(),
): Promise<PartnerKeyRecord> {
  // The prefix layer: a key from the other environment is refused here, before
  // any lookup, with the same answer an unknown key gets — so a production
  // door never confirms that a staging key exists, and vice versa.
  if (!presentedKey || !presentedKey.startsWith(KEY_PREFIX_BY_ENVIRONMENT[doorEnv])) {
    throw new PartnerAuthError("Invalid API key", "invalid_key", 401);
  }

  const hash = await hashPartnerKey(presentedKey);
  const { data, error } = await client
    .from("partner_api_keys")
    .select(
      "id, workspace_id, social_account_id, key_prefix, scopes, " +
        "rate_limit_per_min, monthly_quota, expires_at, revoked_at, environment",
    )
    .eq("key_hash", hash)
    .maybeSingle();

  if (error) throw new PartnerAuthError("Key lookup failed", "internal_error", 500);
  // Same response for "no such key" as for a malformed one: non-enumerable.
  // An environment mismatch shares this answer so a staging key cannot be
  // probed for existence through a production door and a restored dump cannot
  // be distinguished from "no such key".
  if (!data) throw new PartnerAuthError("Invalid API key", "invalid_key", 401);

  // Column layer (after the lookup): the row's environment must match the
  // door's. A missing field is treated as production because the column is
  // NOT NULL DEFAULT production — every existing row has it, and the only
  // fixtures that omit it are tests written before the column existed.
  const rowEnv: string = (data.environment as string | undefined) ?? "production";
  if (rowEnv !== doorEnv) {
    throw new PartnerAuthError("Invalid API key", "invalid_key", 401);
  }

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

/**
 * Authorise an ACTION, never a bare scope.
 *
 * The action is the unit of authorisation because two scope vocabularies
 * coexist (decision D3) and an action may be satisfied by either. Taking the
 * satisfying set rather than one scope keeps that rule in ACTION_SCOPES alone,
 * where it is reviewable — a caller cannot weaken it by passing a different
 * scope constant, because there is no single constant to pass.
 *
 * `satisfying` being empty means the scope grants nothing and the action is
 * unreachable. That is a real state, not a bug: `whatsapp:webhooks.manage`
 * authorises nothing at all, and an empty set must REFUSE rather than fall
 * through to a permissive default — `Array.prototype.some` on an empty array
 * returns false, which is the behaviour we want and the reason it is written
 * this way rather than as a negated `every`.
 */
export function assertActionAuthorized(
  record: PartnerKeyRecord,
  action: string,
  satisfying: readonly PartnerScope[],
): void {
  const held = new Set(record.scopes);
  if (!satisfying.some((scope) => held.has(scope))) {
    throw new PartnerAuthError(
      // The message names the action, not the scopes: listing which scopes
      // would have worked tells an attacker holding a stolen key what to ask
      // the victim to add.
      `This key is not authorized for ${action}`,
      "insufficient_scope",
      403,
    );
  }
}
