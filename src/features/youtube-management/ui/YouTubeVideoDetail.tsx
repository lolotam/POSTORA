import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { formatIsoDuration } from "../domain/formatIsoDuration";
import type { YouTubeVideoDetails } from "../domain/types";

export interface YouTubeVideoDetailProps {
  video: YouTubeVideoDetails;
  fetchedAt: string;
  accountId?: string | null;
}

function Counter({ label, value, notAvailable }: { label: string; value: number | null; notAvailable: string }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium">{value === null ? notAvailable : new Intl.NumberFormat().format(value)}</dd>
    </div>
  );
}

export function YouTubeVideoDetail(props: YouTubeVideoDetailProps): JSX.Element {
  const { video, fetchedAt, accountId } = props;
  const { t, i18n } = useTranslation("accounts");
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const notAvailable = t("youtubeManagement.detail.notAvailable", "Not available");
  const duration = formatIsoDuration(video.duration_iso8601);
  const parsedAt = new Date(fetchedAt);
  const fetchedLabel = Number.isNaN(parsedAt.getTime())
    ? null
    : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(parsedAt);

  return (
    <Card>
      <CardContent className="space-y-3 pt-1">
        <h3 className="text-lg font-semibold">{video.title}</h3>
        <p className="whitespace-pre-wrap text-sm">{video.description}</p>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted-foreground">{t("youtubeManagement.detail.privacy", "Privacy")}</dt>
            <dd className="text-base font-medium">{video.privacy_status ?? notAvailable}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{t("youtubeManagement.detail.duration", "Duration")}</dt>
            <dd className="text-base font-medium">{duration ?? notAvailable}</dd>
          </div>
          <Counter label={t("youtubeManagement.detail.views", "Views")} value={video.statistics.view_count} notAvailable={notAvailable} />
          <Counter label={t("youtubeManagement.detail.likes", "Likes")} value={video.statistics.like_count} notAvailable={notAvailable} />
          <Counter label={t("youtubeManagement.detail.comments", "Comments")} value={video.statistics.comment_count} notAvailable={notAvailable} />
        </dl>
        {video.tags.length > 0 ? (
          <div>
            <p className="text-sm text-muted-foreground">{t("youtubeManagement.detail.tags", "Tags")}</p>
            <p className="text-sm">{video.tags.join(", ")}</p>
          </div>
        ) : null}
        {fetchedLabel === null ? null : (
          <p className="text-xs text-muted-foreground">
            {t("youtubeManagement.fetchedAt", "Updated {{time}}", { time: fetchedLabel })}
          </p>
        )}
        {!flagsLoading && flags.analyticsYoutube ? (
          <Link
            to={`/analytics/youtube?video=${encodeURIComponent(video.id)}${accountId ? `&account=${encodeURIComponent(accountId)}` : ""}`}
            className="block text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("youtubeManagement.detail.viewAnalytics", "View analytics")}
          </Link>
        ) : null}
        <a
          href={video.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("youtubeManagement.detail.openOnYouTube", "Open on YouTube")}
        </a>
      </CardContent>
    </Card>
  );
}
