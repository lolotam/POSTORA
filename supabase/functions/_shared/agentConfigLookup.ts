// Which agent config answers for a connected account.
//
// Two callers need the same answer and must not drift: ai-agent-reply decides
// whether an inbound message gets a reply, and messaging-api's ai_get_config
// decides what the settings form renders. When they disagreed on 2026-08-28 the
// form rendered empty while a real persona sat in the row behind it, and every
// save wrote the blank form's defaults over it.

export interface AgentConfigScope {
  userId: string;
  platform: string;
  /** The connected account, or null for a caller that names none (the sandbox,
   *  and the settings form until it learns to pass one). */
  accountId: string | null;
}

/**
 * The account's own config, or failing that the owner's config for the platform
 * whatever account it is bound to.
 *
 * The second lookup is not a leak: `ai_agent_configs_user_id_platform_key` still
 * allows exactly one config per (owner, platform), so "some other account's
 * config" and "this owner's only config for this platform" are the same row.
 * Refusing it does not protect a brand voice, it silences the agent -- which is
 * what a WhatsApp QR reconnect did, since relinking inserts a NEW
 * social_accounts row and leaves the config pinned to the dead one.
 *
 * The day that constraint is dropped, a platform can hold several configs and
 * this fallback becomes a genuine cross-account read. It must be deleted with
 * the contract migration, not carried past it.
 */
export async function loadAgentConfigForAccount(
  admin: {
    from: (table: string) => any;
  },
  scope: AgentConfigScope,
): Promise<Record<string, unknown> | null> {
  if (scope.accountId) {
    const { data: owned } = await admin
      .from("ai_agent_configs")
      .select("*")
      .eq("user_id", scope.userId)
      .eq("social_account_id", scope.accountId)
      .maybeSingle();
    if (owned) return owned as Record<string, unknown>;
  }
  const { data: forPlatform } = await admin
    .from("ai_agent_configs")
    .select("*")
    .eq("user_id", scope.userId)
    .eq("platform", scope.platform)
    .maybeSingle();
  return (forPlatform as Record<string, unknown>) ?? null;
}
