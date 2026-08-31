// Mint a partner API key. Operator-only: run with the service-role key.
//
//   deno run --allow-env --allow-net scripts/create-partner-key.ts //     --workspace <uuid> --account <uuid> --name "Danat backend" //     --scopes messages:send,templates:read //     --quota 5000
//
// The plaintext key is printed ONCE and never stored.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { generatePartnerKey } from "../supabase/functions/_shared/partnerApiKeys.ts";
import {
  describeScopeRejection,
  GENERIC_SCOPES,
  scopeIsMintable,
} from "../supabase/functions/_shared/partnerScopes.ts";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const workspaceId = arg("workspace");
const accountId = arg("account");
const name = arg("name");
const scopes = (arg("scopes") ?? "").split(",").filter(Boolean);
// Number("--account") is NaN, and NaN serializes to null, which means
// UNLIMITED quota. Validate rather than silently minting an uncapped key.
const rawQuota = arg("quota");
let quota: number | null = null;
if (rawQuota !== undefined) {
  quota = Number(rawQuota);
  if (!Number.isSafeInteger(quota) || quota < 0) {
    console.error(`--quota must be a non-negative integer, got: ${rawQuota}`);
    Deno.exit(2);
  }
}



if (!workspaceId || !accountId || !name || scopes.length === 0) {
  console.error("Missing --workspace, --account, --name, or --scopes");
  Deno.exit(2);
}

// A new key may hold ONLY generic v1 scopes (decision D3 step 3). Two
// different refusals, for two different reasons:
//
//   - a LEGACY provider-prefixed string is frozen at its current capability
//     and not issuable any more. D3's step 2 -- reissuing the one existing key
//     with generic scopes -- has no subject, since pk_live_urCb is revoked and
//     no active keys remain, so this refusal is unconditional.
//   - an UNRECOGNISED string would sit in the scopes array looking
//     authoritative while satisfying nothing, and mean whatever the next
//     person assumes it means.
const badScopes = scopes.filter((sc) => !scopeIsMintable(sc));
if (badScopes.length > 0) {
  for (const sc of badScopes) console.error(describeScopeRejection(sc));
  console.error(`
Issuable scopes: ${GENERIC_SCOPES.join(", ")}`);
  Deno.exit(2);
}

// A USER's JWT, not the service-role key. D12 puts credential lifecycle in the
// Developer area, user-JWT authenticated -- and create_partner_key() enforces
// that by authorising through auth.uid(), which is NULL for a service-role
// client. A service-role call is refused, deliberately: "who created this key"
// must be a person, or the audit trail records nobody.
const userJwt = arg("token") ?? Deno.env.get("SUPABASE_USER_JWT");
if (!userJwt) {
  console.error("Missing --token (or SUPABASE_USER_JWT): the access token of a");
  console.error("workspace owner or admin. The service-role key will NOT work --");
  console.error("create_partner_key() authorises via auth.uid() and stamps the");
  console.error("actor from it, so a keyless call has no actor to record.");
  Deno.exit(2);
}

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
  { global: { headers: { Authorization: `Bearer ${userJwt}` } } },
);

// Refuse to pin a non-WhatsApp or unhealthy account. The composite FK proves
// only that the account is in the workspace, never that it can send.
const { data: account, error } = await admin
  .from("social_accounts")
  .select("id, platform, workspace_id, is_active, needs_reauth")
  .eq("id", accountId)
  .maybeSingle();

if (error) { console.error("Lookup failed:", error.message); Deno.exit(1); }
if (!account) { console.error("No such social account"); Deno.exit(1); }
if (account.platform !== "whatsapp") {
  console.error(`Account is ${account.platform}, not whatsapp`); Deno.exit(1);
}
if (account.workspace_id !== workspaceId) {
  console.error("Account does not belong to that workspace"); Deno.exit(1);
}
if (!account.is_active || account.needs_reauth) {
  console.error("Account is inactive or needs re-authorization"); Deno.exit(1);
}

const { key, prefix, hash } = await generatePartnerKey();

// ONE atomic call: the key row, its account binding and the `create` audit row
// share create_partner_key()'s single transaction. The previous two-insert flow
// could leave a key with no binding if the second insert failed, and this
// script could not clean up after itself -- least-privilege leaves service_role
// no UPDATE on partner_api_keys and revoke_partner_key() is auth.uid()-scoped.
// That was threat-review finding F3; it is now unrepresentable rather than
// merely unlikely.
//
// The plaintext never leaves this process: only the prefix and the SHA-256
// digest are sent.
const { data: newKeyId, error: rpcError } = await admin.rpc("create_partner_key", {
  p_workspace_id: workspaceId,
  p_social_account_id: accountId,
  p_name: name,
  p_key_prefix: prefix,
  p_key_hash: hash,
  p_scopes: scopes,
  p_monthly_quota: quota,
});

if (rpcError) {
  console.error("Key creation failed:", rpcError.message);
  console.error("");
  console.error("Nothing was created: the key row, the account binding and the");
  console.error("audit row are one transaction, so a failure leaves no partial key.");
  if (/insufficient_privilege|not authorized/i.test(rpcError.message)) {
    console.error("");
    console.error("This token's user must be an owner or admin of that workspace.");
  }
  Deno.exit(1);
}

const inserted = { id: newKeyId as string };

console.log("");
console.log("Key created. Copy it now - it is never shown again:");
console.log("");
console.log(`  ${key}`);
console.log("");
console.log(`  prefix: ${prefix}  scopes: ${scopes.join(", ")}`);
