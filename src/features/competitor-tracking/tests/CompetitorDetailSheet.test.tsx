import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import analyticsAr from "@/i18n/locales/ar/analytics.json";
import type { CompetitorReportEntry, CompetitorReportMedia } from "../domain/contracts";
import { CompetitorDetailSheet } from "../ui/CompetitorDetailSheet";

/**
 * The detail sheet tests assert what the owner can read about ONE
 * tracked competitor: the observation, the growth with its reason, the
 * weekly coverage and the collected posts.
 *
 * The sheet never computes: it renders the server's numbers and the
 * server's reasons.
 */

beforeAll(async () => {
  if (i18next.isInitialized) return;
  await i18next.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    ns: ["analytics"],
    defaultNS: "analytics",
    resources: {
      en: { analytics: {} },
      ar: { analytics: analyticsAr },
    },
    interpolation: { escapeValue: false },
  });
});

const WATCHLIST_ID = "3f2b6c1e-9a44-4f0a-8b21-7c5d9e0a1b23";

function makeEntry(overrides: Partial<CompetitorReportEntry> = {}): CompetitorReportEntry {
  return {
    watchlist_id: WATCHLIST_ID,
    username: "northwind",
    label: "Northwind",
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
      absolute: 120,
      percent: 0.85,
      baseline_at: "2026-10-22T00:00:00Z",
      observed_at: "2026-10-29T00:00:00Z",
      interval_days: 7,
      reason: null,
    },
    growth_30d: {
      absolute: null,
      percent: null,
      baseline_at: null,
      observed_at: null,
      interval_days: null,
      reason: "missing_baseline",
    },
    weekly: {
      observed_count: 3,
      posts_per_week: null,
      interval_start: "2026-10-23T00:00:00Z",
      interval_end: "2026-10-30T00:00:00Z",
      coverage: "unknown",
      reason: "coverage_unknown",
    },
    ...overrides,
  };
}

function makeMedia(overrides: Partial<CompetitorReportMedia> = {}): CompetitorReportMedia {
  return {
    ig_media_id: "media-1",
    published_at: "2026-10-28T12:00:00Z",
    captured_at: "2026-10-29T00:00:00Z",
    media_product_type: "REELS",
    media_type: "VIDEO",
    thumbnail_url: "https://cdn.example.com/thumb.jpg",
    permalink: "https://www.instagram.com/reel/abc123/",
    caption: "A plain caption <b>with</b> markup",
    like_count: 620,
    comments_count: 85,
    view_count: 12500,
    source: "official",
    outlier: {
      id: "media-1",
      score: 2.5,
      label: "outlier",
      baselineMedian: 5000,
      baselineSize: 12,
      metric_basis: "public_views",
      source: "official",
      reason: null,
    },
    ...overrides,
  };
}

type SheetProps = Parameters<typeof CompetitorDetailSheet>[0];

function renderSheet(overrides: Partial<SheetProps> = {}) {
  const props: SheetProps = {
    open: true,
    onOpenChange: vi.fn(),
    entry: makeEntry(),
    media: [],
    isLoading: false,
    error: null,
    periodDays: 7,
    onSelectPeriod: vi.fn(),
    onRetryRead: vi.fn(),
    collection: null,
    ...overrides,
  };

  const result = render(
    <MemoryRouter>
      <CompetitorDetailSheet {...props} />
    </MemoryRouter>,
  );

  return { ...result, props };
}

describe("CompetitorDetailSheet", () => {
  it("shows the observation, the growth and the weekly coverage of the entry", async () => {
    renderSheet();

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("@northwind")).toBeInTheDocument();
    expect(within(sheet).getByText("14,200")).toBeInTheDocument();
    expect(within(sheet).getByText("+120 (0.9%)")).toBeInTheDocument();
    expect(within(sheet).getByText("3 posts observed · incomplete coverage")).toBeInTheDocument();
  });

  it("names the missing baseline instead of showing a number", async () => {
    renderSheet();

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("No comparable baseline")).toBeInTheDocument();
    expect(within(sheet).queryByText(/Infinity/)).toBeNull();
  });

  it("shows the source of the observation", async () => {
    renderSheet();

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Official")).toBeInTheDocument();
  });

  it("keeps a removed entry readable with its cleanup date and no collection action", async () => {
    renderSheet({
      entry: makeEntry({
        is_active: false,
        removed_at: "2026-10-20T00:00:00Z",
        cleanup_eligible_at: "2027-01-18T00:00:00Z",
      }),
      onReactivate: vi.fn(),
    });

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("This competitor was removed.")).toBeInTheDocument();
    expect(within(sheet).getByText(/Eligible for cleanup on/)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Retry collection/ })).toBeNull();
  });

  it("shows the collected posts with a safe link and a plain-text caption", async () => {
    renderSheet({ media: [makeMedia()] });

    const sheet = await screen.findByRole("dialog");
    const link = within(sheet).getByRole("link", { name: "Open post" });
    expect(link).toHaveAttribute("href", "https://www.instagram.com/reel/abc123/");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    // The caption is third-party text: it is shown, never rendered as
    // markup.
    expect(within(sheet).getByText("A plain caption <b>with</b> markup")).toBeInTheDocument();
    expect(within(sheet).queryByText("with")).toBeNull();
  });

  it("refuses a permalink that is not an https link", async () => {
    renderSheet({
      media: [makeMedia({ permalink: "javascript:alert(1)" })],
    });

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByRole("link", { name: "Open post" })).toBeNull();
  });

  it("shows a placeholder and no metric when the preview is missing", async () => {
    renderSheet({
      media: [makeMedia({ thumbnail_url: null, view_count: null })],
    });

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Preview unavailable")).toBeInTheDocument();
    expect(within(sheet).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows the outlier verdict with its score", async () => {
    renderSheet({ media: [makeMedia()] });

    const sheet = await screen.findByRole("dialog");
    // The column is named "Outlier" and the verdict of this post is
    // "Outlier" too, so both are present.
    expect(within(sheet).getAllByText("Outlier").length).toBeGreaterThan(0);
    expect(within(sheet).getByText("2.5×")).toBeInTheDocument();
  });

  it("shows a neutral outlier state without a score", async () => {
    renderSheet({
      media: [
        makeMedia({
          outlier: {
            id: "media-1",
            score: null,
            label: "too_early",
            baselineMedian: null,
            baselineSize: 0,
            metric_basis: null,
            source: "official",
            reason: null,
          },
        }),
      ],
    });

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Too early")).toBeInTheDocument();
    expect(within(sheet).queryByText("0.0×")).toBeNull();
  });

  it("asks for the other period when the owner switches it", async () => {
    const onSelectPeriod = vi.fn();
    renderSheet({ onSelectPeriod });

    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("tab", { name: "Follower change · 30 days" }));

    await waitFor(() => expect(onSelectPeriod).toHaveBeenCalledWith(30));
  });

  it("reports a missing entry as not found instead of an empty report", async () => {
    renderSheet({ entry: null });

    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText("That competitor is no longer available."),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Retry loading" })).toBeInTheDocument();
  });
});
