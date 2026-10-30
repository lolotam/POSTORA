import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import i18next, { type i18n as I18nInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";

import analyticsAr from "@/i18n/locales/ar/analytics.json";
import type { CompetitorReportEntry } from "../domain/contracts";
import { CompetitorDetailSheet } from "../ui/CompetitorDetailSheet";
import { CompetitorList } from "../ui/CompetitorList";

/**
 * The same bundle the screen test loads: English is the call-site
 * default, and Arabic is the only shipped bundle.
 */
async function makeI18n(lng: "en" | "ar"): Promise<I18nInstance> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng,
    fallbackLng: "en",
    ns: ["analytics"],
    defaultNS: "analytics",
    resources: {
      en: { analytics: {} },
      ar: { analytics: analyticsAr },
    },
    interpolation: { escapeValue: false },
  });
  return instance;
}

const WATCHLIST_ID = "3f2b6c1e-9a44-4f0a-8b21-7c5d9e0a1b23";

function makeEntry(): CompetitorReportEntry {
  return {
    watchlist_id: WATCHLIST_ID,
    username: "northwind",
    label: null,
    is_active: true,
    removed_at: null,
    status: "ok",
    last_error_code: null,
    next_retry_at: null,
    cleanup_eligible_at: null,
    profile: {
      followers_count: 14200,
      media_count: 156,
      captured_at: "2026-10-29T00:00:00Z",
      captured_on: "2026-10-29",
      source: "official",
    },
    freshness: {
      last_capture_at: "2026-10-29T00:00:00Z",
      last_full_success_at: "2026-10-29T00:00:00Z",
      last_partial_at: null,
      job_status: "completed",
      reason_code: null,
    },
    growth_7d: {
      absolute: 480,
      percent: 4,
      baseline_at: "2026-10-22T00:00:00Z",
      observed_at: "2026-10-29T00:00:00Z",
      interval_days: 7,
      reason: null,
    },
    growth_30d: {
      absolute: 1280,
      percent: 11.4,
      baseline_at: "2026-09-29T00:00:00Z",
      observed_at: "2026-10-29T00:00:00Z",
      interval_days: 30,
      reason: null,
    },
    weekly: {
      observed_count: 3,
      posts_per_week: 3,
      interval_start: "2026-10-23T00:00:00Z",
      interval_end: "2026-10-30T00:00:00Z",
      coverage: "complete",
      reason: null,
    },
  };
}

function renderList(instance: I18nInstance) {
  return render(
    <I18nextProvider i18n={instance}>
      <CompetitorList
        entries={[makeEntry()]}
        state="active"
        isLoading={false}
        error={null}
        onRetryRead={vi.fn()}
        onOpenDetail={vi.fn()}
        onRetryCollection={vi.fn()}
        isRetryPending={() => false}
        onRemove={vi.fn()}
        onReactivate={vi.fn()}
        isReactivatePending={() => false}
        collectionStatus={() => null}
        hasMore={false}
        isLoadingMore={false}
        loadMoreError={null}
        onLoadMore={vi.fn()}
      />
    </I18nextProvider>,
  );
}

function renderSheet(instance: I18nInstance) {
  return render(
    <I18nextProvider i18n={instance}>
      <CompetitorDetailSheet
        open
        onOpenChange={vi.fn()}
        entry={makeEntry()}
        media={[]}
        isLoading={false}
        error={null}
        periodDays={7}
        onSelectPeriod={vi.fn()}
        onRetryRead={vi.fn()}
        collection={null}
      />
    </I18nextProvider>,
  );
}

/** Collapses the JSX whitespace around a phrase without touching its slash. */
function phraseText(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The element that owns the whole per-week phrase.
 *
 * The number sits in its own `dir="ltr"` isolate. The phrase itself must
 * not, or Arabic "3.0 / أسبوع" is painted left to right.
 */
function weeklyPhrase(text: string): HTMLElement {
  return screen.getByText((_, element) => {
    if (!element || phraseText(element) !== text) return false;
    if (element.getAttribute("dir") === "ltr") return false;
    const number = element.querySelector("bdi[dir='ltr']");
    if (!number || phraseText(number) !== "3.0") return false;
    return !Array.from(element.querySelectorAll("*")).some(
      (descendant) => descendant !== number && phraseText(descendant) === text,
    );
  });
}

function expectIsolatedWeeklyNumber(phrase: HTMLElement): void {
  expect(phrase).not.toHaveAttribute("dir", "ltr");
  const number = phrase.querySelector("bdi");
  expect(number).toHaveAttribute("dir", "ltr");
  expect(phraseText(number as Element)).toBe("3.0");
}

describe("competitor numeric values in Arabic and RTL", () => {
  let english: I18nInstance;
  let arabic: I18nInstance;

  beforeAll(async () => {
    english = await makeI18n("en");
    arabic = await makeI18n("ar");
  });

  it("keeps the English weekly rate as 3.0/week and isolates the sign", () => {
    renderList(english);

    const rate = weeklyPhrase("3.0/week");
    expectIsolatedWeeklyNumber(rate);

    const growth = screen.getByText("+480 (4.0%)");
    expect(growth).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("+1,280 (11.4%)")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("14,200")).toHaveAttribute("dir", "ltr");
  });

  it("uses the Arabic week unit without forcing the phrase left to right", () => {
    renderList(arabic);

    const rate = weeklyPhrase("3.0 / أسبوع");
    expectIsolatedWeeklyNumber(rate);
    expect(phraseText(rate)).toContain("أسبوع");
    expect(screen.getByText("+480 (4.0%)")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("+1,280 (11.4%)")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("14,200")).toHaveAttribute("dir", "ltr");
  });

  it.each(["+480 (4.0%)", "+1,280 (11.4%)"])(
    "keeps Arabic list growth %s inline so it aligns with the document direction",
    (text) => {
      renderList(arabic);

      const growth = screen.getByText(text, { selector: 'bdi[dir="ltr"]' });
      expect(growth.parentElement?.tagName).toBe("SPAN");
      expect(growth.parentElement).not.toHaveClass("flex-col");
      expect(growth.parentElement).not.toHaveAttribute("dir", "ltr");
    },
  );

  it("does the same in the detail sheet", async () => {
    renderSheet(arabic);

    const sheet = await screen.findByRole("dialog");
    const rate = weeklyPhrase("3.0 / أسبوع");
    expect(sheet).toContainElement(rate);
    expectIsolatedWeeklyNumber(rate);
    expect(phraseText(rate)).toContain("أسبوع");
    expect(screen.getByText("+480 (4.0%)")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("+1,280 (11.4%)")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("14,200")).toHaveAttribute("dir", "ltr");
  });
});
