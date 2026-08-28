// Which connected account an AI reply request belongs to.
//
// ai-agent-reply is invoked with the service role, which bypasses RLS, so the
// account id on the request cannot be trusted on its own. Extracted from
// index.ts so the refusal table can be tested against a fake client at the
// database boundary.

// Minimal structural seam over the service-role client, in the register of
// _shared/whatsappWorkspaceAccess.ts: only the surface this function uses.
export interface AccountByIdQuery {
  select(columns: string): AccountByIdQuery;
  eq(column: string, value: unknown): AccountByIdQuery;
  maybeSingle(): Promise<{ data: { id: string } | null; error: unknown }>;
}

export interface AdminClient {
  from(table: string): AccountByIdQuery;
}

// The authenticated test sandbox has no connected account behind it and sends
// this placeholder. Treated as "no account scope": config and knowledge fall
// back to the user-wide rows so the sandbox keeps working, rather than
// resolving a UUID that does not exist.
export const SANDBOX_ACCOUNT_ID = "test";

export interface AccountScopedRequest {
  social_account_id?: string | null;
  user_id: string;
  platform: string;
}

/**
 * The connected account this reply belongs to, or null for the sandbox.
 *
 * Resolved by id AND owner AND platform, and a mismatch resolves to null
 * rather than to someone else's account. The platform filter is the point:
 * without it, an internal request naming platform "instagram" with a
 * Facebook account id resolved fine and then loaded the Facebook persona
 * for an Instagram customer -- same owner, wrong brand.
 */
export async function resolveAgentAccountId(
  admin: AdminClient,
  request: AccountScopedRequest,
): Promise<string | null> {
  if (!request.social_account_id || request.social_account_id === SANDBOX_ACCOUNT_ID) return null;
  const { data: account } = await admin
    .from("social_accounts")
    .select("id")
    .eq("id", request.social_account_id)
    .eq("user_id", request.user_id)
    .eq("platform", request.platform)
    .maybeSingle();
  return account?.id ?? null;
}
