import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import type { YouTubeChannelDetails } from "../domain/types";

export interface YouTubeChannelSummaryProps {
  channel: YouTubeChannelDetails;
  fetchedAt: string;
}

// Counters are YouTube counts, never watch-time reports; a subscriber count
// YouTube hides stays "Hidden", not zero.
export function YouTubeChannelSummary(props: YouTubeChannelSummaryProps): JSX.Element {
  const { channel, fetchedAt } = props;
  const { t, i18n } = useTranslation("accounts");
  const format = new Intl.NumberFormat();
  const parsedAt = new Date(fetchedAt);
  const fetchedLabel = Number.isNaN(parsedAt.getTime())
    ? null
    : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(parsedAt);

  return (
    <Card>
      <CardContent className="space-y-3 pt-1">
        <h2 className="text-lg font-semibold">{channel.title}</h2>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted-foreground">{t("youtubeManagement.stats.subscribers", "Subscribers")}</dt>
            <dd className="text-base font-medium">
              {channel.statistics.subscriber_count_hidden
                ? t("youtubeManagement.stats.hidden", "Hidden")
                : channel.statistics.subscriber_count === null
                  ? "—"
                  : format.format(channel.statistics.subscriber_count)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{t("youtubeManagement.stats.views", "Views")}</dt>
            <dd className="text-base font-medium">
              {channel.statistics.view_count === null ? "—" : format.format(channel.statistics.view_count)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{t("youtubeManagement.stats.videos", "Videos")}</dt>
            <dd className="text-base font-medium">
              {channel.statistics.video_count === null ? "—" : format.format(channel.statistics.video_count)}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          {t("youtubeManagement.countersNote", "Counters come from YouTube. They are not watch-time reports.")}
        </p>
        {fetchedLabel === null ? null : (
          <p className="text-xs text-muted-foreground">
            {t("youtubeManagement.fetchedAt", "Updated {{time}}", { time: fetchedLabel })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
