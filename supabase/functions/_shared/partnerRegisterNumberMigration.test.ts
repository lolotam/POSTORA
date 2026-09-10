import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// Privilege and shape assertions for
// 20260910120000_partner_register_whatsapp_number.sql.
//
// Same threat model as partnerPlatformTierMigration.test.ts: this stack's
// ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public function to
// anon AND authenticated at CREATE time
// (supabase/tests/baseline_schema.sql). Those are DIRECT role grants, so
// "REVOKE ALL ... FROM PUBLIC" is a no-op against them. This function
// creates social_accounts rows, so an anonymous caller with EXECUTE could
// mint WhatsApp accounts under any workspace whose key id they can guess.
//
// Beyond privileges, this file guards the two defects that would make a
// created number useless or untrustworthy: a missing
// partner_api_key_accounts binding (binding.ts has no fallback, so the
// creating key could neither list nor pair the number) and a consent record
// that cannot distinguish a partner's attestation from an acceptance Postora
// itself witnessed.
//
// Asserted against the migration TEXT rather than a live database, matching
// the precedent, so the check runs in the ordinary edge-function suite with
// no Postgres available.

const migrationUrl = new URL(
  "../../migrations/20260910120000_partner_register_whatsapp_number.sql",
  import.meta.url,
);

const FN = "register_partner_whatsapp_number";

async function migrationSql(): Promise<string> {
  return await Deno.readTextFile(migrationUrl);
}

Deno.test("P1: the function revokes EXECUTE from anon and authenticated BY NAME", async () => {
  const sql = await migrationSql();

  const revoke = new RegExp(
    `REVOKE ALL ON FUNCTION public\\.${FN}\\([^;]*?\\)\\s*FROM PUBLIC, anon, authenticated;`,
    "i",
  );
  assertMatch(
    sql,
    revoke,
    `${FN} must revoke from PUBLIC, anon AND authenticated -- FROM PUBLIC alone is a no-op ` +
      `against this stack's direct default grants`,
  );
});

Deno.test("P2: the function does not grant EXECUTE to anon or authenticated", async () => {
  const sql = await migrationSql();

  assertEquals(
    /GRANT EXECUTE ON FUNCTION[\s\S]*?TO\s+anon/i.test(sql),
    false,
    "an anonymous PostgREST client must not be able to call an account-creating RPC",
  );
  assertEquals(
    /GRANT EXECUTE ON FUNCTION[\s\S]*?TO\s+authenticated/i.test(sql),
    false,
    "a browser session must not be able to call an account-creating RPC directly",
  );
});

Deno.test("P3: the function is SECURITY DEFINER with a pinned search_path", async () => {
  const sql = await migrationSql();

  // SECURITY DEFINER without a pinned search_path is a privilege-escalation
  // vector: the definer's rights run against whatever schema the caller put
  // first.
  const definition = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${FN}\\([\\s\\S]*?AS \\$\\$`,
    "i",
  );
  const match = sql.match(definition);
  assertEquals(Boolean(match), true, `${FN} is not defined in this migration`);
  assertStringIncludes(match![0], "SECURITY DEFINER");
  assertMatch(match![0], /SET search_path\s*=\s*public/i);
});

Deno.test("P4: the function grants EXECUTE to service_role", async () => {
  const sql = await migrationSql();

  const grant = new RegExp(
    `GRANT EXECUTE ON FUNCTION public\\.${FN}\\([^;]*?\\)\\s*TO service_role;`,
    "i",
  );
  assertMatch(sql, grant, `${FN} must be callable by service_role`);
});

Deno.test("P5: registration writes the account, the binding AND the audit row", async () => {
  const sql = await migrationSql();

  // The binding is the load-bearing one: without it the key that created
  // the number cannot see it, and pairing refuses it as unbound.
  assertMatch(
    sql,
    /INSERT INTO public\.social_accounts/i,
    "the placeholder account row must be created",
  );
  assertMatch(
    sql,
    /INSERT INTO public\.partner_api_key_accounts/i,
    "the key binding must be created in the same transaction as the account",
  );
  assertMatch(
    sql,
    /INSERT INTO public\.partner_audit_logs/i,
    "the audit row must be created in the same transaction",
  );
});

Deno.test("P6: the consent object records the attestation grade, not just the claim", async () => {
  const sql = await migrationSql();

  assertStringIncludes(
    sql,
    "'partner_attestation'",
    "the evidence grade must be recorded as partner_attestation",
  );
  assertStringIncludes(
    sql,
    "'evidence'",
    "the consent object must carry the evidence grade",
  );
  assertStringIncludes(
    sql,
    "'consent_version'",
    "the consent object must record which text was accepted",
  );
  assertStringIncludes(
    sql,
    "'recorded_at'",
    "the consent object must record when Postora received the attestation",
  );
  assertEquals(
    sql.includes("'observed'"),
    false,
    "the browser-door evidence grade must never appear on the attestation path: " +
      "a reported IP must not later read as one Postora witnessed",
  );
});

Deno.test("P7: the account quota is enforced against the workspace owner", async () => {
  const sql = await migrationSql();

  // The door exempts admins and counts only active accounts against the
  // maximum; the RPC must reproduce that rule rather than drop it.
  assertStringIncludes(
    sql,
    "user_roles",
    "admins must be exempt from the quota, as in enforceAccountQuota",
  );
  assertMatch(
    sql,
    /count\(\*\)[\s\S]*?FROM public\.social_accounts/i,
    "the owner's existing accounts must be counted before inserting",
  );
  assertStringIncludes(
    sql,
    "effective_user_quotas",
    "the maximum must come from the SQL quota arbiter, not an invented limit",
  );
});

Deno.test("P8: the function returns the new account id", async () => {
  const sql = await migrationSql();

  assertStringIncludes(
    sql,
    "'account_id'",
    "the handler needs the new number's id to hand to pairing",
  );
});
