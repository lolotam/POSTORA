import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { LeadForm } from "@/hooks/useLeadsCRM";

interface LeadFiltersProps {
  forms: LeadForm[];
  selectedFormId: string;
  onFormChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
}

export function LeadFilters({ forms, selectedFormId, onFormChange, statusFilter, onStatusChange }: LeadFiltersProps) {
  const { t } = useTranslation("analytics");
  return (
    <div className="flex flex-wrap gap-4 items-end">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{t("leads.form", "Form")}</Label>
        <Select value={selectedFormId} onValueChange={onFormChange}>
          <SelectTrigger className="w-[200px] h-9">
            <SelectValue placeholder={t("form.allFormsPlaceholder", "All forms")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("form.allForms", "All Forms")}</SelectItem>
            {forms.map((f) => (
              <SelectItem key={f.id} value={f.id}>{f.form_name || f.form_id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{t("leads.status", "Status")}</Label>
        <Select value={statusFilter} onValueChange={onStatusChange}>
          <SelectTrigger className="w-[140px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common:all", "All")}</SelectItem>
            <SelectItem value="new">{t("leads.new", "New")}</SelectItem>
            <SelectItem value="contacted">{t("leads.contacted", "Contacted")}</SelectItem>
            <SelectItem value="qualified">{t("leads.qualified", "Qualified")}</SelectItem>
            <SelectItem value="won">{t("leads.won", "Won")}</SelectItem>
            <SelectItem value="lost">{t("leads.lost", "Lost")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
