// Which agent config answers for a connected account.
//
// Two callers need the same answer and must not drift: ai-agent-reply decides
// whether an inbound message gets a reply, and messaging-api's ai_get_config
// decides what the settings form renders. When they disagreed on 2026-08-28 the
// form rendered empty while a real persona sat in the row behind it, and every
// save wrote the blank form's defaults over it.

export interface AgentConfigScope {
  userId: string;
  /** Kept on the scope because both call sites already carry it and validate
   *  the account against it before calling; the lookup itself no longer needs
   *  it now that the platform fallback is gone. */
  platform: string;
  /** The connected account, or null for a caller that names none (the sandbox,
   *  and the settings form until it learns to pass one). */
  accountId: string | null;
}

/**
 * The account's own config, or null.
 *
 * There is no platform fallback any more. It existed only while
 * ai_agent_configs_user_id_platform_key held one config per (owner, platform),
 * where "some other account's config" and "this owner's only config for this
 * platform" were the same row. 20260828200000 dropped that constraint and gave
 * every active account a row of its own, so the fallback would now be a
 * genuine cross-account read: page B answering in page A's brand voice, and --
 * once an owner has two configs on a platform -- a multiple-rows error on
 * every lookup.
 *
 * An account with no config of its own is therefore unconfigured, and the
 * caller says so out loud: ai-agent-reply logs agent_not_configured rather
 * than guessing, and the settings form renders an empty state rather than
 * another account's persona.
 */
export async function loadAgentConfigForAccount(
  admin: {
    from: (table: string) => any;
  },
  scope: AgentConfigScope,
): Promise<Record<string, unknown> | null> {
  if (!scope.accountId) return null;
  const { data, error } = await admin
    .from("ai_agent_configs")
    .select("*")
    .eq("user_id", scope.userId)
    .eq("social_account_id", scope.accountId)
    .maybeSingle();
  // Never swallowed. A read that FAILED and a read that found nothing are
  // opposite facts, and collapsing them is how a statement timeout became a
  // blank settings form whose Save then wrote defaults over a live persona.
  if (error) throw error;
  return (data as Record<string, unknown>) ?? null;
}
