import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { OwnerReportCursor, OwnerReportPeriodDays } from "../../domain/types";
import { mediaFixture, reportFixture } from "../../tests/reportFixture";
import { InstagramPerformanceScreen } from "../InstagramPerformanceScreen";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "test-user-id" } }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [{ id: "acc-123", platform: "instagram", platform_username: "testcreator", is_active: true }],
    isLoading: false,
  }),
}));

const rows = Array.from({ length: 21 }, (_, index) => mediaFixture({
  id: `snapshot-${index}`,
  mediaId: `media-${index}`,
  publishedAt: new Date(Date.UTC(2026, 9, 26 - index)).toISOString(),
}));

function reportPage(periodDays: OwnerReportPeriodDays = 30, cursor: OwnerReportCursor | null = null) {
  return reportFixture({
    request: { periodDays, limit: 20, cursor },
    mediaSnapshots: rows,
  });
}

function renderPerformance() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><InstagramPerformanceScreen /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Instagram performance pagination through the real gateway and report assembler", () => {
  beforeEach(() => {
    vi.mocked(supabase.functions.invoke).mockReset();
  });

  it("accumulates overlapping pages once and hides Load more at the end", async () => {
    vi.mocked(supabase.functions.invoke).mockImplementation(async (_name, options) => {
      const body = options?.body as { period_days: OwnerReportPeriodDays; cursor?: OwnerReportCursor };
      const report = reportPage(body.period_days, body.cursor ?? null);
      if (body.cursor) {
        report.media.page.items.unshift(reportPage().media.page.items[0]);
        report.media.page.returned = report.media.page.items.length;
      }
      return { data: report, error: null };
    });
    renderPerformance();
    expect(await screen.findByText("media-0")).toBeInTheDocument();
    expect(screen.queryByText("media-20")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Load more/i }));

    expect(await screen.findByText("media-20")).toBeInTheDocument();
    expect(screen.getAllByText("media-0")).toHaveLength(1);
    expect(screen.getAllByRole("row")).toHaveLength(22);
    expect(screen.queryByRole("button", { name: /Load more/i })).not.toBeInTheDocument();
  });

  it("starts at the first page for a different period without retaining old media", async () => {
    vi.mocked(supabase.functions.invoke).mockImplementation(async (_name, options) => {
      const body = options?.body as { period_days: OwnerReportPeriodDays; cursor?: OwnerReportCursor };
      return { data: reportPage(body.period_days, body.cursor ?? null), error: null };
    });
    renderPerformance();
    expect(await screen.findByText("media-0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Load more/i }));
    expect(await screen.findByText("media-20")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^7d$/i }));

    await waitFor(() => {
      expect(screen.queryByText("media-20")).not.toBeInTheDocument();
      expect(screen.getByText("media-0")).toBeInTheDocument();
      expect(screen.getAllByRole("row")).toHaveLength(6);
    });
    expect(screen.queryByRole("button", { name: /Load more/i })).not.toBeInTheDocument();
  });

  it("keeps already loaded media visible when the next page fails", async () => {
    vi.mocked(supabase.functions.invoke)
      .mockResolvedValueOnce({ data: reportPage(), error: null })
      .mockResolvedValue({
        data: null,
        error: new FunctionsHttpError(new Response(JSON.stringify({ error: "request_unavailable" }), { status: 503 })),
      });
    renderPerformance();
    expect(await screen.findByText("media-0")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Load more/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("media-0")).toBeInTheDocument();
    expect(screen.queryByText("media-20")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Load more/i })).not.toBeDisabled();
  });
});
