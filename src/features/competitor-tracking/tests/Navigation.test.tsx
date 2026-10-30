import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeAll } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Navigate, RouterProvider, createMemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import analyticsAr from "@/i18n/locales/ar/analytics.json";
import InstagramAnalytics from "@/pages/analytics/InstagramAnalytics";

/**
 * The reachable composition of the competitor tracking feature.
 *
 * WHAT THIS SUITE PROVES
 *
 *   The feature is reachable at `/analytics/instagram?tab=competitors`
 *   - the page the application actually serves - and the old
 *   `/brand-intelligence` entry point still lands there (spec §2).
 *
 *   The URL is the state. A tab the owner clicks, a history entry the
 *   owner walks back to and a query the owner edits all end up in the
 *   same place: the tab the URL names.
 *
 * WHY THE FEATURE IS REPLACED BY A MARKER
 *
 *   The screen is exercised on its own in the feature's own suite. Here
 *   it is the COMPOSITION that is under test: that the live page asks
 *   the feature's public exports for the tracked competitors screen and
 *   for the Track control. A deep import would not be intercepted by
 *   this replacement, so the composition is proven by the marker.
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

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "user-a" },
    isLoading: false,
    session: { user: { id: "user-a" } },
  }),
}));

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/features/instagram-insights", () => ({
  InstagramPerformanceScreen: () => <div>Performance panel</div>,
}));

vi.mock("@/features/competitor-tracking", () => ({
  CompetitorTrackingScreen: () => <div>Tracked competitors panel</div>,
  TrackCompetitorControl: () => <div>Track control</div>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
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

function renderRouter(router: ReturnType<typeof createMemoryRouter>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function renderPage(
  initialEntry: string,
  routePath = "/analytics/instagram",
  element: ReactNode = <InstagramAnalytics />,
) {
  const router = createMemoryRouter([{ path: routePath, element }], {
    initialEntries: [initialEntry],
  });
  return renderRouter(router);
}

describe("the Instagram analytics page", () => {
  it("shows the Performance tab by default", async () => {
    renderPage("/analytics/instagram");

    expect(await screen.findByText("Performance panel")).toBeInTheDocument();
    expect(screen.queryByText("Tracked competitors panel")).toBeNull();
  });

  it("keeps the Performance tab at the /performance route", async () => {
    const router = createMemoryRouter(
      [{ path: "/analytics/instagram/performance", element: <InstagramAnalytics defaultTab="performance" /> }],
      { initialEntries: ["/analytics/instagram/performance"] },
    );
    renderRouter(router);

    expect(await screen.findByText("Performance panel")).toBeInTheDocument();
    expect(screen.queryByText("Tracked competitors panel")).toBeNull();
  });

  it("keeps the analyze tab valid", async () => {
    renderPage("/analytics/instagram?tab=analyze");

    expect(
      await screen.findByPlaceholderText("Enter @username or instagram.com/username"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Performance panel")).toBeNull();
    expect(screen.queryByText("Tracked competitors panel")).toBeNull();
  });

  it("shows the tracked competitors at ?tab=competitors", async () => {
    renderPage("/analytics/instagram?tab=competitors");

    expect(await screen.findByText("Tracked competitors panel")).toBeInTheDocument();
    expect(screen.queryByText("Performance panel")).toBeNull();
  });

  it("follows the tab the owner clicks", async () => {
    const router = renderPage("/analytics/instagram");

    await userEvent.click(await screen.findByRole("button", { name: "Tracked competitors" }));

    expect(await screen.findByText("Tracked competitors panel")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?tab=competitors");
  });

  it("reconciles the tab when the owner walks back and forward", async () => {
    const router = renderPage("/analytics/instagram");

    await userEvent.click(await screen.findByRole("button", { name: "Tracked competitors" }));
    expect(await screen.findByText("Tracked competitors panel")).toBeInTheDocument();

    await act(async () => {
      await router.navigate(-1);
    });

    expect(await screen.findByText("Performance panel")).toBeInTheDocument();
    expect(screen.queryByText("Tracked competitors panel")).toBeNull();

    await act(async () => {
      await router.navigate(1);
    });

    expect(await screen.findByText("Tracked competitors panel")).toBeInTheDocument();
    expect(screen.queryByText("Performance panel")).toBeNull();
  });

  it("reconciles the tab when the query changes", async () => {
    const router = renderPage("/analytics/instagram");

    await act(async () => {
      await router.navigate("/analytics/instagram?tab=competitors");
    });

    expect(await screen.findByText("Tracked competitors panel")).toBeInTheDocument();

    await act(async () => {
      await router.navigate("/analytics/instagram?tab=performance");
    });

    expect(await screen.findByText("Performance panel")).toBeInTheDocument();
    expect(screen.queryByText("Tracked competitors panel")).toBeNull();
  });

  it("normalises an unknown tab to the default one", async () => {
    const router = renderPage("/analytics/instagram?tab=nonsense");

    expect(await screen.findByText("Performance panel")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?tab=performance");
  });
});

describe("the legacy entry point", () => {
  it("still redirects to the live page", async () => {
    const router = createMemoryRouter(
      [
        { path: "/brand-intelligence", element: <Navigate to="/analytics/instagram" replace /> },
        { path: "/analytics/instagram", element: <InstagramAnalytics /> },
      ],
      { initialEntries: ["/brand-intelligence"] },
    );
    renderRouter(router);

    expect(await screen.findByText("Performance panel")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/analytics/instagram");
  });

  it("keeps that redirect in the real route table", () => {
    const routesSource = readFileSync("src/components/AnimatedRoutes.tsx", "utf8");

    expect(routesSource).toContain('path="/brand-intelligence"');
    expect(routesSource).toContain('to="/analytics/instagram"');
    expect(routesSource).toContain('path="/analytics/instagram"');
  });
});
