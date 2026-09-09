// Platform credentials resolve through their own table: tier is a property
// of the code path, never a caller-controlled property on a shared record.
import {
  doorEnvironment,
  hashPartnerKey,
  PartnerAuthError,
  type PartnerEnvironment,
} from "./partnerApiKeys.ts";

export interface PlatformKeyRecord {
  id: string;
  principalId: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  expiresAt: string | null;
  revokedAt: string | null;
}

const PLATFORM_PREFIX_BY_ENVIRONMENT = {
  production: "pl_live_",
  staging: "pl_test_",
} as const;

export async function authenticatePlatformKey(
  // deno-lint-ignore no-explicit-any
  admin: any,
  presented: string,
  doorEnv: PartnerEnvironment = doorEnvironment(),
): Promise<PlatformKeyRecord | null> {
  // Refuse cross-environment credentials before any lookup, just like an
  // unknown key. Display prefixes are not unique; only the full hash is.
  if (!presented || !presented.startsWith(PLATFORM_PREFIX_BY_ENVIRONMENT[doorEnv])) {
    return null;
  }
  const hash = await hashPartnerKey(presented);
  const { data, error } = await admin
    .from("partner_platform_keys")
    .select(
      "id, principal_id, key_prefix, scopes, rate_limit_per_min, " +
        "expires_at, revoked_at, environment",
    )
    .eq("key_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) throw new PartnerAuthError("Key lookup failed", "internal_error", 500);
  if (!data) return null;
  // A restored database can contain another deployment's rows. Its prefix
  // constraint proves internal consistency, not that this door may use it.
  if (data.environment !== doorEnv || data.revoked_at) return null;
  if (data.expires_at && new Date(data.expires_at) <= new Date()) return null;

  return {
    id: data.id,
    principalId: data.principal_id,
    keyPrefix: data.key_prefix,
    scopes: data.scopes ?? [],
    rateLimitPerMin: data.rate_limit_per_min,
    expiresAt: data.expires_at,
    revokedAt: data.revoked_at,
  };
}
