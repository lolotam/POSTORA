import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { ReconnectableWhatsAppAccount } from "@/hooks/useReconnectableWhatsApp";
import type { WhatsAppSetupSummary } from "@/hooks/useWhatsAppSetupSummary";

export interface SetupMoveCandidate {
  from: ReconnectableWhatsAppAccount;
  summary: WhatsAppSetupSummary;
}

export interface SetupMoveActiveAccount {
  id: string;
  platform_user_id: string | null;
  connection_mode?: string | null;
  // Looser than the mover's known keys on purpose: account_metadata carries many
  // unrelated keys, and the hook reads only its own defensively.
  account_metadata?: Record<string, unknown> | null;
}

interface CandidateRow extends ReconnectableWhatsAppAccount {
  is_active: boolean | null;
  account_metadata: Record<string, unknown> | null;
}

/** Digits a WhatsApp row sends from — mirrors whatsapp_account_number_digits (BC1). */
export function whatsappNumberDigits(row: {
  platform_user_id: string | null;
  connection_mode?: string | null;
  account_metadata?: Record<string, unknown> | null;
}): string {
  const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
  if (String(row.platform_user_id ?? "").startsWith("retired_")) {
    return digits(row.account_metadata?.retired_number);
  }
  if (row.connection_mode === "evolution_qr") {
    return digits(row.platform_user_id);
  }
  return digits(row.account_metadata?.display_phone_number);
}

function summaryHasSetup(summary: WhatsAppSetupSummary): boolean {
  return summary.agent_config > 0
    || summary.connectors > 0
    || summary.connector_links > 0
    || summary.store_bindings > 0
    || summary.knowledge_sources > 0
    || summary.test_cases > 0
    || summary.waitlist > 0
    || summary.templates > 0
    || summary.partner_keys_primary > 0
    || summary.partner_key_links > 0
    || summary.partner_webhooks > 0
    || summary.n8n_subscriptions > 0
    || summary.scheduled_messages > 0
    || (summary.automation_handlers?.length ?? 0) > 0;
}

/**
 * Previous WhatsApp connections of the same owner whose AI agent setup is worth
 * bringing over to `activeAccount`: rows that are inactive or retired, carry a
 * non-zero setup summary, and either share the active account's normalized number
 * or are the most recently deactivated row when the owner runs exactly one active
 * WhatsApp account. Pairs the owner dismissed stay hidden — unless the mover
 * deferred them, in which case setup_move_pending.from always comes back.
 */
export function useSetupMoveCandidates(activeAccount: SetupMoveActiveAccount | null) {
  const { user } = useAuth();

  return useQuery<SetupMoveCandidate[]>({
    queryKey: ["setup-move-candidates", user?.id, activeAccount?.id],
    enabled: !!user && !!activeAccount,
    queryFn: async () => {
      if (!user || !activeAccount) return [];
      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, platform_user_id, platform_username, connection_mode, is_active, updated_at, account_metadata")
        .eq("user_id", user.id)
        .eq("platform", "whatsapp")
        .order("updated_at", { ascending: false });
      if (error) throw error;

      const rows = (data ?? []) as unknown as CandidateRow[];
      const metadata = activeAccount.account_metadata ?? {};
      const dismissed = new Set(
        Array.isArray(metadata.setup_move_dismissed) ? (metadata.setup_move_dismissed as string[]) : [],
      );
      const pending = metadata.setup_move_pending;
      const pendingFrom = pending !== null && typeof pending === "object"
        && typeof (pending as { from?: unknown }).from === "string"
        ? (pending as { from: string }).from
        : null;
      const activeDigits = whatsappNumberDigits(activeAccount);
      const activeCount = rows.filter((row) =>
        row.is_active === true && !String(row.platform_user_id ?? "").startsWith("retired_")
      ).length;

      const withSetup: SetupMoveCandidate[] = [];
      for (const row of rows) {
        if (row.id === activeAccount.id) continue;
        if (row.is_active !== false && !String(row.platform_user_id ?? "").startsWith("retired_")) continue;
        const { data: summary, error: summaryError } = await supabase
          .rpc("get_whatsapp_account_setup_summary", { p_account_id: row.id });
        const typedSummary = summary as unknown as WhatsAppSetupSummary | null;
        if (summaryError || !typedSummary || !summaryHasSetup(typedSummary)) continue;
        withSetup.push({ from: row, summary: typedSummary });
      }

      // Rows should arrive ordered by updated_at desc, but the fallback picks the
      // most recently deactivated row by that column explicitly, so sort here too.
      withSetup.sort((a, b) => Date.parse(b.from.updated_at) - Date.parse(a.from.updated_at));

      const matched = withSetup.filter((candidate) => {
        if (candidate.from.id === pendingFrom) return true;
        if (dismissed.has(candidate.from.id)) return false;
        return activeDigits !== "" && whatsappNumberDigits(candidate.from) === activeDigits;
      });
      if (matched.length > 0) return matched;

      // No number match: with exactly one active account, the most recent
      // deactivated row is almost certainly the reconnect the owner just replaced.
      if (activeCount === 1) {
        return withSetup.filter((candidate) =>
          candidate.from.id === pendingFrom || !dismissed.has(candidate.from.id)
        ).slice(0, 1);
      }
      return [];
    },
  });
}
