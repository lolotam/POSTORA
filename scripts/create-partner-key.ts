// Mint a partner API key. Operator-only: run with the service-role key.
//
//   deno run --allow-env --allow-net scripts/create-partner-key.ts //     --workspace <uuid> --account <uuid> --name "Danat backend" //     --scopes whatsapp:template.send,whatsapp:webhooks.manage //     --quota 5000
//
// The plaintext key is printed ONCE and never stored.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { generatePartnerKey } from "../supabase/functions/_shared/partnerApiKeys.ts";

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

const ALLOWED_SCOPES = [
  "whatsapp:template.send",
  "whatsapp:templates.read",
  "whatsapp:webhooks.manage",
];

if (!workspaceId || !accountId || !name || scopes.length === 0) {
  console.error("Missing --workspace, --account, --name, or --scopes");
  Deno.exit(2);
}

const badScopes = scopes.filter((sc) => !ALLOWED_SCOPES.includes(sc));
if (badScopes.length > 0) {
  console.error(`Unknown scope(s): ${badScopes.join(", ")}`);
  console.error(`Allowed: ${ALLOWED_SCOPES.join(", ")}`);
  Deno.exit(2);
}

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
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

const { data: inserted, error: insertError } = await admin
  .from("partner_api_keys")
  .insert({
    workspace_id: workspaceId,
    social_account_id: accountId,
    name,
    key_prefix: prefix,
    key_hash: hash,
    scopes,
    monthly_quota: quota,
  })
  .select("id")
  .single();

if (insertError) { console.error("Insert failed:", insertError.message); Deno.exit(1); }

// The binding row, without which this key can reach nothing once account
// selection (D11) lands: that reads partner_api_key_accounts, not the pinned
// social_account_id column. The join table arrived in
// 20260830120000_partner_api_key_accounts.sql, which backfilled one row per
// key that EXISTED THEN -- and nothing taught this script to write one for
// keys minted after. A key minted between that migration and this fix would
// have looked fine and silently resolved to no accounts.
//
// Found by the 0.9 threat review (finding F3). Fixed here rather than deferred
// to the credential lifecycle (1.3) because there are currently zero partner
// keys, which makes this the cheapest it will ever be to correct.
const { error: bindError } = await admin.from("partner_api_key_accounts").insert({
  key_id: inserted.id,
  social_account_id: accountId,
  workspace_id: workspaceId,
});

if (bindError) {
  // Loud, and explicitly NOT a partial success: a key with no binding is worse
  // than no key, because it authenticates and then resolves to nothing.
  console.error("Account binding failed:", bindError.message);
  console.error("The key row was created but has NO account binding.");
  console.error("");
  console.error("The plaintext was NOT printed, so nobody can use this key --");
  console.error("but it is still an active row and must be revoked.");
  console.error("");
  console.error("Run this AS THE DATABASE OWNER (supabase_admin), not through");
  console.error("this script's service_role client: the least-privilege grants in");
  console.error("20260830120300 deliberately leave service_role no UPDATE on");
  console.error("partner_api_keys, and revoke_partner_key() is auth.uid()-scoped,");
  console.error("so neither path here can revoke it:");
  console.error("");
  console.error(`  UPDATE partner_api_keys SET revoked_at = now(),`);
  console.error(`         revoked_reason = 'created without an account binding'`);
  console.error(`   WHERE id = '${inserted.id}';`);
  console.error("");
  console.error("Creating both rows atomically needs a SECURITY DEFINER RPC. That");
  console.error("belongs to the credential lifecycle (deliverable 1.3), which");
  console.error("replaces this script; building it here would be thrown away.");
  Deno.exit(1);
}

console.log("");
console.log("Key created. Copy it now - it is never shown again:");
console.log("");
console.log(`  ${key}`);
console.log("");
console.log(`  prefix: ${prefix}  scopes: ${scopes.join(", ")}`);
