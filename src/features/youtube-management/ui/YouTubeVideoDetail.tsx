import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import type { YouTubeVideoDetails } from "../domain/types";

export interface YouTubeVideoDetailProps {
  video: YouTubeVideoDetails;
  fetchedAt: string;
}

// PT4M13S -> "4:13"; PT1H2M3S -> "1:02:03"; null or unparseable -> null.
export function formatIsoDuration(value: string | null): string | null {
  if (value === null) return null;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  if (!days && !hours && !minutes && !seconds) return null;
  const totalHours = (days ? Number(days) * 24 : 0) + (hours ? Number(hours) : 0);
  const mins = minutes ? Number(minutes) : 0;
  const secs = seconds ? Number(seconds) : 0;
  const mm = String(mins).padStart(totalHours > 0 ? 2 : 1, "0");
  const ss = String(secs).padStart(2, "0");
  return totalHours > 0 ? `${totalHours}:${mm}:${ss}` : `${mins}:${ss}`;
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
  const { video, fetchedAt } = props;
  const { t, i18n } = useTranslation("accounts");
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
