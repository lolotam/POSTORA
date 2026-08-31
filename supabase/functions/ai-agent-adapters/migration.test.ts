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
  assertMatch(sql, /REVOKE ALL ON FUNCTION public\.get_connector_credential\(uuid, uuid\) FROM PUBLIC/i);
  assertMatch(sql, /GRANT EXECUTE ON FUNCTION public\.get_connector_credential\(uuid, uuid\) TO service_role/i);
  assertEquals(/GRANT EXECUTE[\s\S]*TO authenticated/i.test(sql), false);
  assertEquals(/RETURNS TABLE/i.test(sql), false);
});

