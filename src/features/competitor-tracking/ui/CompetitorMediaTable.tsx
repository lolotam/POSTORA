import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UNAVAILABLE_VALUE, formatCount, formatObservedAt } from "../domain/formatters";
import type { CompetitorReportMedia } from "../domain/contracts";
import { CompetitorOutlierLabel } from "./CompetitorOutlierLabel";

export type CompetitorMediaTableProps = {
  media: CompetitorReportMedia[];
  /** The caption of the table, for assistive technology. */
  caption?: string;
};

/**
 * A URL that is safe to put in an `href`.
 *
 * Only an absolute HTTPS URL is accepted. A `javascript:` or `data:`
 * URL is refused, and so is anything the URL parser does not
 * understand. The permalink comes from a third party, so it is
 * untrusted input (spec §8).
 */
function safeHttpsUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * The observed media of one tracked competitor.
 *
 * Every number is the server's. A missing metric is UNAVAILABLE, not
 * zero, and the caption is plain third-party text - never HTML.
 */
export function CompetitorMediaTable({ media, caption }: CompetitorMediaTableProps) {
  const { t, i18n } = useTranslation("analytics");
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const rows = useMemo(
    () =>
      media.map((item) => ({
        item,
        permalink: safeHttpsUrl(item.permalink),
        thumbnail: safeHttpsUrl(item.thumbnail_url),
      })),
    [media],
  );

  return (
    <div className="rounded-xl border border-border/70 bg-card">
      {/* Only this region may scroll sideways: the page itself must not
          grow a horizontal scrollbar at a narrow width. The minimum
          width keeps the columns readable instead of squeezing the
          caption into a column of single words. */}
      <Table className="min-w-[42rem]">
        <TableCaption className="sr-only">
          {caption ?? t("competitors.media", "Latest posts")}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{t("competitors.media", "Latest posts")}</TableHead>
            <TableHead>{t("competitors.publishedAt", "Published")}</TableHead>
            <TableHead className="text-end">{t("competitors.likes", "Likes")}</TableHead>
            <TableHead className="text-end">{t("competitors.comments", "Comments")}</TableHead>
            <TableHead className="text-end">{t("competitors.views", "Views")}</TableHead>
            <TableHead>{t("competitors.outlier.outlier", "Outlier")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ item, permalink, thumbnail }) => (
            <TableRow key={item.ig_media_id}>
              <TableCell className="min-w-[18rem]">
                <div className="flex items-start gap-3">
                  {thumbnail === null ? (
                    <div
                      aria-hidden="true"
                      className="h-12 w-12 shrink-0 rounded-md border border-border bg-muted"
                    />
                  ) : (
                    <img
                      src={thumbnail}
                      alt=""
                      loading="lazy"
                      className="h-12 w-12 shrink-0 rounded-md border border-border object-cover"
                    />
                  )}
                  <div className="min-w-0 space-y-1">
                    {thumbnail === null && (
                      <span className="block text-xs text-muted-foreground">
                        {t("competitors.thumbnailUnavailable", "Preview unavailable")}
                      </span>
                    )}
                    {item.caption !== null && item.caption !== "" && (
                      <p className="max-w-prose text-xs text-muted-foreground">{item.caption}</p>
                    )}
                    {permalink !== null && (
                      <a
                        href={permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        {t("competitors.openPost", "Open post")}
                      </a>
                    )}
                  </div>
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {formatObservedAt(item.published_at, locale)}
              </TableCell>
              <TableCell className="text-end">
                {item.like_count === null ? UNAVAILABLE_VALUE : formatCount(item.like_count, locale)}
              </TableCell>
              <TableCell className="text-end">
                {item.comments_count === null
                  ? UNAVAILABLE_VALUE
                  : formatCount(item.comments_count, locale)}
              </TableCell>
              <TableCell className="text-end">
                {item.view_count === null ? UNAVAILABLE_VALUE : formatCount(item.view_count, locale)}
              </TableCell>
              <TableCell>
                <CompetitorOutlierLabel outlier={item.outlier} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
