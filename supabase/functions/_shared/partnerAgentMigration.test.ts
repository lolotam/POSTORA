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
Deno.test("the assignment FK becomes NO ACTION while history FKs stay unchanged", () => {
  // Comments document the untouched history FKs; only executable SQL can alter them.
  const statements = sql.replace(/--[^\r\n]*/g, "");
  assertMatch(statements, /do\s+\$\$[\s\S]*?from pg_constraint as c[\s\S]*?end;\s*\$\$;/i);
  assertMatch(statements, /c\.conrelid = 'public\.whatsapp_conversation_assignments'::regclass/i);
  assertMatch(statements, /c\.confrelid = 'public\.whatsapp_agents'::regclass/i);
  assertMatch(statements, /a\.attname = 'agent_id'/i);
  assertMatch(statements, /alter table public\.whatsapp_conversation_assignments\s+add foreign key \(agent_id\) references public\.whatsapp_agents\(id\)\s+on delete no action;/i);
  assertEquals(/whatsapp_assignment_history/i.test(statements), false);
});
