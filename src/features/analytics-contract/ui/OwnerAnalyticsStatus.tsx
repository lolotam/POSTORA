import { useTranslation } from "react-i18next";
import type { OwnerAnalyticsReadiness, OwnerAnalyticsData } from "../../../../supabase/functions/_shared/ownerAnalyticsReadiness";

export function OwnerAnalyticsStatus({ report }: { report: Partial<OwnerAnalyticsReadiness> & { data?: OwnerAnalyticsData } }) {
  const { t } = useTranslation("analytics");
  const collection = report.collection;
  if (!collection) return null;
  const messages = {
    not_enabled: t("readiness.notEnabled", "Analytics collection is not enabled for this account yet."),
    preparing: t("readiness.preparing", "We are verifying this connection for analytics."),
    needs_reconnect: collection.reconnect_can_help
      ? t("readiness.reconnect", "Connect again to restore analytics access.")
      : t("readiness.review", "We could not verify this connection. Contact support."),
    permissions_missing: t("readiness.permissionsMissing", "Analytics permissions were verified missing for this connection."),
    needs_review: t("readiness.review", "We could not verify this connection. Contact support."),
    syncing: collection.reason_code === "queued" ? t("readiness.queued", "Analytics collection is queued.")
      : collection.reason_code === "running" ? t("readiness.running", "Analytics collection is running.")
      : t("readiness.awaiting", "Waiting for the first saved analytics measurement."),
    unavailable: t("readiness.unavailable", "Analytics collection is temporarily unavailable."),
    ready: t("readiness.ready", "Analytics connection is ready."),
  };
  const dataLabels = {
    empty: t("readiness.empty", "Never synced: no saved measurements in this period."),
    partial: t("readiness.partial", "Partially synced: saved measurements cover part of this period."),
    complete: t("readiness.complete", "Saved measurements cover this period."),
    stale: t("readiness.stale", "Saved measurements are out of date."),
  };
  return <div role="status" aria-live="polite" className="rounded-lg border p-3 space-y-1 text-sm">
    <p>{messages[collection.state]}</p>
    {report.permission?.state === "missing" && <p>{report.permission.missing_scopes.join(", ")}</p>}
    {collection.next_action === "contact_support" && <p>{t("readiness.support", "Contact support for the next step.")}</p>}
    {collection.next_action === "grant_permissions" && <p>{t("readiness.grant", "Grant the listed permissions through the supported connection flow.")}</p>}
    {report.data && <p>{dataLabels[report.data.state]}</p>}
    {report.data?.last_successful_capture && <p>{t("readiness.lastCapture", "Last saved measurement")}: {report.data.last_successful_capture}</p>}
    {collection.retry_at && <p>{t("owned.retryAt", "Retry after")}: {collection.retry_at}</p>}
  </div>;
}
