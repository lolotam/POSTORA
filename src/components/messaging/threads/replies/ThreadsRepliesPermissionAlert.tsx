import { AlertTriangle, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

interface Props {
  reason?: string;
}

export function ThreadsRepliesPermissionAlert({ reason }: Props) {
  const { t } = useTranslation("threads");
  const isExpired = reason === "expired_token" || reason === "invalid_token";
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {isExpired
          ? t("permission.expiredTitle", "Threads connection expired")
          : t("permission.reconnectTitle", "Reconnect required")}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p className="text-sm">
          {isExpired
            ? t("permission.expiredBody", "Your Threads access token has expired. Reconnect to continue managing replies.")
            : t("permission.reconnectBody", "Your Threads account is missing the permissions needed to read or manage replies. Reconnect to grant access.")}
        </p>
        <Button asChild size="sm" variant="outline">
          <Link to="/profiles">
            {t("permission.reconnectCta", "Reconnect Threads")}
            <ExternalLink className="ms-2 h-3.5 w-3.5" />
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}