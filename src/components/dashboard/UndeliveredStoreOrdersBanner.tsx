import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

interface FlaggedAccount {
  id: string;
  platform_username: string | null;
  account_metadata: { undelivered_store_events?: { since?: string } } | null;
}

export function UndeliveredStoreOrdersBanner() {
  const { t } = useTranslation("dashboard");
  const { user } = useAuth();
  const { data = [] } = useQuery({
    queryKey: ["undelivered-store-orders", user?.id],
    enabled: !!user,
    refetchInterval: 60000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("social_accounts")
        .select("id, platform_username, account_metadata")
        .eq("user_id", user!.id)
        .eq("platform", "whatsapp")
        .not("account_metadata->undelivered_store_events", "is", null);
      if (error) return [];
      return (rows ?? []) as FlaggedAccount[];
    },
  });
  if (data.length === 0) return null;
  return (
    <div className="space-y-2">
      {data.map((account) => (
        <Alert key={account.id} variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {t("undeliveredStore.title", "Store orders are waiting for a disconnected WhatsApp account ({{name}})", {
              name: account.platform_username ?? "WhatsApp",
            })}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              {t("undeliveredStore.body", "Order messages are on hold. Reconnect the account or move its setup to your current connection.")}
            </span>
            <Button asChild size="sm" variant="outline">
              <Link to="/messaging/whatsapp/setup">{t("undeliveredStore.action", "Reconnect or move setup")}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
