import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";
import { formatObservedAt } from "../domain/formatters";

export type CompetitorStatusProps = {
  /** The collection state of the entry. */
  status: string | null | undefined;
  /** The server's stable reason code, when the state is a failure. */
  reasonCode?: string | null;
  /** The server's own next attempt time. */
  nextRetryAt?: string | null;
  className?: string;
};

/**
 * The collection state of one tracked competitor.
 *
 * Every state is a WORD, never a colour: the owner has to be able to
 * read "waiting to retry" without decoding a badge. The reason is the
 * server's own code, translated - never the server's text (spec §8).
 */
export function CompetitorStatus({
  status,
  reasonCode,
  nextRetryAt,
  className,
}: CompetitorStatusProps) {
  const { t, i18n } = useTranslation("analytics");
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const statusLabel = useMemo(() => {
    switch (status) {
      case "pending":
        return t("competitors.status.pending", "Waiting for collection");
      case "ok":
        return t("competitors.status.ok", "Up to date");
      case "unavailable":
        return t("competitors.status.unavailable", "Unavailable");
      case "error":
        return t("competitors.status.error", "Collection failed");
      case "none":
        return t("competitors.status.none", "No collection yet");
      case "queued":
        return t("competitors.status.queued", "Queued");
      case "leased":
        return t("competitors.status.leased", "In progress");
      case "retry":
        return t("competitors.status.retry", "Waiting to retry");
      case "partial":
        return t("competitors.status.partial", "Partial");
      case "completed":
        return t("competitors.status.completed", "Completed");
      default:
        return t("competitors.status.unknown", "Status unknown");
    }
  }, [status, t]);

  const reason = useMemo(() => {
    switch (reasonCode) {
      case "target_unavailable":
        return {
          text: t(
            "competitors.targetUnavailable",
            "This account is not eligible for collection. It may be private, or a Business or Creator account.",
          ),
          reconnect: false,
        };
      case "viewer_unavailable":
        return {
          text: t(
            "competitors.viewerUnavailable",
            "A compatible page-linked viewer is needed to collect this account.",
          ),
          reconnect: true,
        };
      case "scope_missing":
        return {
          text: t(
            "competitors.error.scopeMissing",
            "The connected account is missing the permission this collection needs.",
          ),
          reconnect: true,
        };
      case "token_invalid":
        return {
          text: t(
            "competitors.error.tokenInvalid",
            "The connected account is no longer authorised. Reconnect it to collect again.",
          ),
          reconnect: true,
        };
      case "apify_disabled":
        return {
          text: t(
            "competitors.error.apifyDisabled",
            "Official collection is unavailable and the scheduled third-party fallback is off.",
          ),
          reconnect: false,
        };
      case "rate_limited":
        return {
          text: t(
            "competitors.error.rateLimited",
            "The collector is busy. Try again when it says it is due.",
          ),
          reconnect: false,
        };
      case "provider_error":
        return {
          text: t(
            "competitors.error.provider",
            "The collector could not reach the platform.",
          ),
          reconnect: false,
        };
      case "storage_error":
        return {
          text: t("competitors.error.storage", "The collected data could not be stored."),
          reconnect: false,
        };
      case "credential_changed":
        return {
          text: t(
            "competitors.error.credentialsChanged",
            "The connected credentials changed. Reconnect to collect again.",
          ),
          reconnect: true,
        };
      case "collection_disabled":
      case "protected_credentials_required":
        return {
          text: t(
            "competitors.collectionDisabled",
            "Collection is not available right now. Your stored reports are still here.",
          ),
          reconnect: false,
        };
      case null:
      case undefined:
        return null;
      default:
        return {
          text: t("competitors.error.generic", "Something went wrong."),
          reconnect: false,
        };
    }
  }, [reasonCode, t]);

  const retryAt = useMemo(() => {
    if (!nextRetryAt) return null;
    const epoch = Date.parse(nextRetryAt);
    if (!Number.isFinite(epoch)) return null;
    const seconds = Math.max(0, Math.round((epoch - Date.now()) / 1000));
    return {
      at: t("competitors.nextRetryAt", "Next attempt {{date}}", {
        date: formatObservedAt(nextRetryAt, locale),
      }),
      in: t("competitors.retryIn", "Retry in {{seconds}} seconds.", { seconds }),
    };
  }, [nextRetryAt, locale, t]);

  return (
    <div className={cn("flex flex-col gap-0.5 text-xs", className)}>
      <span className="font-medium text-foreground">{statusLabel}</span>
      {reason !== null && (
        <span className="text-muted-foreground">{reason.text}</span>
      )}
      {reason?.reconnect === true && (
        <Link
          to="/profiles"
          className="w-fit underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("competitors.reconnect", "Reconnect")}
        </Link>
      )}
      {retryAt !== null && (
        <>
          <span className="text-muted-foreground">{retryAt.at}</span>
          <span className="text-muted-foreground">{retryAt.in}</span>
        </>
      )}
    </div>
  );
}
