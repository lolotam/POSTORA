// Workspace authority only. Auth owns service identities, the provisioning RPC
// owns membership + agent rows, and the HTTP door owns idempotency and usage.
// deno-lint-ignore no-import-prefix
import { z } from "npm:zod@3.23.8";
import { decodeId, encodeId } from "../partner-api/v1/ids.ts";
import { keysetFilter, paginate, type PageRequest } from "../partner-api/v1/pagination.ts";
import { logToDatabase } from "./logging.ts";

export interface HumanAgentContext {
  // Supabase client versions differ between doors (infrastructure seam).
  // deno-lint-ignore no-explicit-any
  admin: any;
  workspaceId: string;
  requestId: string;
}
export class HumanAgentOpError extends Error {
  constructor(readonly code: "invalid_request" | "resource_not_found" | "internal_error", message: string, readonly status?: number) { super(message); }
}
const fields = {
  display_name: z.string().trim().min(1).max(200),
  max_conversations: z.number().int().min(1).max(2147483647),
};
const createSchema = z.object({ ...fields, max_conversations: fields.max_conversations.default(10) }).strict();
const patchSchema = z.object({ ...fields, status: z.enum(["online", "away", "offline"]) }).partial().strict()
  .refine((body) => Object.keys(body).length > 0, "Supply at least one agent field");
export function agentInput(body: unknown, create: boolean) {
  const parsed = (create ? createSchema : patchSchema).safeParse(body);
  if (!parsed.success) throw new HumanAgentOpError("invalid_request", "Invalid agent fields");
  return parsed.data;
}
interface AgentRow {
  id: string; display_name: string; status: string; max_conversations: number | null;
  current_conversations: number | null; last_seen_at: string | null; created_at: string | null; updated_at: string | null;
}
const COLUMNS = "id, display_name, status, max_conversations, current_conversations, last_seen_at, created_at, updated_at";
function publicAgent(row: AgentRow) {
  return {
    id: encodeId("agent", row.id), display_name: row.display_name, status: row.status,
    max_conversations: row.max_conversations, current_conversations: row.current_conversations,
    last_seen_at: row.last_seen_at, created_at: row.created_at, updated_at: row.updated_at,
  };
}
const notFound = (): never => { throw new HumanAgentOpError("resource_not_found", "Resource not found"); };
function agentId(id: string): string { return decodeId("agent", id) ?? notFound(); }
export async function getHumanAgent(ctx: HumanAgentContext, id: string) {
  const { data, error } = await ctx.admin.from("whatsapp_agents").select(COLUMNS)
    .eq("workspace_id", ctx.workspaceId).eq("id", agentId(id)).maybeSingle();
  if (error) throw new HumanAgentOpError("internal_error", "Unable to read agent");
  if (!data) notFound();
  return { agent: publicAgent(data) };
}
export async function listHumanAgents(ctx: HumanAgentContext, page: PageRequest) {
  let query = ctx.admin.from("whatsapp_agents").select(COLUMNS).eq("workspace_id", ctx.workspaceId)
    .not("created_at", "is", null).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(page.limit + 1);
  if (page.cursor) query = query.or(keysetFilter("created_at", page.cursor));
  const { data, error } = await query;
  if (error) throw new HumanAgentOpError("internal_error", "Unable to read agents");
  const result = paginate<AgentRow>(data ?? [], page.limit, (row) => ({ timestamp: row.created_at!, id: row.id }));
  return { data: result.page.map(publicAgent), next_cursor: result.nextCursor };
}

async function recoveryLog(ctx: HumanAgentContext, identityId: string | null, attemptId: string, reason: string) {
  await logToDatabase(ctx.admin, { level: "error", category: "auth", source: "partner-api",
    message: "Partner agent identity recovery", metadata: { event: "partner_agent_recovery", workspace_id: ctx.workspaceId,
      request_id: ctx.requestId, identity_id: identityId, provisioning_attempt_id: attemptId, reason } });
}
/** A lost RPC response is not a rollback. Read by workspace authority, never by
 * user authority. Exact count proves the bounded result is complete; a larger
 * workspace or an unavailable count requires reconciliation, not deletion. */
async function recoverIdentity(ctx: HumanAgentContext, identityId: string, attemptId: string): Promise<boolean> {
  try {
    const { data, error, count } = await ctx.admin.from("whatsapp_agents").select("id, user_id", { count: "exact" })
      .eq("workspace_id", ctx.workspaceId).limit(1000);
    if (error) { await recoveryLog(ctx, identityId, attemptId, "outcome_unknown"); return false; }
    if (data?.some((row: { user_id: string }) => row.user_id === identityId)) {
      await recoveryLog(ctx, identityId, attemptId, "response_lost"); return false;
    }
    if (!Array.isArray(data) || count !== data.length) {
      await recoveryLog(ctx, identityId, attemptId, "incomplete_recovery_read"); return false;
    }
    const { error: cleanupError } = await ctx.admin.auth.admin.deleteUser(identityId);
    await recoveryLog(ctx, identityId, attemptId, cleanupError ? "compensation_failed" : "rolled_back");
    return !cleanupError;
  } catch {
    await recoveryLog(ctx, identityId, attemptId, "recovery_failed"); return false;
  }
}
export async function createHumanAgent(ctx: HumanAgentContext, body: unknown, attemptId: string) {
  const input = createSchema.safeParse(body);
  if (!input.success) throw new HumanAgentOpError("invalid_request", "Invalid agent fields");
  let identityId: string | null = null;
  try {
    const { data, error } = await ctx.admin.auth.admin.createUser({
      email: `svc+${attemptId}@partner.postora.cloud`, email_confirm: false,
      user_metadata: { partner_service_account: true, workspace_id: ctx.workspaceId, provisioning_attempt_id: attemptId, purpose: "human_agent" },
    });
    identityId = data?.user?.id ?? null;
    if (error || !identityId) throw new Error("Identity creation outcome unknown");
    const { data: agent, error: provisionError } = await ctx.admin.rpc("provision_partner_agent", {
      p_workspace_id: ctx.workspaceId, p_user_id: identityId,
      p_display_name: input.data.display_name, p_max_conversations: input.data.max_conversations,
    });
    if (provisionError || !agent?.id) throw new Error("Agent provisioning outcome unknown");
    return { agent: publicAgent(agent) };
  } catch {
    if (identityId && await recoverIdentity(ctx, identityId, attemptId)) {
      throw new HumanAgentOpError("internal_error", "Agent provisioning failed");
    }
    if (!identityId) await recoveryLog(ctx, null, attemptId, "identity_creation_unresolved");
    throw new Error("Agent provisioning requires reconciliation");
  }
}
export async function updateHumanAgent(ctx: HumanAgentContext, id: string, body: unknown) {
  const patch = agentInput(body, false);
  await getHumanAgent(ctx, id);
  const { data, error } = await ctx.admin.from("whatsapp_agents").update(patch)
    .eq("workspace_id", ctx.workspaceId).eq("id", agentId(id)).select(COLUMNS).maybeSingle();
  if (error) throw new Error("Agent update outcome unknown");
  if (!data) notFound();
  return { agent: publicAgent(data) };
}
const assigned = (): never => { throw new HumanAgentOpError("invalid_request", "Agent has retained conversation assignments and cannot be deleted", 409); };
export async function deleteHumanAgent(ctx: HumanAgentContext, id: string) {
  await getHumanAgent(ctx, id);
  // Deliberately NOT filtered by workspace. getHumanAgent above already proved
  // this agent belongs to the caller's workspace, and agent_id is a uuid, so
  // this is tenant-safe without it -- while a workspace predicate would miss
  // the legacy rows that still hold a null workspace_id until the contract
  // migration lands. Those are exactly the live assignments a blind delete
  // would orphan. Ended assignments also retain the agent; only separate
  // whatsapp_assignment_history rows do not block deletion.
  const { data: assignments, error: readError } = await ctx.admin.from("whatsapp_conversation_assignments").select("id")
    .eq("agent_id", agentId(id)).limit(1);
  if (readError) throw new HumanAgentOpError("internal_error", "Unable to read agent assignments");
  if (assignments?.length) assigned();
  const { data, error } = await ctx.admin.from("whatsapp_agents").delete()
    .eq("workspace_id", ctx.workspaceId).eq("id", agentId(id)).select("id").maybeSingle();
  // NO ACTION also protects assignments committed after the pre-read.
  if (error?.code === "23503") assigned();
  if (error) throw new Error("Agent deletion outcome unknown");
  if (!data) notFound();
  // Delete only the agent profile. Auth and membership may belong to a browser
  // user, so this operation must never prune either as an incidental cascade.
  return { success: true };
}
