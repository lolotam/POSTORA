import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { asYouTubeAnalyticsClientError } from "../domain/errors";
import type { YouTubeAnalyticsErrorCode } from "../domain/types";

const DEFAULTS: Record<YouTubeAnalyticsErrorCode, string> = {
  invalid_request: "This analytics request is not valid.",
  window_stale: "The reporting period moved on. Refresh to load the latest period.",
  unauthorized: "Sign in again to check analytics access.",
  not_enabled: "YouTube Analytics is not switched on for this channel yet.",
  consent_required: "Allow analytics for this channel to see its reports.",
  consent_version_stale: "The analytics purpose changed. Reload this panel and review the current text.",
  missing_scope: "This channel does not have the permission required for analytics. Reconnect it on Profiles.",
  not_found: "This YouTube channel is not available. Open Profiles to connect it again.",
  video_not_found: "This video is not available on this channel.",
  method_not_allowed: "This analytics request is not supported.",
  provider_unsupported: "Analytics is unavailable for this managed connection type.",
  reconnect_required: "Reconnect this channel on Profiles to restore analytics access.",
  connection_changed: "This channel connection changed. Reload its analytics.",
  rate_limited: "Too many analytics requests. Try again in {{minutes}} minute(s).",
  capacity_reached: "Postora's shared YouTube analytics capacity is spent for today. Try again tomorrow.",
  quota_exceeded: "YouTube's analytics quota is exhausted. Try again later.",
  settings_unavailable: "Postora could not check analytics access. Try again.",
  upstream_unavailable: "YouTube Analytics is temporarily unavailable. Try again.",
  internal_error: "Postora could not load this analytics block. Try again.",
};

export function AnalyticsNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation("analytics");
  const parsed = asYouTubeAnalyticsClientError(error);
  const minutes = Math.max(1, Math.ceil((parsed.retryAfterSeconds ?? 60) / 60));
  const messages: Record<YouTubeAnalyticsErrorCode, string> = {
    invalid_request: t("youtube.notices.invalid_request", DEFAULTS.invalid_request),
    window_stale: t("youtube.notices.window_stale", DEFAULTS.window_stale),
    unauthorized: t("youtube.notices.unauthorized", DEFAULTS.unauthorized),
    not_enabled: t("youtube.notices.not_enabled", DEFAULTS.not_enabled),
    consent_required: t("youtube.notices.consent_required", DEFAULTS.consent_required),
    consent_version_stale: t("youtube.notices.consent_version_stale", DEFAULTS.consent_version_stale),
    missing_scope: t("youtube.notices.missing_scope", DEFAULTS.missing_scope),
    not_found: t("youtube.notices.not_found", DEFAULTS.not_found),
    video_not_found: t("youtube.notices.video_not_found", DEFAULTS.video_not_found),
    method_not_allowed: t("youtube.notices.method_not_allowed", DEFAULTS.method_not_allowed),
    provider_unsupported: t("youtube.notices.provider_unsupported", DEFAULTS.provider_unsupported),
    reconnect_required: t("youtube.notices.reconnect_required", DEFAULTS.reconnect_required),
    connection_changed: t("youtube.notices.connection_changed", DEFAULTS.connection_changed),
    rate_limited: t("youtube.notices.rate_limited", DEFAULTS.rate_limited, { minutes }),
    capacity_reached: t("youtube.notices.capacity_reached", DEFAULTS.capacity_reached),
    quota_exceeded: t("youtube.notices.quota_exceeded", DEFAULTS.quota_exceeded),
    settings_unavailable: t("youtube.notices.settings_unavailable", DEFAULTS.settings_unavailable),
    upstream_unavailable: t("youtube.notices.upstream_unavailable", DEFAULTS.upstream_unavailable),
    internal_error: t("youtube.notices.internal_error", DEFAULTS.internal_error),
  };
  const message = parsed.detail === "grant_not_effective"
    ? t("youtube.notices.grant_not_effective", "Google did not keep this permission. Disconnect the channel on Profiles and connect it again.")
    : messages[parsed.code];
  const profilesLink = parsed.code === "missing_scope" || parsed.code === "reconnect_required" || parsed.code === "not_found";

  return (
    <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <p>{message}</p>
      {parsed.requestId ? <p className="text-xs text-muted-foreground">{t("youtube.requestReference", "Request reference")}: {parsed.requestId}</p> : null}
      <div className="flex flex-wrap gap-2">
        {onRetry ? <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t("youtube.retry", "Retry")}</Button> : null}
        {profilesLink ? <Button asChild type="button" size="sm" variant="outline"><Link to="/profiles">{t("youtube.openProfiles", "Open Profiles")}</Link></Button> : null}
      </div>
    </div>
  );
}
