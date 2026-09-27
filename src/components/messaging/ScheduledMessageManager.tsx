import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Clock, XCircle, CheckCircle2, Loader2, AlertCircle, MinusCircle } from "lucide-react";
import { format } from "date-fns";
import { SCHEDULED_CANCEL_BLOCKED, useWhatsAppScheduledMessages } from "@/hooks/useWhatsAppScheduledMessages";
import { toast } from "sonner";
import { ScheduleMessageDialog } from "@/components/messaging/ScheduleMessageDialog";

export function ScheduledMessageManager() {
  const { t } = useTranslation("inbox");
  const { messages, isLoading, cancel } = useWhatsAppScheduledMessages();
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const statusBadge = (status: string) => {
    if (status === "claimed" || status === "sending") {
      return <Badge variant="secondary" className="gap-1"><Loader2 className="h-3 w-3" /> {t("status.sending", "sending")}</Badge>;
    }
    switch (status) {
      case "pending": return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" /> {t("common:status.pending", "Pending")}</Badge>;
      case "sent": return <Badge variant="default" className="gap-1"><CheckCircle2 className="h-3 w-3" /> {t("common:status.sent", "Sent")}</Badge>;
      case "failed": return <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" /> {t("common:status.failed", "Failed")}</Badge>;
      case "cancelled": return <Badge variant="outline" className="gap-1"><XCircle className="h-3 w-3" /> {t("common:status.cancelled", "Cancelled")}</Badge>;
      case "skipped": return <Badge variant="outline" className="gap-1"><MinusCircle className="h-3 w-3" /> {t("status.skipped", "skipped (opted out)")}</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const handleCancel = (id: string) => {
    cancel.mutate(id, {
      onSuccess: () => toast.success(t("scheduled.cancelledToast", "Scheduled message cancelled")),
      onError: (err: Error) => toast.error(
        err.message === SCHEDULED_CANCEL_BLOCKED
          ? t("scheduled.cancelTooLate", SCHEDULED_CANCEL_BLOCKED)
          : err.message,
      ),
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          {t("scheduled.titleCount", "Scheduled Messages ({{count}})", { count: messages.length })}
        </CardTitle>
        <Button type="button" size="sm" onClick={() => setScheduleOpen(true)}>
          {t("scheduled.scheduleButton", "Schedule message")}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : messages.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{t("scheduled.empty", "No scheduled messages yet. Use \"Schedule message\" to add one.")}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("scheduled.recipient", "Recipient")}</TableHead>
                <TableHead>{t("scheduled.message", "Message")}</TableHead>
                <TableHead>{t("scheduled.scheduledFor", "Scheduled For")}</TableHead>
                <TableHead>{t("scheduled.status", "Status")}</TableHead>
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {messages.map((msg) => (
                <TableRow key={msg.id}>
                  <TableCell className="font-medium">{msg.recipient_name || msg.recipient_phone}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                    {msg.message_text || `[${msg.media_type || t("scheduled.media", "media")}]`}
                  </TableCell>
                  <TableCell className="text-sm">{format(new Date(msg.scheduled_at), "MMM d, yyyy h:mm a")}</TableCell>
                  <TableCell>{statusBadge(msg.status)}</TableCell>
                  <TableCell>
                    {msg.status === "pending" && (
                      <Button variant="ghost" size="sm" className="text-destructive h-7" onClick={() => handleCancel(msg.id)} disabled={cancel.isPending}>
                        {t("common:cancel", "Cancel")}
                      </Button>
                    )}
                    {msg.status === "failed" && msg.error_message && (
                      <span className="block max-w-[180px] truncate text-xs text-destructive" title={msg.error_message}>{msg.error_message}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ScheduleMessageDialog open={scheduleOpen} onOpenChange={setScheduleOpen} />
    </Card>
  );
}
