// Public synthetic credentials and fixed loopback endpoints for a disposable fixture only.
import process from "node:process";

// Some desktop IDEs reserve the default forwarded Auth port. The override
// changes only a local port; it can never select another host or production.
const canReadPort = typeof Deno === "undefined"
  || Deno.permissions.querySync({ name: "env", variable: "POSTORA_OWNER_RELEASE_AUTH_PORT" }).state === "granted";
const authPort = canReadPort ? process.env.POSTORA_OWNER_RELEASE_AUTH_PORT ?? "65435" : "65435";
if (!/^\d{4,5}$/.test(authPort) || Number(authPort) < 1024 || Number(authPort) > 65535
  || [8080, 65431, 65436].includes(Number(authPort))) {
  throw new Error("Owner-release Auth port must be a distinct local unprivileged port");
}
export const OWNER_RELEASE = Object.freeze({
  apiUrl: "http://127.0.0.1:65431",
  authUrl: `http://127.0.0.1:${authPort}`,
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
