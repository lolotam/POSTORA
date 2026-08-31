import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../migrations/20260831150000_connector_credential_read.sql",
  import.meta.url,
);

Deno.test("credential read RPC is ownership-scoped and service-role-only", async () => {
  const sql = await Deno.readTextFile(migrationUrl);

  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.get_connector_credential");
  assertStringIncludes(sql, "SECURITY DEFINER");
  assertMatch(sql, /SET search_path\s*=\s*public/i);
  assertMatch(sql, /t\.id\s*=\s*p_tool_id/i);
  assertMatch(sql, /t\.user_id\s*=\s*p_user_id/i);
  // anon and authenticated must be named. "REVOKE ALL ... FROM PUBLIC" alone --
  // which this asserted first, and which the migration originally shipped -- is
  // a no-op against them: this stack's ALTER DEFAULT PRIVILEGES grants EXECUTE
  // to both roles explicitly at CREATE time, and PUBLIC is a different thing.
  // Production served an anon call to this RPC with HTTP 200 until it was fixed.
  assertMatch(
    sql,
    /REVOKE EXECUTE ON FUNCTION public\.get_connector_credential\(uuid, uuid\)\s*FROM PUBLIC, anon, authenticated/i,
  );
  assertMatch(sql, /GRANT EXECUTE ON FUNCTION public\.get_connector_credential\(uuid, uuid\) TO service_role/i);
  assertEquals(/GRANT EXECUTE[\s\S]*TO authenticated/i.test(sql), false);
  assertEquals(/RETURNS TABLE/i.test(sql), false);
});

Deno.test("the companion migration repairs every previously exposed helper", async () => {
  // The same REVOKE ... FROM PUBLIC pattern shipped in four earlier helpers,
  // including set_ai_knowledge_source_visibility from #78, so a database built
  // from these files would be born vulnerable without this repair.
  const repair = await Deno.readTextFile(
    new URL("../../migrations/20260831150100_revoke_anon_rpc_exposure.sql", import.meta.url),
  );

  for (const fn of [
    "get_connector_credential",
    "upsert_connector_credential_secret",
    "delete_connector_credential_secret",
    "set_ai_agent_tool_accounts",
    "set_ai_knowledge_source_visibility",
  ]) {
    assertStringIncludes(repair, fn);
  }
  assertMatch(repair, /FROM PUBLIC, anon, authenticated/i);
  // A REVOKE issued by a non-owner is a WARNING, not an error, so the migration
  // has to fail loudly rather than report success having changed nothing.
  assertMatch(repair, /RAISE EXCEPTION/i);
});
