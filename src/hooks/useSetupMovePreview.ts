import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** One source connector as get_whatsapp_setup_move_preview reports it. */
export interface SetupMovePreviewConnector {
  name: string;
  connector_type: string;
  has_store_webhook: boolean;
  name_clash: boolean;
  destination_has_store_webhook: boolean;
}

/**
 * What an interactive move from `fromAccountId` to `toAccountId` would touch —
 * the shape of public.get_whatsapp_setup_move_preview (migration 20261004111500).
 */
export interface SetupMovePreview {
  same_workspace: boolean;
  source_has_agent: boolean;
  destination_has_agent: boolean;
  connectors: SetupMovePreviewConnector[];
  partner_items: number;
  waitlist_count: number;
  waitlist_moves: boolean;
  template_count: number;
  templates_move: boolean;
}

/** Per-candidate choices for the "Bring over my setup" banner, read before it renders. */
export function useSetupMovePreview(fromAccountId: string | null, toAccountId: string | null) {
  return useQuery({
    queryKey: ["whatsapp-setup-move-preview", fromAccountId, toAccountId],
    enabled: !!fromAccountId && !!toAccountId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_whatsapp_setup_move_preview", {
        p_from: fromAccountId!,
        p_to: toAccountId!,
      });
      if (error) throw error;
      return data as unknown as SetupMovePreview;
    },
  });
}
