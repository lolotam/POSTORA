import { assertEquals, assertMatch, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const sql = await Deno.readTextFile(new URL("../../migrations/20260910150000_patch_account_metadata_in_workspace.sql", import.meta.url));
const signature = "public.patch_account_metadata_in_workspace(uuid, uuid, jsonb)";

Deno.test("metadata RPC removes direct default grants from both API roles and grants only service_role", () => {
  // Production anon RPC exposure: ai-agent-adapters/migration.test.ts. PUBLIC
  // revocation cannot remove this stack's direct ALTER DEFAULT PRIVILEGES grants.
  assertStringIncludes(sql, `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
  assertEquals(sql.match(/GRANT\s+EXECUTE[^;]+;/gi), [`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`]);
});
Deno.test("metadata RPC pins definer search_path and scopes the atomic merge by workspace", () => {
  assertMatch(sql, /SECURITY DEFINER\s+SET search_path = public/);
  assertStringIncludes(sql, "WHERE id = p_account_id AND workspace_id = p_workspace_id");
  assertEquals(/auth\.uid\(\)/i.test(sql), false);
  assertStringIncludes(sql, "COALESCE(account_metadata, '{}'::jsonb) || p_patch");
  assertStringIncludes(sql, "IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN");
  assertStringIncludes(sql, "RAISE EXCEPTION 'Account not found or access denied'");
});
Deno.test("partner migration leaves the browser metadata RPC untouched", () => {
  assertEquals(/\bpatch_account_metadata\s*\(/i.test(sql), false);
  assertEquals(sql.match(/CREATE OR REPLACE FUNCTION\s+([\w.]+)/gi), ["CREATE OR REPLACE FUNCTION public.patch_account_metadata_in_workspace"]);
});
