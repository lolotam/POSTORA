import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import i18n from "@/i18n";

import { InstagramPerformanceScreen } from "../InstagramPerformanceScreen";
import { reportFixture } from "../../tests/reportFixture";
import type { OwnerAnalyticsReadiness } from "../../../../../supabase/functions/_shared/ownerAnalyticsReadiness";
import { SyncStatusBanner } from "../SyncStatusBanner";
import { useInstagramInsightsReport } from "../../application/useInstagramInsightsReport";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "readiness-owner" } }) }));
vi.mock("@/hooks/useSocialAccounts", () => ({ useSocialAccounts: () => ({ isLoading: false, data: [
  { id: "acc-123", platform: "instagram", platform_username: "first", is_active: true },
  { id: "acc-second", platform: "instagram", platform_username: "second", is_active: true },
] }) }));

function readiness(reason: "collection_not_eligible" | "queued" = "collection_not_eligible"): OwnerAnalyticsReadiness {
  return { collection: { contract_version: 2, state: reason === "queued" ? "syncing" : "not_enabled", reason_code: reason,
    reason_source: "rollout_policy", observed_at: "2026-11-14T09:00:00Z", next_action: "contact_support", reconnect_can_help: false,
    retry_at: null, support_correlation_id: "fixture-correlation" }, connection: { state: "unverified", reason_code: "bootstrap_required" },
    permission: { state: "unknown", observed_at: null, missing_scopes: [] },
    last_attempt: { state: "retry", reason_code: "capability_missing", observed_at: "2026-11-05T09:00:00Z" } };
}

describe("Instagram readiness consumers", () => {
  it("never labels stale measurements up to date", () => {
    render(<SyncStatusBanner freshness={reportFixture().freshness}
      data={{ state: "stale", observation_count: 7, coverage: "complete", last_successful_capture: "2026-11-01T00:00:00Z" }}
      isSyncing={false} onSync={() => {}} />);
    expect(screen.getByText("Saved measurements are out of date")).toBeInTheDocument();
    expect(screen.queryByText("Up to date")).not.toBeInTheDocument();
  });

  it("refreshes queued collection, stops at completion or five minutes", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    let reason: "queued" | "ready" = "queued";
    const gateway = { triggerSync: vi.fn(), getReport: vi.fn(async () => ({ ...reportFixture(), ...readiness("queued"),
      collection: { ...readiness("queued").collection, reason_code: reason, state: reason === "ready" ? "ready" as const : "syncing" as const } })) };
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { unmount } = renderHook(() => useInstagramInsightsReport({ gateway, socialAccountId: "acc-123", periodDays: 7 }), { wrapper });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(gateway.getReport).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(gateway.getReport).toHaveBeenCalledTimes(2);
      reason = "ready";
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      const completedCalls = gateway.getReport.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(gateway.getReport).toHaveBeenCalledTimes(completedCalls);
      reason = "queued";
      await act(async () => { await client.invalidateQueries(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(360_000); });
      const boundedCalls = gateway.getReport.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(gateway.getReport).toHaveBeenCalledTimes(boundedCalls);
    } finally { unmount(); client.clear(); vi.useRealTimers(); }
  });
  it("switches account readiness and restores only that account's cached report", async () => {
    const gateway = { triggerSync: vi.fn(), getReport: vi.fn(async ({ socialAccountId }: { socialAccountId: string }) => ({
      ...reportFixture(), scope: { ownerId: "readiness-owner", socialAccountId, platform: "instagram" as const }, ...readiness(socialAccountId === "acc-second" ? "queued" : "collection_not_eligible"),
      data: { state: "empty" as const, observation_count: 0, coverage: "unknown" as const, last_successful_capture: null },
      freshness: { ...reportFixture().freshness, status: "never" as const, partial: false, lastSuccessAt: null, reason: null },
    })) };
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><InstagramPerformanceScreen gateway={gateway} /></MemoryRouter>
    </QueryClientProvider>);
    expect(await screen.findByText(/Analytics collection is not enabled/)).toBeInTheDocument();
    expect(screen.queryByText(/48 hours/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("combobox")[0]);
    fireEvent.click(await screen.findByRole("option", { name: /second/i }));
    expect(await screen.findByText("Analytics collection is queued.")).toBeInTheDocument();
    expect(screen.queryByText(/Analytics collection is not enabled/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("combobox")[0]);
    fireEvent.click(await screen.findByRole("option", { name: /first/i }));
    await waitFor(() => expect(screen.getByText(/Analytics collection is not enabled/)).toBeInTheDocument());
    expect(screen.queryByText("Analytics collection is queued.")).not.toBeInTheDocument();
  });
});
