// Rotate a partner API key: issue a new secret with a bounded overlap window
// during which BOTH work, so a partner can deploy without downtime (D12).
//
//   deno run --allow-env --allow-net scripts/rotate-partner-key.ts \
//     --key <uuid> --overlap 60 --token <owner-or-admin access token>
//
// The plaintext is printed ONCE and is never retrievable afterwards, matching
// create-partner-key.ts and the mcp_oauth_tokens precedent.
//
// WHAT ROTATION DOES TO THE OLD KEY: sets its expires_at to the end of the
// overlap window. It does not revoke it and does not delete it -- the old
// secret simply stops authenticating when the window closes, through the same
// expiry path authenticatePartnerKey already enforces.
//
// If the old key was already time-boxed to sooner than the overlap would
// reach, the EARLIER deadline wins. Rotation never lengthens a credential's
// life; doing so would be a capability grant performed as a side effect of an
// operation nobody thinks of as granting anything.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { generatePartnerKey } from "../supabase/functions/_shared/partnerApiKeys.ts";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const keyId = arg("key");
// Number("--token") is NaN, and NaN would reach the RPC as null and be
// refused -- but validate here so the operator gets a usable message rather
// than a constraint violation.
const rawOverlap = arg("overlap") ?? "60";
const overlapMinutes = Number(rawOverlap);

if (!keyId) {
  console.error("Missing --key <uuid> (the key to rotate)");
  Deno.exit(2);
}
if (!Number.isInteger(overlapMinutes) || overlapMinutes < 0 || overlapMinutes > 43200) {
  console.error(`--overlap must be a whole number of minutes between 0 and 43200 (30 days); got "${rawOverlap}"`);
  console.error("0 means an immediate cutover -- correct when a key is known to have leaked.");
  Deno.exit(2);
}

// A USER's JWT, not the service-role key: rotate_partner_key() authorises via
// auth.uid() and stamps the actor from it. See create-partner-key.ts.
const userJwt = arg("token") ?? Deno.env.get("SUPABASE_USER_JWT");
if (!userJwt) {
  console.error("Missing --token (or SUPABASE_USER_JWT): the access token of a");
  console.error("workspace owner or admin. The service-role key will NOT work.");
  Deno.exit(2);
}

const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
  { global: { headers: { Authorization: `Bearer ${userJwt}` } } },
);

const { key, prefix, hash } = await generatePartnerKey();

// One atomic call: the successor key, every copied binding, the predecessor's
// new deadline and both audit rows share a single transaction.
const { data: newKeyId, error } = await client.rpc("rotate_partner_key", {
  p_key_id: keyId,
  p_new_key_prefix: prefix,
  p_new_key_hash: hash,
  p_overlap_minutes: overlapMinutes,
});

if (error) {
  console.error("Rotation failed:", error.message);
  console.error("");
  console.error("Nothing changed: rotation is one transaction, so a failure leaves");
  console.error("the existing key untouched and mints no successor.");
  if (/no such partner key/i.test(error.message)) {
    console.error("");
    console.error("Either no key has that id, or this token's user is not an owner");
    console.error("or admin of its workspace. The two are deliberately");
    console.error("indistinguishable, so key ids cannot be probed for existence.");
  }
  Deno.exit(1);
}

// Read back the resolved deadline rather than computing it here: the RPC may
// have CLAMPED the overlap to a pre-existing expiry, and printing the
// requested window when a shorter one was applied would tell the operator the
// old secret lives longer than it does.
const { data: predecessor } = await client
  .from("partner_api_keys")
  .select("expires_at, key_prefix")
  .eq("id", keyId)
  .maybeSingle();

const deadline = predecessor?.expires_at ?? null;

console.log("");
console.log("Partner key rotated.");
console.log("");
console.log(`  new key id : ${newKeyId}`);
console.log(`  new prefix : ${prefix}`);
console.log("");
console.log("  PLAINTEXT (shown once, never retrievable):");
console.log(`  ${key}`);
console.log("");
if (deadline) {
  const mins = Math.round((new Date(deadline).getTime() - Date.now()) / 60000);
  console.log(`  OLD KEY (${predecessor?.key_prefix}) STOPS WORKING AT:`);
  console.log(`  ${deadline}   (~${mins} minute(s) from now)`);
  if (mins < overlapMinutes) {
    console.log("");
    console.log(`  NOTE: shorter than the ${overlapMinutes} minutes requested. The old key`);
    console.log("  already had an earlier expiry, and rotation never extends one.");
  }
} else {
  console.log("  WARNING: could not read back the old key's deadline.");
  console.log("  The rotation succeeded; check partner_api_keys.expires_at directly.");
}
console.log("");
console.log("  Deploy the new key everywhere BEFORE that deadline.");
console.log("");
