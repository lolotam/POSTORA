import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { YouTubeResourceErrorCode } from "../domain/types";

export interface YouTubeResourceNoticeProps {
  code: YouTubeResourceErrorCode;
  retryAfterSeconds: number | null;
  onRetry: () => void;
}

/**
 * Explains one stable failure in the user's words. Every code keeps its own
 * sentence so a refusal never looks like an empty list; only transient
 * failures offer a retry, and reconnect-shaped codes link to Profiles.
 */
export function YouTubeResourceNotice(props: YouTubeResourceNoticeProps): JSX.Element {
  const { code, retryAfterSeconds, onRetry } = props;
  const { t } = useTranslation("accounts");

  let message: string;
  let linkToProfiles = false;
  let retryable = false;
  switch (code) {
    case "reconnect_required":
      message = t("youtubeManagement.notice.reconnectRequired", "This channel needs to be reconnected before Postora can read it.");
      linkToProfiles = true;
      break;
    case "missing_scope":
      message = t("youtubeManagement.notice.missingScope", "Postora does not have permission to read this channel. Reconnect it and allow viewing your YouTube account.");
      linkToProfiles = true;
      break;
    case "provider_unsupported":
      message = t("youtubeManagement.notice.providerUnsupported", "This channel is connected through the managed connector, which does not support browsing yet.");
      break;
    case "quota_exceeded":
      message = t("youtubeManagement.notice.quotaExceeded", "YouTube's daily limit for Postora is used up. It resets at midnight Pacific Time.");
      break;
    case "rate_limited":
      message = t("youtubeManagement.notice.rateLimited", "Too many requests. Try again in about {{minutes}} min.", {
        minutes: Math.max(1, Math.ceil((retryAfterSeconds ?? 60) / 60)),
      });
      break;
    case "not_found":
      message = t("youtubeManagement.notice.notFound", "YouTube could not find this content for the connected channel.");
      break;
    case "upstream_unavailable":
      message = t("youtubeManagement.notice.upstreamUnavailable", "YouTube did not answer. Nothing was changed.");
      retryable = true;
      break;
    default:
      message = t("youtubeManagement.notice.generic", "Something went wrong while loading this content.");
      retryable = code === "internal_error";
      break;
  }

  return (
    <Alert role="alert">
      <AlertDescription className="space-y-2">
        <p>{message}</p>
        <div className="flex flex-wrap items-center gap-2">
          {linkToProfiles ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/profiles">{t("youtubeManagement.goToProfiles", "Open Profiles")}</Link>
            </Button>
          ) : null}
          {retryable ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("youtubeManagement.retry", "Try again")}
            </Button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}
