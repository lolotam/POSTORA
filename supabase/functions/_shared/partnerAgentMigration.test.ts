// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
const sql = await Deno.readTextFile(new URL("../../migrations/20260910160000_provision_partner_agent.sql", import.meta.url));
Deno.test("agent provisioner removes direct anon/authenticated grants and grants only service_role", () => {
  assertMatch(sql, /REVOKE ALL ON FUNCTION public\.provision_partner_agent\([^;]*\) FROM PUBLIC, anon, authenticated;/i);
  const grants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION[^;]+TO\s+([^;]+);/gi)];
  assertEquals(grants.map((match) => match[1]), ["service_role"]);
});
Deno.test("agent provisioner pins definer search path and inserts agent membership atomically", () => {
  assertMatch(sql, /FUNCTION public\.provision_partner_agent\([\s\S]*?SECURITY DEFINER\s+SET search_path = public/i);
  assertMatch(sql, /INSERT INTO public\.workspace_members \(workspace_id, user_id, role\)\s+VALUES \(p_workspace_id, p_user_id, 'agent'\)/i);
  assertMatch(sql, /INSERT INTO public\.whatsapp_agents \(workspace_id, user_id, display_name, max_conversations\)/i);
  assertEquals(/INSERT INTO auth\.users/i.test(sql), false);
});
Deno.test("the shared assignment foreign key is left exactly as it was", () => {
  // An earlier draft retargeted it to ON DELETE NO ACTION to close a race in
  // one handler. whatsapp_agents.user_id cascades from auth.users, so that
  // would make deleting any user who ever held an assignment fail on a foreign
  // key -- account offboarding and erasure included -- to fix a partner racing
  // itself. deleteHumanAgent refuses on live assignments instead, and looks
  // for them WITHOUT a workspace predicate so legacy null rows still count.
  assertEquals(/ALTER TABLE public\.whatsapp_conversation_assignments/i.test(sql), false);
  assertEquals(/NO ACTION/i.test(sql), false);
});
