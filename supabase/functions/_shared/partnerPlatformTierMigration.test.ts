import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// Privilege assertions for 20260910100000_partner_platform_tier.sql.
//
// This stack's ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public
// function to anon AND authenticated at CREATE time
// (supabase/tests/baseline_schema.sql). Those are DIRECT role grants, so
// "REVOKE ALL ... FROM PUBLIC" is a no-op against them -- PUBLIC is a
// different thing.
//
// That is not hypothetical here: ai-agent-adapters/migration.test.ts records
// that production served an anon call to get_connector_credential with HTTP
// 200 until the same omission was fixed. Two of the functions in this
// migration provision workspaces and revoke partner credentials, so the same
// omission would let an anonymous caller mint tenants and revoke any
// partner's keys with caller-chosen arguments.
//
// Asserted against the migration TEXT rather than a live database, matching
// the precedent, so the check runs in the ordinary edge-function suite with no
// Postgres available.

const migrationUrl = new URL(
  "../../migrations/20260910100000_partner_platform_tier.sql",
  import.meta.url,
);

/** Every function this migration defines. Each must be service-role only. */
const FUNCTIONS = [
  "consume_partner_platform_rate",
  "provision_partner_tenant",
  "issue_partner_key_in_estate",
  "revoke_partner_key_in_estate",
] as const;

const TABLES = [
  "partner_principals",
  "partner_platform_keys",
  "partner_platform_rate_buckets",
  "partner_provisioned_workspaces",
  "partner_provisioning_attempts",
] as const;

async function migrationSql(): Promise<string> {
  return await Deno.readTextFile(migrationUrl);
}

Deno.test("P1: every function revokes EXECUTE from anon and authenticated BY NAME", async () => {
  const sql = await migrationSql();

  for (const fn of FUNCTIONS) {
    // The signature may wrap across lines, so match the name then require the
    // three roles before the statement's semicolon.
    const revoke = new RegExp(
      `REVOKE ALL ON FUNCTION public\\.${fn}\\([^;]*?\\)\\s*FROM PUBLIC, anon, authenticated;`,
      "i",
    );
    assertMatch(
      sql,
      revoke,
      `${fn} must revoke from PUBLIC, anon AND authenticated -- FROM PUBLIC alone is a no-op ` +
        `against this stack's direct default grants`,
    );
  }
});

Deno.test("P2: no function grants EXECUTE to anon or authenticated", async () => {
  const sql = await migrationSql();

  assertEquals(
    /GRANT EXECUTE ON FUNCTION[\s\S]*?TO\s+anon/i.test(sql),
    false,
    "a platform-tier function granted EXECUTE to anon",
  );
  assertEquals(
    /GRANT EXECUTE ON FUNCTION[\s\S]*?TO\s+authenticated/i.test(sql),
    false,
    "a platform-tier function granted EXECUTE to authenticated",
  );
});

Deno.test("P3: every function is SECURITY DEFINER with a pinned search_path", async () => {
  const sql = await migrationSql();

  for (const fn of FUNCTIONS) {
    // SECURITY DEFINER without a pinned search_path is a privilege-escalation
    // vector: the definer's rights run against whatever schema the caller put
    // first.
    const definition = new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]*?AS \\$\\$`,
      "i",
    );
    const match = sql.match(definition);
    assertEquals(Boolean(match), true, `${fn} is not defined in this migration`);
    assertStringIncludes(match![0], "SECURITY DEFINER");
    assertMatch(match![0], /SET search_path\s*=\s*public/i);
  }
});

Deno.test("P4: every function grants EXECUTE to service_role", async () => {
  const sql = await migrationSql();

  for (const fn of FUNCTIONS) {
    const grant = new RegExp(
      `GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^;]*?\\)\\s*TO service_role;`,
      "i",
    );
    assertMatch(sql, grant, `${fn} must be callable by service_role`);
  }
});

Deno.test("P5: row level security is enabled on every new table", async () => {
  const sql = await migrationSql();

  for (const table of TABLES) {
    assertStringIncludes(
      sql,
      `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
      `${table} must have RLS enabled; these tables carry credentials and tenancy`,
    );
  }
});

Deno.test("P6: a workspace key can never be minted holding a platform scope", async () => {
  const sql = await migrationSql();

  // Asserted in the database rather than only in a handler, because a handler
  // check is one refactor from being skipped. Without it, provisioning could
  // hand a tenant the power to provision.
  assertMatch(
    sql,
    /RAISE EXCEPTION 'a workspace key may not hold a platform scope'/i,
    "provision_partner_tenant must refuse platform scopes on a workspace key",
  );
  assertStringIncludes(
    sql,
    "partner_platform_keys_scopes_are_platform",
    "a platform key must be constrained to platform scopes only",
  );
});

Deno.test("P7: the plaintext key never reaches the database", async () => {
  const sql = await migrationSql();

  // The caller hashes and passes only prefix + digest. A 64-character hex
  // check is what stops a plaintext key arriving in the hash column.
  assertMatch(
    sql,
    /length\(p_key_hash\)\s*<>\s*64/i,
    "key_hash must be validated as a 64-character SHA-256 digest",
  );
});
