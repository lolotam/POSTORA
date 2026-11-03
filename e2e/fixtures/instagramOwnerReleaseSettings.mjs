// Public synthetic credentials and fixed loopback endpoints for a disposable fixture only.
export const OWNER_RELEASE = Object.freeze({
  apiUrl: "http://127.0.0.1:65431",
  authUrl: "http://127.0.0.1:65435",
  restUrl: "http://127.0.0.1:65436",
  container: "postora-owner-release-pg",
  database: "postora_owner_release_harness",
  signingSecret: "postora-owner-release-synthetic-signing-secret-2026",
  password: "OwnerReleaseSyntheticPassword-2026!",
  ownerId: "8e010000-0000-4000-8000-000000000001",
  otherOwnerId: "8e010000-0000-4000-8000-000000000002",
  accountId: "8e020000-0000-4000-8000-000000000001",
  otherAccountId: "8e020000-0000-4000-8000-000000000002",
  credentialId: "8e030000-0000-4000-8000-000000000001",
  email: "instagram-owner-release@example.test",
  apiKey: "postora-owner-release-synthetic-key-2026",
});

/** @param {"anon" | "service_role"} role */
export async function syntheticOwnerReleaseKey(role) {
  const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const encode = (payload) => base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, iss: "supabase", exp: 4_102_444_800 })}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(OWNER_RELEASE.signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${unsigned}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))))}`;
}
