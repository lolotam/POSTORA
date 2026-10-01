import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Mirrors the jsonb keys returned by public.get_whatsapp_account_setup_summary (D1).
// The RPC is owner-only (42501 for any other user's account), so the browser can
// call it directly with the signed-in user's session.
export interface WhatsAppSetupSummary {
  agent_config: number;
  connectors: number;
  connector_links: number;
  store_bindings: number;
  knowledge_sources: number;
  test_cases: number;
  waitlist: number;
  templates: number;
  partner_keys_primary: number;
  partner_key_links: number;
  partner_webhooks: number;
  n8n_subscriptions: number;
  scheduled_messages: number;
  automation_handlers: string[];
}

export function useWhatsAppSetupSummary(accountId: string | null) {
  return useQuery({
    queryKey: ["whatsapp-setup-summary", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_whatsapp_account_setup_summary", {
        p_account_id: accountId!,
      });
      if (error) throw error;
      return data as unknown as WhatsAppSetupSummary;
    },
  });
}
