// The parent resolver owns workspace/account authority. Never publish its text
// conversation key or owner; both are private persistence identities.
// deno-lint-ignore no-import-prefix
import { z } from "npm:zod@3.23.8";
import { HumanAgentOpError, type HumanAgentContext } from "../../_shared/humanAgentOps.ts";
import { decodeId, encodeId } from "./ids.ts";
import { encodeCursor, keysetFilter, type PageRequest } from "./pagination.ts";
import type { ModeConversation } from "./conversationModes.ts";

const assignmentSchema = z.object({ agent_id: z.string(), notes: z.string().max(10000).nullable().optional() }).strict();
export function assignmentInput(body: unknown, remove: boolean) {
  if (remove) {
    if (!z.object({}).strict().safeParse(body).success) throw new HumanAgentOpError("invalid_request", "DELETE accepts no assignment fields");
    return { agentId: null, notes: null };
  }
  const parsed = assignmentSchema.safeParse(body);
  if (!parsed.success) throw new HumanAgentOpError("invalid_request", "Invalid assignment fields");
  const agentId = decodeId("agent", parsed.data.agent_id);
  if (!agentId) throw new HumanAgentOpError("resource_not_found", "Resource not found");
  return { agentId, notes: parsed.data.notes ?? null };
}
interface AssignmentRow { id: string; agent_id: string | null; assigned_at: string | null; unassigned_at: string | null; notes: string | null; }
const COLUMNS = "id, agent_id, assigned_at, unassigned_at, notes";
function publicAssignment(row: AssignmentRow) {
  return { id: `assignment_${row.id}`, agent_id: row.agent_id ? encodeId("agent", row.agent_id) : null,
    assigned_at: row.assigned_at, unassigned_at: row.unassigned_at, notes: row.notes };
}
export async function getConversationAssignment(ctx: HumanAgentContext, conversation: ModeConversation) {
  const { data, error } = await ctx.admin.from("whatsapp_conversation_assignments").select(COLUMNS)
    .eq("workspace_id", ctx.workspaceId).eq("conversation_id", conversation.conversation_id).is("unassigned_at", null).maybeSingle();
  if (error) throw new HumanAgentOpError("internal_error", "Unable to read assignment");
  if (!data) throw new HumanAgentOpError("resource_not_found", "Resource not found");
  return { assignment: publicAssignment(data) };
}
export async function writeConversationAssignment(ctx: HumanAgentContext, keyId: string, conversation: ModeConversation, body: unknown, remove: boolean) {
  const input = assignmentInput(body, remove);
  // The RPC repeats structural authority checks and locks the cache row. Close,
  // open and history are one transaction even if the insert or history fails.
  const { data, error } = await ctx.admin.rpc("partner_write_conversation_assignment", {
    p_workspace_id: ctx.workspaceId, p_key_id: keyId, p_conversation_cache_id: conversation.id,
    p_agent_id: input.agentId, p_notes: input.notes, p_unassign: remove,
  });
  if (error) throw new Error("Assignment write outcome unknown");
  if (data?.error === "resource_not_found") throw new HumanAgentOpError("resource_not_found", "Resource not found");
  if (!data?.id) throw new Error("Assignment write outcome unknown");
  return { assignment: publicAssignment(data) };
}
interface HistoryRow { id: string; action: string; from_agent_id: string | null; to_agent_id: string | null; reason: string | null; created_at: string; }
export async function listAssignmentHistory(ctx: HumanAgentContext, conversation: ModeConversation, page: PageRequest) {
  let query = ctx.admin.from("whatsapp_assignment_history").select("id, action, from_agent_id, to_agent_id, reason, created_at")
    .eq("workspace_id", ctx.workspaceId).eq("conversation_id", conversation.conversation_id)
    .not("created_at", "is", null).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(page.limit + 1);
  if (page.cursor) query = query.or(keysetFilter("created_at", page.cursor));
  const { data, error } = await query;
  if (error) throw new HumanAgentOpError("internal_error", "Unable to read assignment history");
  const rows = (data ?? []) as HistoryRow[];
  const included = rows.slice(0, page.limit), last = included.at(-1);
  return { data: included.map((row) => ({ id: `assignment_history_${row.id}`, action: row.action,
    from_agent_id: row.from_agent_id ? encodeId("agent", row.from_agent_id) : null,
    to_agent_id: row.to_agent_id ? encodeId("agent", row.to_agent_id) : null, notes: row.reason, created_at: row.created_at })),
    next_cursor: rows.length > page.limit && last ? encodeCursor({ timestamp: last.created_at, id: last.id }) : null };
}
