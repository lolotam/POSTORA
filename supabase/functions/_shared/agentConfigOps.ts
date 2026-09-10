// Account-bound automation use cases. The JWT helpers remain compatible, but
// this door takes only workspace authority and the key's bound account set.
import { parseNamedAccountId } from "./aiConfigScope.ts";
import { blankedFields, GUARDED_FIELDS } from "./configBlanking.ts";
import { parseBusinessProfile, renderBusinessProfileText } from "./businessProfileText.ts";
import { parseAgentBehavior } from "./agentBehavior.ts";
import { parseCredentialUpsertResult } from "./credentialVaultRpc.ts";
import { assertToolSharesBound, parseSetToolAccountsInput, setToolAccounts, ToolSharingError } from "./toolSharing.ts";
import { deleteAccountScopedTool, parseUpsertToolInput, ToolWriteError, upsertAccountScopedTool, type CredentialVault } from "./toolWrites.ts";
import { encodeCursor, keysetFilter, type PageRequest } from "../partner-api/v1/pagination.ts";

export interface AgentConfigContext {
  // Supabase versions differ between doors; this is the infrastructure seam.
  // deno-lint-ignore no-explicit-any
  admin: any;
  workspaceId: string;
  accountIds: string[];
  requestId: string;
  platform: string;
}
export class AgentConfigOpError extends Error {
  constructor(
    readonly code: "invalid_request" | "resource_not_found" | "internal_error",
    message: string,
    readonly status?: number,
    readonly details?: Record<string, unknown>,
  ) { super(message); }
}
const invalid = (message: string): never => { throw new AgentConfigOpError("invalid_request", message); };
const notFound = (): never => { throw new AgentConfigOpError("resource_not_found", "Resource not found"); };
const failedRead = (): never => { throw new AgentConfigOpError("internal_error", "Unable to read automation settings"); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateToolId(id: string): string {
  if (!UUID.test(id)) invalid("id must be a UUID");
  return id;
}

interface AgentAccount { id: string; platform: string; user_id: string; }
export async function resolveAgentAccount(ctx: AgentConfigContext, requested: unknown): Promise<AgentAccount> {
  const named = parseNamedAccountId(requested);
  if ("invalid" in named) invalid("account_id must be a non-empty string");
  const id = "id" in named ? named.id : ctx.accountIds.length === 1 ? ctx.accountIds[0] : null;
  if (!id) return invalid("account_id is required for a key with multiple or no bound accounts");
  // Refuse before querying a caller-named foreign account, even on a replay.
  if (!ctx.accountIds.includes(id)) notFound();
  const { data, error } = await ctx.admin.from("social_accounts")
    .select("id, platform, user_id").eq("id", id)
    .eq("workspace_id", ctx.workspaceId).eq("platform", ctx.platform).eq("is_active", true).maybeSingle();
  if (error) failedRead();
  if (!data) notFound();
  return data as AgentAccount;
}

const CONFIG_FIELDS = [
  "is_enabled", "default_mode", "persona_instructions", "business_profile_text",
  "language_mode", "model", "fallback_model_1", "fallback_model_2", "temperature",
  "admin_phone_numbers", "daily_message_cap", "reply_cooldown_seconds", "max_tool_iterations",
  "handoff_on_request", "handoff_on_low_confidence", "business_profile", "agent_behavior",
] as const;
const CONFIG_SELECT = ["id", "social_account_id", "platform", ...CONFIG_FIELDS, "created_at", "updated_at"].join(", ");

async function readConfig(ctx: AgentConfigContext, accountId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await ctx.admin.from("ai_agent_configs").select(CONFIG_SELECT)
    .eq("social_account_id", accountId).eq("platform", ctx.platform).maybeSingle();
  if (error) failedRead();
  return data ?? null;
}
export async function getAgentConfig(ctx: AgentConfigContext, requested?: unknown) {
  const account = await resolveAgentAccount(ctx, requested);
  return { account_id: account.id, config: await readConfig(ctx, account.id) };
}

async function configUpdates(ctx: AgentConfigContext, body: Record<string, unknown>) {
  if (Object.keys(body).some((key) => key !== "confirm_clear" && !(CONFIG_FIELDS as readonly string[]).includes(key))) invalid("Unknown config field");
  if ("confirm_clear" in body && typeof body.confirm_clear !== "boolean") invalid("confirm_clear must be a boolean");
  // Iterate submitted keys, never populate missing fields from defaults.
  const updates = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "confirm_clear"));
  if (!Object.keys(updates).length) invalid("Supply at least one config field");
  for (const key of ["is_enabled", "handoff_on_request", "handoff_on_low_confidence"]) {
    if (key in updates && typeof updates[key] !== "boolean") invalid(`${key} must be a boolean`);
  }
  for (const key of ["persona_instructions", "business_profile_text"]) {
    if (key in updates && updates[key] !== null && typeof updates[key] !== "string") invalid(`${key} must be text or null`);
  }
  const enums: Record<string, readonly string[]> = { default_mode: ["ai_first", "human_first", "human_then_ai"], language_mode: ["auto", "ar", "en"] };
  for (const [key, values] of Object.entries(enums)) {
    if (key in updates && (typeof updates[key] !== "string" || !values.includes(updates[key] as string))) invalid(`Invalid ${key}`);
  }
  for (const key of ["daily_message_cap", "reply_cooldown_seconds", "max_tool_iterations"]) {
    if (key in updates && (!Number.isInteger(updates[key]) || Number(updates[key]) < 0)) invalid(`${key} must be a non-negative integer`);
  }
  if ("temperature" in updates && (typeof updates.temperature !== "number" || !Number.isFinite(updates.temperature) || updates.temperature < 0 || updates.temperature > 2)) invalid("temperature must be between 0 and 2");
  if ("admin_phone_numbers" in updates) {
    if (!Array.isArray(updates.admin_phone_numbers)) invalid("admin_phone_numbers must be an array");
    updates.admin_phone_numbers = (updates.admin_phone_numbers as unknown[]).map((value) => {
      if (typeof value !== "string" || !value.trim().startsWith("+")) invalid("Invalid admin phone number");
      const normalized = `+${(value as string).trim().slice(1).replace(/[\s-]/g, "")}`;
      if (!/^\+[1-9]\d{1,14}$/.test(normalized)) invalid("Invalid admin phone number");
      return normalized;
    });
  }
  try {
    if ("business_profile" in updates) {
      updates.business_profile = parseBusinessProfile(updates.business_profile);
      updates.business_profile_text = renderBusinessProfileText(updates.business_profile as ReturnType<typeof parseBusinessProfile>);
    } else if ("business_profile_text" in updates) {
      const text = String(updates.business_profile_text ?? "");
      updates.business_profile = text.trim() ? { notes: text } : {};
    }
    if ("agent_behavior" in updates) updates.agent_behavior = parseAgentBehavior(updates.agent_behavior);
  } catch { invalid("Invalid structured agent profile or behavior"); }
  const modelFields = ["model", "fallback_model_1", "fallback_model_2"].filter((key) => key in updates);
  if (modelFields.length) {
    const { data, error } = await ctx.admin.from("ai_agent_allowed_models").select("provider, model_id").eq("is_active", true);
    if (error) failedRead();
    const allowed = new Set<string>();
    for (const row of data ?? []) { allowed.add(row.model_id); allowed.add(`${row.provider}/${row.model_id}`); }
    for (const field of modelFields) {
      const value = updates[field];
      if ((value === null || value === "") && field !== "model") updates[field] = null;
      else if (typeof value !== "string" || !allowed.has(value)) invalid(`${field} is not an allowed model`);
    }
  }
  return updates;
}

export async function updateAgentConfig(ctx: AgentConfigContext, requested: unknown, body: Record<string, unknown>) {
  const account = await resolveAgentAccount(ctx, requested);
  const updates = await configUpdates(ctx, body);
  // Even confirmed clears must fail closed if the read fails.
  const stored = await readConfig(ctx, account.id);
  const blanked = blankedFields(updates, stored);
  if (blanked.length && body.confirm_clear !== true) {
    throw new AgentConfigOpError("invalid_request", "Re-send with confirm_clear to deliberately erase protected fields", 409, { blanked_fields: blanked });
  }
  let query = stored
    ? ctx.admin.from("ai_agent_configs").update(updates).eq("id", stored.id)
      .eq("social_account_id", account.id).eq("platform", account.platform)
    // Insert, not upsert: a concurrent first save must never overwrite a persona
    // that did not exist when this request checked the blanking guard.
    : ctx.admin.from("ai_agent_configs").insert({ ...updates, social_account_id: account.id, platform: account.platform, user_id: account.user_id });
  // Fence the guard's snapshot without putting potentially large persona text
  // in the PostgREST URL. The table's update trigger maintains this timestamp.
  if (stored && body.confirm_clear !== true && GUARDED_FIELDS.some((key) => key in updates)) {
    if (typeof stored.updated_at !== "string") failedRead();
    query = query.eq("updated_at", stored.updated_at);
  }
  const { data, error } = await query.select(CONFIG_SELECT).single();
  if (error || !data) throw new Error("Config write outcome unknown");
  return { account_id: account.id, config: data };
}

async function workspaceAccountIds(ctx: AgentConfigContext, requested?: unknown): Promise<string[]> {
  const named = parseNamedAccountId(requested);
  if ("invalid" in named) invalid("Invalid account_id");
  if ("id" in named && !ctx.accountIds.includes(named.id)) notFound();
  const ids = "id" in named ? [named.id] : ctx.accountIds;
  if (!ids.length) return [];
  const { data, error } = await ctx.admin.from("social_accounts").select("id")
    .eq("workspace_id", ctx.workspaceId).eq("platform", ctx.platform).in("id", ids);
  if (error) failedRead();
  if ("id" in named && !data?.length) notFound();
  return (data ?? []).map((row: { id: string }) => row.id);
}
function safeTool(row: Record<string, unknown>): Record<string, unknown> {
  const { secret, credentials_secret_id: _vault, user_id: _owner, ...tool } = row;
  return { ...tool, account_id: row.social_account_id, has_secret: !!secret || !!_vault };
}
export async function listAgentTools(ctx: AgentConfigContext, requested: unknown, page: PageRequest) {
  const ids = await workspaceAccountIds(ctx, requested);
  if (!ids.length) return { data: [], next_cursor: null };
  let query = ctx.admin.from("ai_agent_tools").select("*").eq("scope", "account")
    .in("social_account_id", ids).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(page.limit + 1);
  if (page.cursor) query = query.or(keysetFilter("created_at", page.cursor));
  const { data, error } = await query;
  if (error) failedRead();
  const rows = data ?? [];
  const selected = rows.slice(0, page.limit);
  const last = selected.at(-1);
  return { data: selected.map(safeTool), next_cursor: rows.length > page.limit && last ? encodeCursor({ timestamp: last.created_at, id: last.id }) : null };
}

export async function resolveAgentTool(ctx: AgentConfigContext, id: string, requested?: unknown, allowMissing = false) {
  validateToolId(id);
  const ids = await workspaceAccountIds(ctx, requested);
  const { data, error } = await ctx.admin.from("ai_agent_tools").select("id, social_account_id")
    .eq("id", id).eq("scope", "account").in("social_account_id", ids).maybeSingle();
  if (error) failedRead();
  if (!data && !allowMissing) notFound();
  if (data) await assertToolSharesBound(ctx.admin, id, ctx);
  return data as { id: string; social_account_id: string } | null;
}

/** A shared tool can affect agents on other platforms. Each affected surface
 * needs the SAME action's entitlement, before an idempotency claim or mutation. */
export async function agentToolAffectedPlatforms(ctx: AgentConfigContext, id: string, requested: unknown, targets: string[]) {
  if (targets.some((target) => !ctx.accountIds.includes(target))) notFound();
  const tool = await resolveAgentTool(ctx, id, requested, true);
  const affected = new Set(targets);
  if (typeof requested === "string") affected.add(requested);
  if (tool) {
    affected.add(tool.social_account_id);
    const { data, error } = await ctx.admin.from("ai_agent_tool_accounts")
      .select("social_account_id").eq("tool_id", id);
    if (error) failedRead();
    for (const row of data ?? []) affected.add(row.social_account_id);
  }
  if (!affected.size) return [];
  if ([...affected].some((target) => !ctx.accountIds.includes(target))) notFound();
  const { data, error } = await ctx.admin.from("social_accounts").select("id, platform")
    .eq("workspace_id", ctx.workspaceId).in("id", [...affected]);
  if (error) failedRead();
  if (data?.length !== affected.size) notFound();
  return [...new Set<string>(data.map((row: { platform: string }) => row.platform))];
}
function vault(ctx: AgentConfigContext): CredentialVault {
  return {
    async upsertCredentials(secretId, blob) {
      const { data, error } = await ctx.admin.rpc("upsert_connector_credential_secret", { p_secret_id: secretId, p_secret: blob });
      if (error) throw new Error("Credential write outcome unknown");
      return parseCredentialUpsertResult(data);
    },
    async deleteCredentials(secretId) {
      const { error } = await ctx.admin.rpc("delete_connector_credential_secret", { p_secret_id: secretId });
      if (error) throw new Error("Credential delete outcome unknown");
    },
  };
}
export async function upsertAgentTool(ctx: AgentConfigContext, id: string, requested: unknown, body: Record<string, unknown>) {
  const account = await resolveAgentAccount(ctx, requested);
  await resolveAgentTool(ctx, id, account.id, true);
  const allowed = ["name", "description", "url", "connector_type", "connection_id", "permissions", "is_enabled", "admin_only", "read_only_mode", "enable_cache", "secret", "clear_secret", "credentials"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid("Unknown tool field");
  const input = parseUpsertToolInput({ tool: { ...body, social_account_id: account.id } });
  let tool: Record<string, unknown>;
  try {
    tool = await upsertAccountScopedTool(ctx.admin, vault(ctx), { workspaceId: ctx.workspaceId, accountIds: ctx.accountIds, toolId: id, input });
  } catch (error) {
    // A uniqueness refusal can follow a successful credential merge. Do not
    // settle it as a definite no-write and invite a second Vault mutation.
    if (error instanceof ToolWriteError && error.status === 409) throw new Error("Tool write outcome unknown");
    throw error;
  }
  const { user_id: _owner, ...safe } = tool;
  return { tool: { ...safe, account_id: account.id, has_secret: tool.has_secret === true || (Array.isArray(tool.configured_secret_fields) && tool.configured_secret_fields.length > 0) } };
}
export async function deleteAgentTool(ctx: AgentConfigContext, id: string, requested?: unknown) {
  await resolveAgentTool(ctx, id, requested);
  await deleteAccountScopedTool(ctx.admin, vault(ctx), { workspaceId: ctx.workspaceId, accountIds: ctx.accountIds, toolId: id });
  return { success: true };
}
export async function setAgentToolAccounts(ctx: AgentConfigContext, id: string, requested: unknown, body: Record<string, unknown>) {
  if (Object.keys(body).some((key) => key !== "social_account_ids")) invalid("Unknown sharing field");
  const input = parseSetToolAccountsInput({ ...body, tool_id: id });
  // The parser's omitted-list semantics are intentional: replace with no shares.
  if (input.socialAccountIds.some((accountId) => !ctx.accountIds.includes(accountId))) notFound();
  await resolveAgentTool(ctx, id, requested);
  await setToolAccounts(ctx.admin, { workspaceId: ctx.workspaceId, accountIds: ctx.accountIds, input });
  return { success: true };
}

export function agentConfigFailure(error: unknown): AgentConfigOpError | null {
  if (error instanceof AgentConfigOpError) return error;
  if (error instanceof ToolSharingError || error instanceof ToolWriteError) {
    return new AgentConfigOpError(error.status === 404 || error.status === 403 ? "resource_not_found" : "invalid_request", "Automation request refused", error.status === 403 ? 404 : error.status);
  }
  return null;
}
