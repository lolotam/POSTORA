import { useAnalyticsLabels } from "./useAnalyticsLabels";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import type { AnalyticsPeriodDays, AnalyticsPlatform } from "../domain/types";
import { ANALYTICS_PERIOD_DAYS } from "../../../../supabase/functions/_shared/analyticsCalendar.ts";
import { useSavedAnalytics } from "../application/useSavedAnalytics";
import { AnalyticsReadError, type SavedAnalyticsGateway } from "../application/ports";
import { supabaseSavedAnalytics } from "../infrastructure/supabaseSavedAnalytics";
import { SavedAnalyticsReport } from "./SavedAnalyticsReport";

/** Composition root: only this screen selects the concrete persistence adapter. */
export function OwnedAnalyticsScreen({ platform, gateway = supabaseSavedAnalytics }: { platform: AnalyticsPlatform; gateway?: SavedAnalyticsGateway }) {
  const { user } = useAuth();
  const { t } = useTranslation("analytics");
  const labels = useAnalyticsLabels();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [periodDays, setPeriodDays] = useState<AnalyticsPeriodDays>(7);
  const { accounts, accountId, reports } = useSavedAnalytics({ ownerId: user?.id ?? null, platform, gateway, selectedAccountId, periodDays });
  const first = reports.data?.pages[0];
  const pages = reports.data?.pages ?? [];
  const revisionChanged = reports.error instanceof AnalyticsReadError && ["history_revision_changed", "history_expired", "invalid_cursor"].includes(reports.error.reason);
  const errorReason = reports.error instanceof AnalyticsReadError ? reports.error.reason : "storage_unavailable";
  const refresh = () => { void reports.refetch(); };
  return <section aria-label={t("owned.title", "Connected account performance")} className="space-y-4">
    <h2 className="text-lg font-semibold">{t("owned.title", "Connected account performance")}</h2>
    {accounts.isError ? <div role="alert">{t("owned.accountsFailed", "Connected accounts could not be loaded.")} <Button variant="outline" onClick={() => { void accounts.refetch(); }}>{t("owned.retry", "Retry")}</Button></div>
      : accounts.isLoading ? <p role="status">{t("owned.loading", "Loading saved analytics…")}</p>
      : !user ? <p>{t("owned.signIn", "Sign in to view saved analytics.")}</p>
      : accounts.data?.length === 0 ? <p>{t("owned.noAccounts", "No connected accounts for this platform.")}</p> : <>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">{t("owned.account", "Account")}
            <select className="rounded-md border bg-background p-2 max-w-full" value={accountId ?? ""} onChange={(event) => setSelectedAccountId(event.target.value)}>
              {accounts.data?.map((account) => <option key={account.id} value={account.id}>{account.name}{!account.active ? ` · ${t("owned.disconnected", "Disconnected")}` : ""}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">{t("owned.period", "Period")}
            <select className="rounded-md border bg-background p-2" value={periodDays} onChange={(event) => setPeriodDays(Number(event.target.value) as AnalyticsPeriodDays)}>
              {ANALYTICS_PERIOD_DAYS.map((days) => <option key={days} value={days}>{t("owned.days", "{{days}} closed days", { days })}</option>)}
            </select>
          </label>
          <Button variant="outline" disabled={!accountId || reports.isFetching} onClick={refresh}>{t("owned.refresh", "Refresh report")}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("owned.savedHint", "Saved measurements are updated by scheduled collection. Refresh reloads the report.")}</p>
        {reports.isLoading && <p role="status">{t("owned.loading", "Loading saved analytics…")}</p>}
        {reports.isError && <div role="alert" className="rounded-lg border p-4">{revisionChanged
          ? t("owned.historyChanged", "Saved history changed. Refresh the report before continuing.")
          : Object.hasOwn(labels.reasons, errorReason) ? labels.reasons[errorReason] : t("owned.readFailed", "Saved analytics could not be loaded. Please retry.")}
          <Button variant="outline" disabled={reports.isFetching} onClick={refresh}>{t("owned.refresh", "Refresh report")}</Button>
        </div>}
        {first && !revisionChanged && <SavedAnalyticsReport report={first} posts={Array.from(new Map(pages.flatMap((page) => page.posts.items).map((post) => [post.id, post])).values())} />}
        {reports.hasNextPage && !reports.isError && <Button variant="outline" disabled={reports.isFetchingNextPage} onClick={() => { void reports.fetchNextPage(); }}>{t("owned.more", "Load more posts")}</Button>}
      </>}
  </section>;
}
