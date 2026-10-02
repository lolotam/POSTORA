import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { WhatsAppSetupSummary } from "@/hooks/useWhatsAppSetupSummary";

/**
 * One row of list_whatsapp_setup_move_candidates (migration 20261004111500): an
 * inactive or retired WhatsApp connection of the same owner that still carries
 * setup and is worth offering to bring over. `reason` is the SQL's match reason
 * (pending | same_number | last_deactivated).
 */
export interface SetupMoveCandidate {
  id: string;
  platform_username: string | null;
  reason: string;
  summary: WhatsAppSetupSummary;
}

/**
 * The owner's previous connections whose setup can move to `activeAccountId`.
 * Filtering, dismissal and the summary read all happen inside the one RPC, so
 * the browser neither re-implements the number rules nor issues a summary call
 * per old row.
 */
export function useSetupMoveCandidates(activeAccountId: string | null) {
  const query = useQuery({
    queryKey: ["whatsapp-setup-move-candidates", activeAccountId],
    enabled: !!activeAccountId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_whatsapp_setup_move_candidates", {
        p_to: activeAccountId!,
      });
      if (error) throw error;
      return data as unknown as SetupMoveCandidate[];
    },
  });
  // A disabled or still-loading query reads as "nothing to move", which is
  // exactly how every host renders the banner before the RPC answers.
  // placeholderData is deliberately not used: it reports isSuccess before the
  // RPC resolves, which a caller waiting for real data would take at face value.
  return { ...query, data: query.data ?? [] };
}
