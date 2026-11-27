import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

export type YouTubeAnalyticsTab = "overview" | "audience" | "traffic";

const TABS: readonly YouTubeAnalyticsTab[] = ["overview", "audience", "traffic"];

/**
 * The report tab strip.
 *
 * Implements WAI-ARIA tabs with roving `tabIndex` and Left/Right/Home/End
 * keyboard navigation (mirrored in RTL), pointing `aria-controls` at the
 * rendered active tab panel.
 */
export function AnalyticsTabs({ active, onChange }: {
  active: YouTubeAnalyticsTab;
  onChange: (tab: YouTubeAnalyticsTab) => void;
}) {
  const { t, i18n } = useTranslation("analytics");
  const isRtl = i18n.language.startsWith("ar");
  const buttonRefs = useRef<Record<YouTubeAnalyticsTab, HTMLButtonElement | null>>({
    overview: null,
    audience: null,
    traffic: null,
  });
  const labels: Record<YouTubeAnalyticsTab, string> = {
    overview: t("youtube.tabs.overview", "Overview"),
    audience: t("youtube.tabs.audience", "Audience"),
    traffic: t("youtube.tabs.traffic", "Traffic"),
  };

  const selectAndFocus = (tab: YouTubeAnalyticsTab) => {
    onChange(tab);
    buttonRefs.current[tab]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const nextKey = isRtl ? "ArrowLeft" : "ArrowRight";
    const prevKey = isRtl ? "ArrowRight" : "ArrowLeft";
    if (event.key === nextKey) {
      event.preventDefault();
      selectAndFocus(TABS[(currentIndex + 1) % TABS.length]);
    } else if (event.key === prevKey) {
      event.preventDefault();
      selectAndFocus(TABS[(currentIndex - 1 + TABS.length) % TABS.length]);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectAndFocus(TABS[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      selectAndFocus(TABS[TABS.length - 1]);
    }
  };

  return (
    <div
      role="tablist"
      aria-label={t("youtube.tabs.label", "YouTube analytics reports")}
      className="no-print flex flex-wrap gap-2"
    >
      {TABS.map((tab, index) => {
        const isActive = active === tab;
        return (
          <button
            key={tab}
            ref={(element) => {
              buttonRefs.current[tab] = element;
            }}
            type="button"
            role="tab"
            id={`youtube-analytics-tab-${tab}`}
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            aria-controls={isActive ? `youtube-analytics-panel-${tab}` : undefined}
            onClick={() => onChange(tab)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={isActive
              ? "rounded-md border bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
              : "rounded-md border bg-background px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"}
          >
            {labels[tab]}
          </button>
        );
      })}
    </div>
  );
}
