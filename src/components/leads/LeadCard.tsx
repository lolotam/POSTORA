import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Lead, useUpdateLeadStatus, useUpdateLeadNotes } from "@/hooks/useLeadsCRM";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ChevronUp, Save } from "lucide-react";

const STATUS_OPTIONS = [
  { value: "new", label: "New", color: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
  { value: "contacted", label: "Contacted", color: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20" },
  { value: "qualified", label: "Qualified", color: "bg-muted text-foreground border-border" },
  { value: "won", label: "Won", color: "bg-green-500/10 text-green-500 border-green-500/20" },
  { value: "lost", label: "Lost", color: "bg-destructive/10 text-destructive border-destructive/20" },
];

interface LeadCardProps {
  lead: Lead;
}

export function LeadCard({ lead }: LeadCardProps) {
  const { t } = useTranslation("analytics");
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(lead.notes || "");
  const updateStatus = useUpdateLeadStatus();
  const updateNotes = useUpdateLeadNotes();

  const statusLabel = (value: string) =>
    value === "new" ? t("leads.new", "New")
    : value === "contacted" ? t("leads.contacted", "Contacted")
    : value === "qualified" ? t("leads.qualified", "Qualified")
    : value === "won" ? t("leads.won", "Won")
    : value === "lost" ? t("leads.lost", "Lost")
    : t("leads.new", "New");
  const statusConfig = STATUS_OPTIONS.find((s) => s.value === lead.status) || STATUS_OPTIONS[0];
  const dataEntries = Object.entries(lead.lead_data).filter(([, v]) => v);

  // Extract name/email for quick display
  const name = lead.lead_data.full_name || lead.lead_data.name || lead.lead_data.first_name || "";
  const email = lead.lead_data.email || "";
  const phone = lead.lead_data.phone_number || lead.lead_data.phone || "";

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="font-medium text-sm">{name || email || t("leads.fallbackId", "Lead #{{id}}", { id: lead.meta_lead_id?.slice(-6) })}</span>
              <Badge variant="outline" className={statusConfig.color}>
                {statusLabel(statusConfig.value)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
              </span>
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {email && <span>📧 {email}</span>}
              {phone && <span>📱 {phone}</span>}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Select
              value={lead.status}
              onValueChange={(value) => updateStatus.mutate({ leadId: lead.id, status: value })}
            >
              <SelectTrigger className="w-[120px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{statusLabel(s.value)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setExpanded(!expanded)}>
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="mt-3 space-y-3 border-t pt-3">
            {dataEntries.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {dataEntries.map(([key, value]) => (
                  <div key={key}>
                    <span className="text-xs text-muted-foreground capitalize">{key.replace(/_/g, " ")}</span>
                    <p className="text-sm">{value}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">{t("leads.notes", "Notes")}</span>
              <div className="flex gap-2">
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t("leads.notesPlaceholder", "Add notes about this lead...")}
                  className="min-h-[60px] text-sm"
                />
                <Button
                  size="icon"
                  variant="outline"
                  className="shrink-0"
                  disabled={notes === (lead.notes || "")}
                  onClick={() => updateNotes.mutate({ leadId: lead.id, notes })}
                >
                  <Save className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
