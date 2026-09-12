// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { CERTIFIED_EVENT_TYPES } from "./partnerWebhookEvents.ts";
const sql = await Deno.readTextFile(new URL("../../migrations/20260910170000_partner_assignment_events.sql", import.meta.url));
const previous = await Deno.readTextFile(new URL("../../migrations/20260910130000_partner_connection_events.sql", import.meta.url));
function certified(source: string) { return [...source.match(/events <@ ARRAY\[([\s\S]*?)\]/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]); }
const emitter = sql.split("CREATE OR REPLACE FUNCTION public.partner_assignment_events_emit()")[1].split("$$;")[0];
Deno.test("assignment CHECK preserves every prior type and matches the TypeScript certification exactly", () => {
  assertEquals(certified(sql), [...certified(previous), "conversation.assigned", "conversation.unassigned"]);
  assertEquals(certified(sql), [...CERTIFIED_EVENT_TYPES]);
  assertMatch(sql, /DO \$widen\$[\s\S]*IF v_def IS NULL THEN\s+RAISE EXCEPTION/);
  assertMatch(sql, /IF v_def LIKE '%conversation.assigned%'\s+AND v_def LIKE '%conversation.unassigned%' THEN\s+RETURN/);
  assertMatch(sql, /cardinality\(events\) > 0/);
});
Deno.test("assignment emitter pins its definer search path, revokes both API roles and attaches to the transition column", () => {
  assertMatch(emitter, /SECURITY DEFINER\s+SET search_path = public/);
  assertMatch(sql, /REVOKE ALL ON FUNCTION public.partner_assignment_events_emit\(\) FROM PUBLIC, anon, authenticated;/);
  assertMatch(sql, /AFTER INSERT OR UPDATE OF unassigned_at ON public.whatsapp_conversation_assignments\s+FOR EACH ROW EXECUTE FUNCTION public.partner_assignment_events_emit\(\)/);
});
Deno.test("assignment emission excludes unsafe attribution and contains no private text key", () => {
  assertMatch(emitter, /NEW.workspace_id IS NULL OR NEW.conversation_cache_id IS NULL/);
  assertMatch(emitter, /'conversation', 'conv_' \|\| NEW.conversation_cache_id/);
  assertMatch(emitter, /'agent_id', 'agent_' \|\| NEW.agent_id/);
  assertEquals(/NEW\.conversation_id|'conversation_id'|'user_id'/i.test(emitter), false);
  // OTHERS keeps an emission failure from rolling back the assignment. Catching
  // query_canceled too would make the write ignore statement_timeout and an
  // operator's cancel, so those must still abort it.
  assertMatch(emitter, /WHEN OTHERS THEN[\s\S]*RETURN NEW/);
  assertEquals(/WHEN\s+query_canceled/i.test(emitter), false);
});
Deno.test("assignment occurrences identify both transitions with assignment id and UTC transition instant", () => {
  assertMatch(emitter, /TG_OP = 'INSERT' AND NEW.unassigned_at IS NULL[\s\S]*v_at := NEW.assigned_at/);
  assertMatch(emitter, /OLD.unassigned_at IS NULL AND NEW.unassigned_at IS NOT NULL[\s\S]*v_at := NEW.unassigned_at/);
  assertMatch(emitter, /v_type \|\| ':' \|\| NEW.id \|\| ':' \|\| v_when/);
  assertMatch(emitter, /v_at AT TIME ZONE 'UTC'/);
});
Deno.test("assignment mutation RPC is service-only, structurally scoped and preserves existing constraints", () => {
  assertMatch(sql, /REVOKE ALL ON FUNCTION public.partner_write_conversation_assignment\([^;]+FROM PUBLIC, anon, authenticated;/);
  assertMatch(sql, /GRANT EXECUTE ON FUNCTION public.partner_write_conversation_assignment\([^;]+TO service_role;/);
  assertMatch(sql, /c.workspace_id = p_workspace_id[\s\S]*FOR UPDATE OF c/);
  assertMatch(sql, /id = p_agent_id AND workspace_id = p_workspace_id FOR KEY SHARE/);
  assertMatch(sql, /INSERT INTO public.whatsapp_conversation_assignments\s+\(workspace_id, conversation_cache_id, conversation_id/);
  assertMatch(sql, /INSERT INTO public.whatsapp_assignment_history\s+\(workspace_id, conversation_id/);
  assertEquals(/DELETE FROM public.whatsapp_conversation_assignments|ALTER TABLE public.whatsapp_conversation_assignments|CREATE (UNIQUE )?INDEX|DROP INDEX/i.test(sql), false);
});
