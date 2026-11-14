import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import i18n from "@/i18n";
import { OwnerAnalyticsStatus } from "./OwnerAnalyticsStatus";
import { InstagramPerformanceScreen } from "../../instagram-insights/ui/InstagramPerformanceScreen";
import { reportFixture } from "../../instagram-insights/tests/reportFixture";
import type { OwnerAnalyticsReadiness } from "../../../../supabase/functions/_shared/ownerAnalyticsReadiness";

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

describe("owner analytics readiness", () => {
  it.each(["en", "ar"])("explains exclusion separately from empty data and historical attempts in %s", async (language) => {
    await i18n.changeLanguage(language);
    const { container } = render(<OwnerAnalyticsStatus report={{ ...readiness(), data: { state: "empty", observation_count: 0, coverage: "unknown", last_successful_capture: null } }} />);
    expect(container).toHaveTextContent(language === "ar" ? "جمع التحليلات لم يُفعّل" : "Analytics collection is not enabled");
    expect(container).toHaveTextContent(language === "ar" ? "لم تتم المزامنة" : "Never synced");
    expect(container).not.toHaveTextContent(/Reconnect|permissions are missing|Partially synced|48 hours/i);
    await i18n.changeLanguage("en");
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
