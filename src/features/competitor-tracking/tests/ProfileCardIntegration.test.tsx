import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import analyticsAr from "@/i18n/locales/ar/analytics.json";
import { ProfileCard } from "@/components/brand-intelligence/ProfileCard";
import { ScrapeHistory } from "@/components/brand-intelligence/ScrapeHistory";
import type { BrandProfile, BrandPost } from "@/types/brand-intelligence";
import type { CompetitorTrackingGateway } from "../application/ports";
import { TrackCompetitorControl } from "../ui/TrackCompetitorControl";

/**
 * The shared card and the pages that compose it.
 *
 * WHAT THIS SUITE PROVES
 *
 *   The competitor tracking feature reaches the owner through the
 *   SHARED brand intelligence card, and it does so without changing
 *   that card for anybody else: a Facebook, Threads or TikTok card
 *   looks exactly as it looked before (spec §2, T8-11).
 *
 *   The provenance of an observation is EXPLICIT. The card states the
 *   source it was given and never reads one out of the handle, the
 *   platform or the strategy the scrape happened to use (T8-01).
 *
 * WHY THE SOURCES ARE READ FROM THE PRODUCER
 *
 *   The producer's explicit provenance survives interactive responses
 *   and saved profile data. A record without that provenance remains
 *   "unknown"; a handle or cache strategy alone cannot establish it.
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

const authState = vi.hoisted(() => ({
  user: { id: "user-a" } as { id: string } | null,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: authState.user,
    isLoading: false,
    session: authState.user ? { user: { id: authState.user.id } } : null,
  }),
}));

const supabaseState = vi.hoisted(() => ({
  sessions: [] as unknown[],
  error: null as { message: string } | null,
}));

vi.mock("@/integrations/supabase/client", () => {
  const chain = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    eq: () => chain,
    ilike: () => chain,
    delete: () => chain,
    in: () => chain,
    then: (resolve: (value: { data: unknown[] | null; error: { message: string } | null }) => unknown) =>
      resolve({ data: supabaseState.error ? null : supabaseState.sessions, error: supabaseState.error }),
  };
  return {
    supabase: {
      from: () => chain,
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
      },
    },
  };
});

const WATCHLIST_ID = "3f2b6c1e-9a44-4f0a-8b21-7c5d9e0a1b23";

const QUOTA = {
  max_tracked_competitors: 5,
  unlimited: false,
  tracked_active: 0,
  remaining: 5,
};

function createGateway() {
  return {
    list: vi.fn(async () => ({
      version: 1,
      as_of: "2026-10-30T08:00:00Z",
      capture_timezone: "Asia/Kuwait",
      quota: QUOTA,
      next_cursor: null,
      entries: [],
    })),
    detail: vi.fn(),
    quota: vi.fn(async () => QUOTA),
    status: vi.fn(),
    add: vi.fn(async () => ({
      watchlistId: WATCHLIST_ID,
      username: "northwind",
      isActive: true,
      status: "pending",
      reactivated: false,
      alreadyTracked: false,
      quota: QUOTA,
    })),
    setActive: vi.fn(),
    enqueue: vi.fn(async () => ({
      outcome: "accepted" as const,
      reason: "queued",
      jobId: null,
      jobGeneration: null,
      status: "queued",
      capturedOn: "2026-10-30",
    })),
  };
}

const POST: BrandPost = {
  id: "post-1",
  mediaType: "IMAGE",
  thumbnailUrl: "",
  caption: "",
  likesCount: 1,
  commentsCount: 0,
  engagementScore: 1,
  timestamp: "2026-10-30T08:00:00Z",
  permalink: "https://www.instagram.com/p/1",
};

function makeProfile(platform: BrandProfile["platform"]): BrandProfile {
  return {
    id: "profile-1",
    username: "northwind",
    fullName: "Northwind",
    bio: "A brand",
    avatarUrl: "",
    followersCount: 1200,
    followingCount: 40,
    postsCount: 12,
    isVerified: false,
    platform,
  };
}

function renderWithProviders(node: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(node, { wrapper: ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  ) });
}

beforeEach(() => {
  authState.user = { id: "user-a" };
  supabaseState.sessions = [];
  supabaseState.error = null;
});

describe("ProfileCard composition", () => {
  it("shows the Track control the Instagram composition added", async () => {
    const gateway = createGateway();

    renderWithProviders(
      <ProfileCard
        profile={makeProfile("instagram")}
        isLoading={false}
        source="official"
        actions={<TrackCompetitorControl username="northwind" gateway={gateway as unknown as CompetitorTrackingGateway} />}
      />,
    );

    expect(await screen.findByRole("button", { name: "Track" })).toBeInTheDocument();
    expect(screen.getByText("Official")).toBeInTheDocument();
  });

  it("tracks the handle the card was given", async () => {
    const gateway = createGateway();

    renderWithProviders(
      <ProfileCard
        profile={makeProfile("instagram")}
        isLoading={false}
        source="unknown"
        actions={<TrackCompetitorControl username="northwind" gateway={gateway as unknown as CompetitorTrackingGateway} />}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Track" }));

    expect(gateway.add).toHaveBeenCalledTimes(1);
    expect(gateway.add).toHaveBeenCalledWith({ username: "northwind", label: null });
  });

  it("leaves a card of another platform exactly as it was", () => {
    renderWithProviders(
      <ProfileCard
        profile={makeProfile("facebook")}
        isLoading={false}
        source="official"
        actions={<TrackCompetitorControl username="northwind" gateway={createGateway() as unknown as CompetitorTrackingGateway} />}
      />,
    );

    // The platform badge and the profile link are still there...
    expect(screen.getByText("Facebook")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View Profile" })).toBeInTheDocument();

    // ...and the Instagram-only composition is not.
    expect(screen.queryByRole("button", { name: "Track" })).toBeNull();
    expect(screen.queryByText("Official")).toBeNull();
    expect(screen.queryByText("Source unknown")).toBeNull();
  });

  it.each([
    ["official", "Official"],
    ["apify", "Third-party"],
    ["graph_own", "Own account"],
    ["unknown", "Source unknown"],
  ] as const)("states the %s source in words", (source, label) => {
    renderWithProviders(
      <ProfileCard profile={makeProfile("instagram")} isLoading={false} source={source} />,
    );

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("says nothing about a source it was not given", () => {
    renderWithProviders(
      <ProfileCard profile={makeProfile("instagram")} isLoading={false} />,
    );

    expect(screen.queryByText("Source unknown")).toBeNull();
    expect(screen.queryByText("Official")).toBeNull();
  });
});

describe("the shared card stays a shared card", () => {
  const profileCardSource = readFileSync(
    "src/components/brand-intelligence/ProfileCard.tsx",
    "utf8",
  );
  const instagramAnalyticsSource = readFileSync(
    "src/pages/analytics/InstagramAnalytics.tsx",
    "utf8",
  );
  const brandIntelligenceSource = readFileSync(
    "src/pages/BrandIntelligence.tsx",
    "utf8",
  );

  it("keeps the shared card free of database access", () => {
    expect(profileCardSource).not.toContain("@/integrations/supabase/client");
    expect(profileCardSource).not.toMatch(/\bsupabase\s*\./);
  });

  it("composes the competitor feature through its public exports only", () => {
    for (const source of [instagramAnalyticsSource, brandIntelligenceSource]) {
      expect(source).toContain('from "@/features/competitor-tracking"');
      expect(source).not.toContain("@/features/competitor-tracking/");
    }
  });

  it("adds no raw Supabase query to the pages", () => {
    // The pages already read the cached AI content of their own posts.
    // What must not appear is a NEW table read for the competitor
    // feature: the feature owns its own adapter (ARCHITECTURE §11).
    expect(instagramAnalyticsSource).not.toContain("competitor_watchlist");
    expect(instagramAnalyticsSource).not.toContain("competitor_profile_snapshots");
    expect(instagramAnalyticsSource).not.toContain("competitor_media_snapshots");
    expect(brandIntelligenceSource).not.toContain("competitor_watchlist");
    expect(brandIntelligenceSource).not.toContain("competitor_profile_snapshots");
    expect(brandIntelligenceSource).not.toContain("competitor_media_snapshots");
  });

  it("offers the Track control for Instagram only", () => {
    expect(instagramAnalyticsSource).toContain("TrackCompetitorControl");
    expect(brandIntelligenceSource).toContain("TrackCompetitorControl");
    expect(brandIntelligenceSource).toMatch(/platform\s*===\s*"instagram"/);
  });
});

describe("the history states the source it was given", () => {
  function makeSession(overrides: Record<string, unknown> = {}) {
    return {
      id: "session-1",
      user_id: "user-a",
      platform: "instagram",
      username: "northwind",
      profile_data: makeProfile("instagram"),
      posts_data: [],
      total_posts_fetched: 3,
      strategy_used: "official",
      api_endpoint: null,
      scraped_at: "2026-10-30T08:00:00Z",
      created_at: "2026-10-30T08:00:00Z",
      ...overrides,
    };
  }

  it("does not read a source out of the strategy the scrape used", async () => {
    supabaseState.sessions = [makeSession({ strategy_used: "official", source: null })];

    renderWithProviders(<ScrapeHistory onReuse={() => undefined} />);

    // The strategy is a fact about HOW the data was fetched...
    expect(await screen.findByText("Meta API")).toBeInTheDocument();

    // ...and it is not the source of the observation.
    expect(screen.getByText("Source unknown")).toBeInTheDocument();
    expect(screen.queryByText("Official")).toBeNull();
  });

  it("does not read a source out of a cached session", async () => {
    supabaseState.sessions = [
      makeSession({ strategy_used: "cache", api_endpoint: "brand_scrape_cache", source: null }),
    ];

    renderWithProviders(<ScrapeHistory onReuse={() => undefined} />);

    expect(await screen.findByText("cache")).toBeInTheDocument();
    expect(screen.getByText("Source unknown")).toBeInTheDocument();
  });

  it("states the explicit source of a session", async () => {
    supabaseState.sessions = [makeSession({ strategy_used: "apify", source: "apify" })];

    renderWithProviders(<ScrapeHistory onReuse={() => undefined} />);

    expect(await screen.findByText("Third-party")).toBeInTheDocument();
    expect(screen.queryByText("Source unknown")).toBeNull();
  });

  it("preserves the producer's profile source in a saved cache row and its reused profile", async () => {
    supabaseState.sessions = [makeSession({ strategy_used: "cache", source: null,
      profile_data: { ...makeProfile("instagram"), source: "official" }, posts_data: [POST] })];
    const onReuse = vi.fn();
    renderWithProviders(<ScrapeHistory onReuse={onReuse} />);

    expect(await screen.findByText("Official")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reuse" }));
    expect(onReuse).toHaveBeenCalledTimes(1);
    expect(onReuse.mock.calls[0][0].source).toBe("official");
  });

  it("does not show a failed history read as an empty history and retries the read", async () => {
    supabaseState.error = { message: "synthetic database read failure" };
    renderWithProviders(<ScrapeHistory onReuse={() => undefined} platform="instagram" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved analyses could not be read.");
    expect(screen.queryByText("No scraping history yet. Search for a brand to get started.")).toBeNull();
    expect(screen.queryByText("synthetic database read failure")).toBeNull();

    supabaseState.error = null;
    supabaseState.sessions = [makeSession()];
    await userEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    expect(await screen.findByText("@northwind")).toBeInTheDocument();
  });

  it("cannot reuse the previous owner's cached saved rows after an identity change", async () => {
    supabaseState.sessions = [makeSession({ username: "owner_a" })];
    const { rerender } = renderWithProviders(<ScrapeHistory onReuse={() => undefined} platform="instagram" />);
    expect(await screen.findByText("@owner_a")).toBeInTheDocument();

    authState.user = { id: "user-b" };
    supabaseState.sessions = [makeSession({ user_id: "user-b", username: "owner_b" })];
    rerender(<ScrapeHistory onReuse={() => undefined} platform="instagram" />);
    expect(screen.queryByText("@owner_a")).toBeNull();
    expect(await screen.findByText("@owner_b")).toBeInTheDocument();
  });

  it("refuses saved profile data for another platform in an Instagram history", async () => {
    supabaseState.sessions = [makeSession({ profile_data: makeProfile("facebook"), posts_data: [POST] })];
    const onReuse = vi.fn();
    renderWithProviders(<ScrapeHistory onReuse={onReuse} platform="instagram" />);
    await userEvent.click(await screen.findByRole("button", { name: "Reuse", exact: true }));
    expect(onReuse).not.toHaveBeenCalled();
  });

  it("hands the reused profile the source of its session", async () => {
    supabaseState.sessions = [
      makeSession({ strategy_used: "apify", source: "apify", posts_data: [POST] }),
    ];
    const onReuse = vi.fn();

    renderWithProviders(<ScrapeHistory onReuse={onReuse} />);

    await userEvent.click(await screen.findByRole("button", { name: "Reuse" }));

    expect(onReuse).toHaveBeenCalledTimes(1);
    expect(onReuse.mock.calls[0][0].source).toBe("apify");
  });

  it("hands a reused profile without a source an unknown one", async () => {
    supabaseState.sessions = [
      makeSession({ strategy_used: "official", source: null, posts_data: [POST] }),
    ];
    const onReuse = vi.fn();

    renderWithProviders(<ScrapeHistory onReuse={onReuse} />);

    await userEvent.click(await screen.findByRole("button", { name: "Reuse" }));

    expect(onReuse).toHaveBeenCalledTimes(1);
    expect(onReuse.mock.calls[0][0].source).toBe("unknown");
  });
});
