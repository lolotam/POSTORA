// Account scoping for the ai_agent_config actions.
//
// messaging-api runs its database work with the service role, so RLS is not
// checking ownership here -- an id from the request body is only ever
// accepted after it is matched against the caller's own accounts on the
// requested platform. Extracted from index.ts so the refusal table and the
// write decisions can be tested against a fake client at the database
// boundary. ai-knowledge-ingest and ai-agent-reply resolve accounts through
// these same definitions rather than growing local variants.

// Minimal structural seam over the service-role client, in the register of
// _shared/whatsappWorkspaceAccess.ts: only the surface these functions use.
// `then` exists because resolveConfigWriteAccount awaits the builder itself
// (the list path, no maybeSingle/single terminator).
export interface ConfigScopeQuery {
  // Optional because the write path calls .select() bare after update/upsert.
  select(columns?: string): ConfigScopeQuery;
  eq(column: string, value: unknown): ConfigScopeQuery;
  update(values: Record<string, unknown>): ConfigScopeQuery;
  upsert(values: Record<string, unknown>, options?: { onConflict: string }): ConfigScopeQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
  single(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
  then(
    onfulfilled: (value: { data: Array<Record<string, unknown>> | null; error: unknown }) => unknown,
    onrejected: (reason: unknown) => unknown,
  ): PromiseLike<unknown>;
}

export interface AdminClient {
  from(table: string): ConfigScopeQuery;
}

export type NamedAccountId = { absent: true } | { id: string } | { invalid: true };

/**
 * Separates "no account named" from a malformed id.
 *
 * "", 0 and false are not "no account named": treating them as unnamed
 * silently reinterprets a caller bug as the unscoped path, which then
 * resolves against a different account than the caller thought they named.
 */
export function parseNamedAccountId(requested: unknown): NamedAccountId {
  if (requested === undefined || requested === null) return { absent: true };
  if (typeof requested === "string" && requested.trim()) return { id: requested.trim() };
  return { invalid: true };
}

function rowId(data: Record<string, unknown> | null): string | null {
  return data && typeof data.id === "string" ? data.id : null;
}

/**
 * The caller's own account with this id on this platform, or null when none
 * was supplied or nothing matches.
 *
 * is_active is filtered only when the caller asks for it. Reading a
 * deactivated account's config is legitimate; writing through a stale id is
 * not, so the write path passes requireActive and the read path does not.
 * The original rule -- this resolves an account the caller NAMED. A WhatsApp QR reconnect deactivates the old row, and the
 * operator must still be able to read and fix that account's config before
 * or while reconnecting it. The path where the server chooses an account on
 * the caller's behalf (resolveConfigWriteAccount) is the one that must never
 * choose a dead row, and that is where the is_active requirement lives.
 */
export async function resolveOwnedAccountId(
  adminClient: AdminClient,
  userId: string,
  platform: string,
  requested: string,
  options: { requireActive?: boolean } = {},
): Promise<string | null> {
  let query = adminClient
    .from("social_accounts")
    .select("id")
    .eq("id", requested)
    .eq("user_id", userId)
    .eq("platform", platform);
  if (options.requireActive) query = query.eq("is_active", true);
  const { data } = await query.maybeSingle();
  return rowId(data);
}

export type ConfigWriteScope = { accountId: string } | { error: string };

/**
 * Which account a config write with no named account belongs to.
 *
 * The write path keys on social_account_id, so it always needs an account.
 * A caller naming none -- a cached old frontend during the rollout window --
 * is resolved against the owner's active accounts on the platform: exactly
 * one is unambiguous, and while UNIQUE (user_id, platform) still stands a
 * scoped write onto that single account is equivalent to the old unscoped
 * one. Zero or several cannot be chosen for the caller, because guessing
 * would either attach the wrong brand's persona to an account or write onto
 * a dead one, and both are worse than a refused save. is_active is required
 * HERE precisely because the server is choosing, unlike the named path
 * above.
 */
export async function resolveConfigWriteAccount(
  adminClient: AdminClient,
  userId: string,
  platform: string,
): Promise<ConfigWriteScope> {
  const { data } = await adminClient
    .from("social_accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("platform", platform)
    .eq("is_active", true);
  const accounts = data ?? [];
  if (accounts.length !== 1) return { error: "social_account_id is required" };
  const onlyId = rowId(accounts[0]);
  return onlyId ? { accountId: onlyId } : { error: "social_account_id is required" };
}

export interface ScopedConfigWrite {
  userId: string;
  platform: string;
  accountId: string;
  updates: Record<string, unknown>;
}

/**
 * Writes a named account's config: the row-level decision the upsert action
 * takes, extracted so the row it would write can be asserted directly.
 *
 * Correct in both schema states, which is the whole difficulty. While
 * ai_agent_configs_user_id_platform_key stands a platform holds at most one
 * config; once it is dropped it holds one per account. So this reads the
 * platform's configs as a LIST -- maybeSingle() would turn the post-drop case
 * into a multiple-rows error and fail every save -- updates the account's own
 * row when it has one, and otherwise inserts.
 *
 * It deliberately never MOVES an existing config onto a different account. An
 * earlier draft re-pointed the platform's sole config when the account holding
 * it was inactive, reasoning that this was the QR-reconnect repair. It is not:
 * "the other account is inactive" is no evidence that this account replaced
 * it, so a temporarily deactivated page would have had its persona silently
 * stolen by an unrelated sibling. Nothing here can distinguish the two, so it
 * refuses instead -- and the 23505 the legacy constraint raises is translated
 * into what is actually true, that the platform still shares one agent. The
 * contract migration clones every account its own row and ends the ambiguity.
 */
export async function writeAccountScopedConfig(
  adminClient: AdminClient,
  write: ScopedConfigWrite,
): Promise<{ data: Record<string, unknown> | null; error: unknown }> {
  const { data: rows, error: readError } = await adminClient
    .from("ai_agent_configs")
    .select("id, social_account_id")
    .eq("user_id", write.userId)
    .eq("platform", write.platform);
  if (readError) return { data: null, error: readError };

  const own = (rows ?? []).find((row) => row.social_account_id === write.accountId);
  const ownId = own ? rowId(own) : null;
  if (ownId) {
    const { data, error } = await adminClient
      .from("ai_agent_configs")
      .update(write.updates)
      .eq("id", ownId)
      .select()
      .single();
    return { data, error };
  }

  const { data, error } = await adminClient
    .from("ai_agent_configs")
    .upsert(
      { user_id: write.userId, platform: write.platform, social_account_id: write.accountId, ...write.updates },
      { onConflict: "social_account_id" },
    )
    .select()
    .single();
  if (error && String((error as { code?: string }).code) === "23505") {
    return {
      data: null,
      error: {
        message:
          "This platform still shares one agent across its accounts. Per-account settings unlock once the account migration completes.",
      },
    };
  }
  return { data, error };
}
