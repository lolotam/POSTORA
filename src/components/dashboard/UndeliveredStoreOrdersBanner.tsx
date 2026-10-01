import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useUndeliveredStoreAccounts } from "@/hooks/useUndeliveredStoreAccounts";

export function UndeliveredStoreOrdersBanner() {
  const { t } = useTranslation("dashboard");
  const { data = [] } = useUndeliveredStoreAccounts();
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
