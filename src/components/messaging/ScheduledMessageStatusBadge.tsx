import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Clock, Loader2, MinusCircle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function ScheduledMessageStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation("inbox");
  if (status === "claimed" || status === "sending") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="h-3 w-3" />
        {t("status.sending", "sending")}
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Clock className="h-3 w-3" />
        {t("common:status.pending", "Pending")}
      </Badge>
    );
  }
  if (status === "sent") {
    return (
      <Badge variant="default" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        {t("common:status.sent", "Sent")}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="h-3 w-3" />
        {t("common:status.failed", "Failed")}
      </Badge>
    );
  }
  if (status === "cancelled") {
    return (
      <Badge variant="outline" className="gap-1">
        <XCircle className="h-3 w-3" />
        {t("common:status.cancelled", "Cancelled")}
      </Badge>
    );
  }
  if (status === "skipped") {
    return (
      <Badge variant="outline" className="gap-1">
        <MinusCircle className="h-3 w-3" />
        {t("status.skipped", "skipped (opted out)")}
      </Badge>
    );
  }
  return <Badge variant="outline">{status}</Badge>;
}
