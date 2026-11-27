import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { formatIsoDuration } from "../domain/formatIsoDuration";
import type { YouTubePlayerSizeMode } from "../domain/player";
import type { YouTubeVideoDetails } from "../domain/types";
import { YouTubeVideoPlayer } from "./YouTubeVideoPlayer";

export interface YouTubeVideoDetailProps {
  video: YouTubeVideoDetails;
  fetchedAt: string;
  accountId?: string | null;
  categoryLabel?: string | null;
  showUpdated?: boolean;
  showHeading?: boolean;
  /** How large the embedded player is drawn; the drawer owns it. */
  playerSizeMode?: YouTubePlayerSizeMode;
  onPlayerSizeModeChange?: (mode: YouTubePlayerSizeMode) => void;
}

export function YouTubeVideoDetail(props: YouTubeVideoDetailProps): JSX.Element {
  const {
    video,
    fetchedAt,
    accountId,
    categoryLabel,
    showUpdated = true,
    showHeading = true,
    playerSizeMode,
    onPlayerSizeModeChange,
  } = props;
  const { t, i18n } = useTranslation("accounts");
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const notAvailable = t("youtubeManagement.detail.notAvailable", "Not available");
  const numberFormat = new Intl.NumberFormat(i18n.language);
  const count = (value: number | null) => value === null ? notAvailable : numberFormat.format(value);
  const parsedAt = new Date(fetchedAt);
  const fetchedLabel = Number.isNaN(parsedAt.getTime())
    ? null
    : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(parsedAt);
  const publishedAt = video.published_at === null ? null : new Date(video.published_at);
  const publishedLabel = publishedAt === null || Number.isNaN(publishedAt.getTime())
    ? notAvailable
    : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(publishedAt);
  const metadata = [
    [t("youtubeManagement.detail.views", "Views"), count(video.statistics.view_count)],
    [t("youtubeManagement.detail.likes", "Likes"), count(video.statistics.like_count)],
    [t("youtubeManagement.detail.comments", "Comments"), count(video.statistics.comment_count)],
    [t("youtubeManagement.detail.duration", "Duration"), formatIsoDuration(video.duration_iso8601) ?? notAvailable],
    [t("youtubeManagement.detail.privacy", "Privacy"), video.privacy_status ?? notAvailable],
    [t("youtubeManagement.drawer.publishedDate", "Published date"), publishedLabel],
    [t("youtubeManagement.drawer.category", "Category"), categoryLabel ?? video.category_id ?? notAvailable],
    [t("youtubeManagement.drawer.defaultLanguage", "Default language"), video.default_language ?? notAvailable],
    [
      t("youtubeManagement.drawer.madeForKids", "Made for Kids"),
      video.made_for_kids === null
        ? notAvailable
        : video.made_for_kids
        ? t("youtubeManagement.drawer.yes", "Yes")
        : t("youtubeManagement.drawer.no", "No"),
    ],
  ];

  return (
    <Card>
      <CardContent className="space-y-5 pt-1">
        <YouTubeVideoPlayer
          key={video.id}
          videoId={video.id}
          title={video.title}
          thumbnailUrl={video.thumbnail_url}
          durationIso8601={video.duration_iso8601}
          privacyStatus={video.privacy_status}
          uploadStatus={video.upload_status}
          sizeMode={playerSizeMode}
          onSizeModeChange={onPlayerSizeModeChange}
        />
        <div className="space-y-2">
          {showHeading ? <h3 className="text-lg font-semibold">{video.title}</h3> : <p className="text-lg font-semibold">{video.title}</p>}
          <div className="flex flex-wrap gap-3">
            <a href={video.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              {t("youtubeManagement.detail.openOnYouTube", "Open on YouTube")}
            </a>
            {!flagsLoading && flags.analyticsYoutube ? (
              <Link
                to={`/analytics/youtube?video=${encodeURIComponent(video.id)}${accountId ? `&account=${encodeURIComponent(accountId)}` : ""}`}
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("youtubeManagement.detail.viewAnalytics", "View analytics")}
              </Link>
            ) : null}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {metadata.map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-base font-medium">{value}</dd>
            </div>
          ))}
        </dl>

        <section className="space-y-2">
          <h4 className="text-sm font-semibold">{t("youtubeManagement.drawer.descriptionHeading", "Description")}</h4>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border p-3 text-sm">
            {video.description || t("youtubeManagement.drawer.noDescription", "No description")}
          </div>
        </section>

        {video.tags.length > 0 ? (
          <section className="space-y-2">
            <h4 className="text-sm font-semibold">{t("youtubeManagement.detail.tags", "Tags")}</h4>
            <div className="flex flex-wrap gap-1.5">
              {video.tags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
            </div>
          </section>
        ) : null}

        {showUpdated && fetchedLabel !== null ? (
          <p className="text-xs text-muted-foreground">{t("youtubeManagement.fetchedAt", "Updated {{time}}", { time: fetchedLabel })}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
