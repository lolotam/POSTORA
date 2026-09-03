// Browser twin of supabase/functions/_shared/partnerApiKeys.ts generatePartnerKey.
//
// Minting happens in the browser on purpose (spec D3): the plaintext exists
// only in this tab and only until the dialog closes; the server receives the
// prefix and the SHA-256 digest, exactly as scripts/create-partner-key.ts
// sends them. The database refuses a prefix that disagrees with the
// environment and a digest that is not 64 hex chars, so a drift here fails
// loudly rather than minting a wrong key.

export type PartnerEnvironment = "production" | "staging";

export const KEY_PREFIX_BY_ENVIRONMENT: Record<PartnerEnvironment, string> = {
  production: "pk_live_",
  staging: "pk_test_",
};

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface MintedPartnerKey {
  /** The plaintext. Show once, never store. */
  key: string;
  /** First 12 chars, e.g. "pk_live_a1b2" — what the table displays. */
  prefix: string;
  /** SHA-256 hex digest of the plaintext — what the database stores. */
  hash: string;
}

export async function hashPartnerKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generatePartnerKey(environment: PartnerEnvironment): Promise<MintedPartnerKey> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const b of bytes) body += BASE62[b % BASE62.length];
  const key = KEY_PREFIX_BY_ENVIRONMENT[environment] + body;
  return { key, prefix: key.slice(0, 12), hash: await hashPartnerKey(key) };
}
