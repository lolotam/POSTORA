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

const { error: insertError } = await admin.from("partner_api_keys").insert({
  workspace_id: workspaceId,
  social_account_id: accountId,
  name,
  key_prefix: prefix,
  key_hash: hash,
  scopes,
  monthly_quota: quota,
});

if (insertError) { console.error("Insert failed:", insertError.message); Deno.exit(1); }

console.log("");
console.log("Key created. Copy it now - it is never shown again:");
console.log("");
console.log(`  ${key}`);
console.log("");
console.log(`  prefix: ${prefix}  scopes: ${scopes.join(", ")}`);
