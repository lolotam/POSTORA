// Workspace-level WhatsApp reads. Unlike WhatsAppOpsContext, this context
// spans bound accounts, including numbers without a resolved identity/token.
// Results are transport-neutral; each door renders and logs its own refusals
// (the /v1 door records every authenticated outcome through withPartnerAuth).

import { keysetFilter, LIMIT_DEFAULT, paginate, type PageRequest } from "../partner-api/v1/pagination.ts";

export interface WhatsAppNumberContext {
  // Supabase client versions differ between Edge Functions (infrastructure seam).
  // deno-lint-ignore no-explicit-any
  admin: any;
  workspaceId: string;
  accountIds: string[];
  requestId: string;
}

export interface WhatsAppNumber {
  account_id: string;
  phone_number: string | null;
  display_name: string | null;
  connection_mode: string | null;
  status: "connected" | "disconnected" | "pending";
  connected_at: string | null;
}

interface NumberRow {
  id: string;
  platform_user_id: string | null;
  platform_username: string | null;
  connection_mode: string | null;
  account_metadata: Record<string, unknown> | null;
  is_active: boolean;
  connected_at: string | null;
  updated_at: string;
}

const NUMBER_COLUMNS = "id, platform_user_id, platform_username, connection_mode, " +
  "account_metadata, is_active, connected_at, updated_at";

function present(row: NumberRow): WhatsAppNumber {
  const meta = row.account_metadata ?? {};
  const mode = row.connection_mode ??
    (typeof meta.connection_mode === "string" ? meta.connection_mode : null);
  const rawId = row.platform_user_id ?? "";
  const resolved = Boolean(rawId) && !rawId.startsWith("pending_");
  // Direct QR stores a label in platform_username. Meta stores an opaque id
  // in platform_user_id, and the human number in display_phone_number.
  const phoneNumber = !resolved ? null : mode === "evolution_qr" ? rawId :
    (typeof meta.display_phone_number === "string" ? meta.display_phone_number : null);
  return {
    account_id: row.id,
    phone_number: phoneNumber,
    display_name: typeof meta.display_name === "string" ? meta.display_name : row.platform_username,
    connection_mode: mode,
    // Reconciliation can activate a row before replacing its placeholder.
    status: !resolved ? "pending" : row.is_active ? "connected" : "disconnected",
    connected_at: row.connected_at,
  };
}

export async function listWhatsAppNumbers(
  ctx: WhatsAppNumberContext,
  page: PageRequest = { limit: LIMIT_DEFAULT, cursor: null },
): Promise<
  | { ok: true; numbers: WhatsAppNumber[]; nextCursor: string | null }
  | { ok: false; reason: "read_failed" }
> {
  if (ctx.accountIds.length === 0) return { ok: true, numbers: [], nextCursor: null };
  let query = ctx.admin.from("social_accounts")
    .select(NUMBER_COLUMNS)
    .eq("workspace_id", ctx.workspaceId)
    .eq("platform", "whatsapp")
    .in("id", ctx.accountIds)
    // Connection transitions change updated_at but leave connected_at alone.
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(page.limit + 1);
  // One OR group: a second .or() would replace the first (PR #35).
  if (page.cursor) query = query.or(keysetFilter("updated_at", page.cursor));
  const { data, error } = await query;
  if (error) return { ok: false, reason: "read_failed" };

  const { page: visible, nextCursor } = paginate<NumberRow>(data ?? [], page.limit,
    (row) => ({ timestamp: row.updated_at, id: row.id }));
  return { ok: true, numbers: visible.map(present), nextCursor };
}

export async function getWhatsAppNumber(
  ctx: WhatsAppNumberContext,
  accountId: string,
): Promise<{ ok: true; number: WhatsAppNumber } | { ok: false; reason: "read_failed" | "not_found" }> {
  // Do not query an unbound id: even lookup timing can disclose existence.
  if (!ctx.accountIds.includes(accountId)) return { ok: false, reason: "not_found" };
  const { data, error } = await ctx.admin.from("social_accounts")
    .select(NUMBER_COLUMNS)
    .eq("workspace_id", ctx.workspaceId)
    .eq("platform", "whatsapp")
    .eq("id", accountId)
    .maybeSingle();
  if (error) return { ok: false, reason: "read_failed" };
  if (!data) return { ok: false, reason: "not_found" };
  return { ok: true, number: present(data) };
}
