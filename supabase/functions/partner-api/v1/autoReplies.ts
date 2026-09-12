// These legacy tables are owner-wide. account_id resolves persistence
// ownership; it does not restrict which of that owner's accounts fire a rule.
import { AgentConfigOpError, resolveAgentAccount, validateToolId, type AgentConfigContext } from "../../_shared/agentConfigOps.ts";
import { keysetFilter, paginate, type PageRequest } from "./pagination.ts";
import { validateRulePlatform } from "./conversationModes.ts";

const RULE_FIELDS = ["name", "rule_type", "keywords", "reply_message", "is_active", "schedule_start", "schedule_end", "schedule_days"] as const;
const RULE_COLUMNS = ["id", ...RULE_FIELDS, "created_at", "updated_at"].join(", ");
type Rule = Record<string, unknown> & { id: string; created_at: string };
export type AutoReplyOwner = Awaited<ReturnType<typeof resolveAgentAccount>>;
function table(ctx: AgentConfigContext) {
  validateRulePlatform(ctx.platform);
  return ctx.platform === "whatsapp" ? "whatsapp_auto_replies" : "messenger_auto_replies";
}
// Supabase's builder type varies with the self-hosted client version.
// deno-lint-ignore no-explicit-any
function scoped(query: any, ctx: AgentConfigContext, owner: AutoReplyOwner) {
  query = query.eq("user_id", owner.user_id);
  return ctx.platform === "whatsapp" ? query : query.eq("platform", ctx.platform);
}
function presentRule(row: Rule, platform: string) {
  return Object.fromEntries([
    ["id", row.id], ["platform", platform],
    ...RULE_FIELDS.map((key) => [key, row[key] ?? null]),
    ["created_at", row.created_at ?? null], ["updated_at", row.updated_at ?? null],
  ]);
}
function rulePatch(body: Record<string, unknown>, create: boolean) {
  const invalid = (): never => { throw new AgentConfigOpError("invalid_request", "Invalid auto-reply rule"); };
  if (!Object.keys(body).length || Object.keys(body).some((key) => !(RULE_FIELDS as readonly string[]).includes(key))) invalid();
  if (create && ["name", "rule_type", "reply_message"].some((key) => !(key in body))) invalid();
  for (const key of ["name", "reply_message"]) if (key in body && (typeof body[key] !== "string" || !String(body[key]).trim())) invalid();
  if ("rule_type" in body && !["away", "keyword"].includes(String(body.rule_type))) invalid();
  if ("is_active" in body && typeof body.is_active !== "boolean") invalid();
  if ("keywords" in body && body.keywords !== null && (!Array.isArray(body.keywords) || body.keywords.some((value) => typeof value !== "string"))) invalid();
  for (const key of ["schedule_start", "schedule_end"]) {
    if (key in body && body[key] !== null && (typeof body[key] !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(body[key])))) invalid();
  }
  if ("schedule_days" in body && body.schedule_days !== null && (!Array.isArray(body.schedule_days) || body.schedule_days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) invalid();
  return body;
}
export async function listAutoReplies(ctx: AgentConfigContext, requested: unknown, page: PageRequest) {
  const owner = await resolveAgentAccount(ctx, requested);
  let query = scoped(ctx.admin.from(table(ctx)).select(RULE_COLUMNS), ctx, owner)
    .not("created_at", "is", null)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(page.limit + 1);
  if (page.cursor) query = query.or(keysetFilter("created_at", page.cursor));
  const { data, error } = await query;
  if (error) throw new AgentConfigOpError("internal_error", "Unable to read auto-replies");
  const result = paginate((data ?? []) as Rule[], page.limit, (row) => ({ timestamp: row.created_at, id: row.id }));
  return { data: result.page.map((row) => presentRule(row, ctx.platform)), next_cursor: result.nextCursor };
}
export async function writeAutoReply(ctx: AgentConfigContext, owner: AutoReplyOwner, action: "create_auto_reply" | "update_auto_reply" | "delete_auto_reply", id: string | undefined, body: Record<string, unknown>) {
  const name = table(ctx);
  if (action !== "create_auto_reply") {
    validateToolId(id ?? "");
    const { data, error } = await scoped(ctx.admin.from(name).select("id").eq("id", id), ctx, owner).maybeSingle();
    if (error) throw new AgentConfigOpError("internal_error", "Unable to read auto-reply");
    if (!data) throw new AgentConfigOpError("resource_not_found", "Resource not found");
  }
  if (action === "delete_auto_reply") {
    if (Object.keys(body).length) throw new AgentConfigOpError("invalid_request", "DELETE does not accept rule fields");
    const { error } = await scoped(ctx.admin.from(name).delete().eq("id", id), ctx, owner);
    if (error) throw new Error("Auto-reply delete outcome unknown");
    return { success: true };
  }
  const patch = rulePatch(body, action === "create_auto_reply");
  const query = action === "create_auto_reply"
    ? ctx.admin.from(name).insert({ ...patch, user_id: owner.user_id, ...(ctx.platform === "whatsapp" ? {} : { platform: ctx.platform }) })
    : scoped(ctx.admin.from(name).update(patch).eq("id", id), ctx, owner);
  const { data, error } = await query.select(RULE_COLUMNS).single();
  if (error || !data) throw new Error("Auto-reply write outcome unknown");
  return { rule: presentRule(data, ctx.platform) };
}
