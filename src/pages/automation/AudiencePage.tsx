import { useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Navigate } from "react-router-dom";

import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useUserRole } from "@/hooks/useUserRole";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ContactFilters } from "@/components/audience/ContactFilters";
import { ContactsTable } from "@/components/audience/ContactsTable";
import { ContactDetailsDrawer } from "@/components/audience/ContactDetailsDrawer";
import { ExportMenu } from "@/components/audience/ExportMenu";
import { SheetsSyncDialog } from "@/components/audience/SheetsSyncDialog";
import {
  CONTACTS_PAGE_SIZE, EMPTY_FILTERS, useDeleteSocialContact, useSocialContactStats, useSocialContactTags,
  useSocialContacts, type ContactFilters as Filters, type SocialContact,
} from "@/features/audience";

export default function AudiencePage() {
  const { t } = useTranslation("automation");
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  // useFeatureFlags reports only its own query's loading state, and an admin's
  // flags come from isAdmin, which is false while the role query is still in
  // flight. Without waiting for that too, an admin opening this URL directly is
  // redirected away from a page they are entitled to see.
  const { isLoading: roleLoading } = useUserRole();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<SocialContact | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const contacts = useSocialContacts(filters, page);
  const stats = useSocialContactStats();
  const tags = useSocialContactTags();
  const remove = useDeleteSocialContact();

  // The nav entry hides with the flag, but a URL is still a URL. Every other flagged
  // page redirects the same way, and the flag is the whole rollout control.
  // Neither decide early nor render early. Redirecting while the role is still
  // loading throws admins off their own page; rendering while it loads would hand
  // a disabled feature's export, delete and sync controls to someone who should
  // not have them. Hold until access is actually known.
  if (flagsLoading || roleLoading) {
    return (
      <DashboardLayout>
        <div className="p-10 text-center text-muted-foreground">{t("common:loading", "Loading…")}</div>
      </DashboardLayout>
    );
  }
  if (!flags.audienceHub) return <Navigate to="/automation" replace />;

  const rows = contacts.data?.rows ?? [];
  const total = contacts.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / CONTACTS_PAGE_SIZE));

  const statsFailed = Boolean(stats.error);
  const kpis = [
    { id: "total", testId: "Total contacts", label: t("audience.kpi.total", "Total contacts"), value: statsFailed ? "—" : stats.data?.total ?? 0 },
    { id: "workflowLeads", testId: "Workflow leads", label: t("audience.kpi.workflowLeads", "Workflow leads"), value: statsFailed ? "—" : stats.data?.workflow_leads ?? 0 },
    { id: "enriched", testId: "Enriched contacts", label: t("audience.kpi.enriched", "Enriched contacts"), value: statsFailed ? "—" : stats.data?.enriched ?? 0 },
    { id: "topPlatform", testId: "Top platform", label: t("audience.kpi.topPlatform", "Top platform"), value: statsFailed ? "—" : stats.data?.top_platform ?? "—" },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold">{t("header.audience", "Audience & Contacts")}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <ExportMenu filters={filters} />
            <Button
              variant="outline"
              onClick={() => setSyncOpen(true)}
              // The list keeps the previous page's rows on screen while a new query
              // is in flight, which is right for reading and wrong for a side effect:
              // syncing mid-fetch would append the rows the user just filtered away.
              disabled={contacts.isFetching}
            >
              {t("actions.syncToSheets", "Sync to Sheets")}
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {kpis.map((k) => (
            <Card key={k.id}>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{k.label}</CardTitle></CardHeader>
              <CardContent className="text-2xl font-semibold" data-testid={`kpi-${k.testId}`}>{k.value}</CardContent>
            </Card>
          ))}
        </div>
        <div className="space-y-1">
          <ContactFilters value={filters} tags={tags.data ?? []} onChange={(next) => { setFilters(next); setPage(0); }} />
          {tags.error && (
            // Without this, a failed tag read is indistinguishable from an account
            // that has never tagged anyone, and the filter simply vanishes.
            <p className="text-xs text-destructive">{t("errors.tagFilters", "Tag filters unavailable: {{message}}", { message: (tags.error as Error).message })}</p>
          )}
        </div>
        <Card>
          <CardContent className="p-0">
            {contacts.error
              // A failed read and an empty tenant are not the same thing. Saying
              // "no contacts yet" when the query actually failed hides a bad
              // deploy or a permission problem behind a plausible empty state.
              ? <div className="p-10 text-center text-destructive">
                  {t("errors.loadContacts", "Could not load contacts. {{message}}", { message: (contacts.error as Error).message })}
                </div>
              : rows.length === 0 && !contacts.isLoading
                ? <div className="p-10 text-center text-muted-foreground">{t("empty.noContacts", "No contacts yet")}</div>
                : <ContactsTable rows={rows} onOpen={setSelected} onDelete={(row) => remove.mutate(row.id)} />}
          </CardContent>
        </Card>
        <div className="flex items-center justify-end gap-2 text-sm">
          <span>{t("audience.pageOf", "Page {{page}} of {{pageCount}}", { page: page + 1, pageCount })}</span>
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>{t("common:previous", "Previous")}</Button>
          <Button size="sm" variant="outline" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>{t("common:next", "Next")}</Button>
        </div>
        <ContactDetailsDrawer contact={selected} onClose={() => setSelected(null)} />
        {syncOpen && (
          <SheetsSyncDialog contactIds={rows.map((row) => row.id)} onClose={() => setSyncOpen(false)} />
        )}
      </div>
    </DashboardLayout>
  );
}
