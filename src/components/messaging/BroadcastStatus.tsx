import { useTranslation } from "react-i18next";
import "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useWhatsAppBroadcastRecipients, WhatsAppBroadcast } from "@/hooks/useWhatsAppBroadcasts";
import { CheckCircle2, Clock, XCircle, Loader2, MinusCircle, Send } from "lucide-react";

const statusConfig: Record<string, { icon: React.ReactNode; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { icon: <Clock className="h-3 w-3" />, variant: "secondary" },
  sent: { icon: <Send className="h-3 w-3" />, variant: "default" },
  delivered: { icon: <CheckCircle2 className="h-3 w-3" />, variant: "default" },
  failed: { icon: <XCircle className="h-3 w-3" />, variant: "destructive" },
  skipped: { icon: <MinusCircle className="h-3 w-3" />, variant: "outline" },
};

function statusLabel(status: string, t: (key: string, fallback: string) => string) {
  switch (status) {
    case "pending":
      return t("status.pending", "pending");
    case "sending":
      return t("status.sending", "sending");
    case "completed":
      return t("status.completed", "completed");
    case "failed":
      return t("status.failed", "failed");
    case "sent":
      return t("status.sent", "sent");
    case "delivered":
      return t("status.delivered", "delivered");
    case "skipped":
      return t("status.skipped", "skipped (opted out)");
    default:
      return status;
  }
}

export function BroadcastStatus({ broadcast }: { broadcast: WhatsAppBroadcast }) {
  const { t } = useTranslation("whatsapp");
  const { data: recipients = [], isLoading } = useWhatsAppBroadcastRecipients(broadcast.id);
  const total = broadcast.recipient_count || 1;
  const progress = ((broadcast.sent_count + broadcast.failed_count) / total) * 100;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{broadcast.name}</CardTitle>
          <Badge variant={broadcast.status === "completed" ? "default" : broadcast.status === "failed" ? "destructive" : "secondary"}>
            {statusLabel(broadcast.status, t)}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t("broadcast.templateLabel", "Template: {{name}}", { name: broadcast.template_name })}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {broadcast.status === "sending" && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>{t("broadcast.progress", "Progress")}</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        )}

        <div className="grid grid-cols-4 gap-3 text-center">
          <div className="p-2 rounded-lg bg-secondary/50">
            <p className="text-lg font-semibold">{broadcast.recipient_count}</p>
            <p className="text-xs text-muted-foreground">{t("broadcast.total", "Total")}</p>
          </div>
          <div className="p-2 rounded-lg bg-secondary/50">
            <p className="text-lg font-semibold text-green-600">{broadcast.sent_count}</p>
            <p className="text-xs text-muted-foreground">{t("broadcast.sent", "Sent")}</p>
          </div>
          <div className="p-2 rounded-lg bg-secondary/50">
            <p className="text-lg font-semibold text-blue-600">{broadcast.delivered_count}</p>
            <p className="text-xs text-muted-foreground">{t("broadcast.delivered", "Delivered")}</p>
          </div>
          <div className="p-2 rounded-lg bg-secondary/50">
            <p className="text-lg font-semibold text-destructive">{broadcast.failed_count}</p>
            <p className="text-xs text-muted-foreground">{t("broadcast.failed", "Failed")}</p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : recipients.length > 0 ? (
          <div className="max-h-[300px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("broadcast.phone", "Phone")}</TableHead>
                  <TableHead>{t("broadcast.status", "Status")}</TableHead>
                  <TableHead>{t("broadcast.sentAt", "Sent At")}</TableHead>
                  <TableHead>{t("broadcast.error", "Error")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipients.map((r) => {
                  const cfg = statusConfig[r.status] || statusConfig.pending;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-sm">{r.phone_number}</TableCell>
                      <TableCell>
                        <Badge variant={cfg.variant} className="gap-1 text-xs">
                          {cfg.icon} {statusLabel(r.status, t)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.sent_at ? new Date(r.sent_at).toLocaleTimeString() : "—"}
                      </TableCell>
                      <TableCell className="text-sm text-destructive max-w-[200px] truncate">
                        {r.error_message || "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
