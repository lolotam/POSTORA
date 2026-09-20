import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LeadCard } from "@/components/leads/LeadCard";
import { LeadFilters } from "@/components/leads/LeadFilters";
import { useLeadForms, useLeads, useSyncLeadForms, useSyncLeads } from "@/hooks/useLeadsCRM";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, RefreshCw, Loader2, Download } from "lucide-react";
import { Link } from "react-router-dom";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import { cn } from "@/lib/utils";

const STATUS_PILL: Record<string, string> = {
  new: "bg-sky-500/15 text-sky-500 border-sky-500/30",
  contacted: "bg-violet-500/15 text-violet-500 border-violet-500/30",
  qualified: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  won: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  lost: "bg-rose-500/15 text-rose-500 border-rose-500/30",
};

export default function LeadsCRM() {
  const { t } = useTranslation("analytics");
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedFormId, setSelectedFormId] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: socialAccounts = [] } = useSocialAccounts();
  const { data: forms = [], isLoading: formsLoading } = useLeadForms();
  const { data: allLeads = [], isLoading: leadsLoading } = useLeads(selectedFormId === "all" ? null : selectedFormId);
  const syncForms = useSyncLeadForms();
  const syncLeads = useSyncLeads();

  const fbAccounts = useMemo(
    () => socialAccounts.filter((a) => a.platform === "facebook" && a.is_active),
    [socialAccounts]
  );

  const activeAccountId = selectedAccountId && fbAccounts.some((a) => a.id === selectedAccountId)
    ? selectedAccountId
    : fbAccounts[0]?.id || null;
  const activeAccount = fbAccounts.find((a) => a.id === activeAccountId);

  const filteredLeads = useMemo(() => {
    return allLeads.filter((l) => {
      if (statusFilter !== "all" && l.status !== statusFilter) return false;
      return true;
    });
  }, [allLeads, statusFilter]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { new: 0, contacted: 0, qualified: 0, won: 0, lost: 0 };
    for (const l of allLeads) counts[l.status] = (counts[l.status] || 0) + 1;
    return counts;
  }, [allLeads]);

  if (!flagsLoading && !flags.leadsCrm) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleSyncForms = () => {
    if (!activeAccountId || !activeAccount?.platform_user_id) return;
    syncForms.mutate({ socialAccountId: activeAccountId, pageId: activeAccount.platform_user_id });
  };

  const handleSyncLeads = () => {
    if (!activeAccountId) return;
    const formsToSync = selectedFormId === "all" ? forms : forms.filter((f) => f.id === selectedFormId);
    for (const form of formsToSync) {
      syncLeads.mutate({ socialAccountId: form.social_account_id, formId: form.form_id });
    }
  };

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        {/* Header */}
        <Reveal>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="group flex items-center gap-4 min-w-0">
              <Icon3D icon={Users} variant="violet" size="md" />
              <div className="flex-1 min-w-0">
                <GradientHeading preset="sky-violet-pink" size="lg" as="h1">{t("leads.title", "Lead Forms CRM")}</GradientHeading>
                <p className="text-sm text-muted-foreground mt-1">{t("leads.subtitle", "Manage Facebook Lead Ad submissions")}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="border-violet-500/40 hover:bg-violet-500/10" onClick={handleSyncForms} disabled={syncForms.isPending || !activeAccountId}>
                {syncForms.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Download className="h-4 w-4 mr-1" />}
                {t("actions.syncForms", "Sync Forms")}
              </Button>
              <Button size="sm" className="bg-gradient-to-r from-sky-500 via-violet-500 to-pink-500 text-white hover:opacity-90" onClick={handleSyncLeads} disabled={syncLeads.isPending || forms.length === 0}>
                {syncLeads.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                {t("actions.syncLeads", "Sync Leads")}
              </Button>
            </div>
          </div>
        </Reveal>
        <GradientDivider tone="violet" />

        {/* Status summary */}
        <Reveal delay={60}>
          <div className="flex flex-wrap gap-2">
            {Object.entries(statusCounts).map(([status, count]) => {
              const statusLabel =
                status === "new" ? t("leads.new", "New")
                : status === "contacted" ? t("leads.contacted", "Contacted")
                : status === "qualified" ? t("leads.qualified", "Qualified")
                : status === "won" ? t("leads.won", "Won")
                : status === "lost" ? t("leads.lost", "Lost")
                : status;
              return (
              <span key={status} className={cn("inline-flex items-center gap-1.5 rounded-full border backdrop-blur-md px-3 py-1 text-xs font-medium capitalize", STATUS_PILL[status] || "bg-card/60 border-border/40")}>
                {statusLabel}: <span className="tabular-nums font-semibold">{count}</span>
              </span>
              );
            })}
          </div>
        </Reveal>

        {/* Controls */}
        <Reveal delay={120}>
          <GradientRingCard variant="violet" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4">
            <div className="flex flex-wrap items-end gap-4">
              {fbAccounts.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">{t("leads.facebookPage", "Facebook Page")}</span>
                  <Select value={activeAccountId || ""} onValueChange={setSelectedAccountId}>
                    <SelectTrigger className="w-[220px] h-9">
                      <SelectValue placeholder={t("leads.selectPage", "Select page")} />
                    </SelectTrigger>
                    <SelectContent>
                      {fbAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.platform_username || a.platform_user_id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <LeadFilters
                forms={forms}
                selectedFormId={selectedFormId}
                onFormChange={setSelectedFormId}
                statusFilter={statusFilter}
                onStatusChange={setStatusFilter}
              />
            </div>
          </GradientRingCard>
        </Reveal>

        {/* Leads list */}
        {formsLoading || leadsLoading ? (
          <div className="flex items-center justify-center py-12 rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md">
            <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
          </div>
        ) : fbAccounts.length === 0 ? (
          <Reveal delay={160}>
            <GradientRingCard variant="violet" hoverLift={false} ringIntensity="subtle">
              <div className="flex flex-col items-center text-center py-6 space-y-3">
                <div className="group"><Icon3D icon={Users} variant="violet" size="lg" /></div>
                <p className="font-medium mt-1">{t("empty.noFacebookPages", "No Facebook pages connected")}</p>
                <p className="text-sm text-muted-foreground">{t("empty.syncFormsHint", "Connect a Facebook page to sync lead forms.")}</p>
                <Button asChild className="bg-gradient-to-r from-sky-500 via-violet-500 to-pink-500 text-white hover:opacity-90">
                  <Link to="/profiles">{t("actions.goToProfiles", "Go to Profiles")}</Link>
                </Button>
              </div>
            </GradientRingCard>
          </Reveal>
        ) : filteredLeads.length === 0 ? (
          <Reveal delay={160}>
            <div className="rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md text-center py-12">
              <div className="group inline-flex mb-3"><Icon3D icon={Users} variant="violet" size="lg" /></div>
              <p className="font-medium mt-2">{t("empty.noLeads", "No leads found")}</p>
              <p className="text-sm text-muted-foreground mt-1">{t("empty.noLeadsHint", "Sync your lead forms to import leads from Facebook.")}</p>
            </div>
          </Reveal>
        ) : (
          <div className="space-y-3">
            {filteredLeads.map((lead) => (
              <LeadCard key={lead.id} lead={lead} />
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
