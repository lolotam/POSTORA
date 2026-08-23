import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const fromMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (...a: unknown[]) => fromMock(...a) },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { usePlanQuotas } from "../usePlanQuotas";
import type { PlanQuota } from "../usePlanQuotas";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

type PlansRow = {
  id: string;
  slug: string;
  name: string;
  profile_limit: number | null;
  max_social_accounts: number | null;
  max_posts_per_month: number | null;
  max_posts_per_day: number | null;
  max_media_uploads_per_day: number | null;
};

/**
 * Installs a subscription_plans table double that supports BOTH chains the
 * hook uses: select().order() for reads and update().eq() for writes.
 * Returns handles capturing the written payload and eq() arguments.
 */
function mockPlansTable(rows: PlansRow[]) {
  const calls: {
    updatePayload?: Record<string, unknown>;
    eqArgs?: [string, unknown];
  } = {};
  fromMock.mockImplementation(() => ({
    select: () => ({
      order: () => Promise.resolve({ data: rows, error: null }),
    }),
    update: (payload: Record<string, unknown>) => {
      calls.updatePayload = payload;
      return {
        eq: (column: string, value: unknown) => {
          calls.eqArgs = [column, value];
          return Promise.resolve({ error: null });
        },
      };
    },
  }));
  return calls;
}

const FREE_ROW: PlansRow = {
  id: "p1",
  slug: "free",
  name: "Free",
  profile_limit: 2,
  max_social_accounts: 3,
  max_posts_per_month: 30,
  max_posts_per_day: 2,
  max_media_uploads_per_day: 20,
};

describe("usePlanQuotas", () => {
  beforeEach(() => fromMock.mockReset());

  it("reads plans from subscription_plans, not app_settings", async () => {
    mockPlansTable([FREE_ROW]);

    const { result } = renderHook(() => usePlanQuotas(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(fromMock).toHaveBeenCalledWith("subscription_plans");
    expect(fromMock).not.toHaveBeenCalledWith("app_settings");
    expect(result.current.quotas[0].max_posts_per_day).toBe(2);
    expect(result.current.quotas[0].plan_slug).toBe("free");
  });

  it("keeps NULL plan columns as null instead of coercing them to 0 (A10)", async () => {
    mockPlansTable([
      {
        id: "p2",
        slug: "trial",
        name: "Trial",
        profile_limit: null,
        max_social_accounts: null,
        max_posts_per_month: null,
        max_posts_per_day: null,
        max_media_uploads_per_day: null,
      },
    ]);

    const { result } = renderHook(() => usePlanQuotas(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.quotas[0].profile_limit).toBeNull();
    expect(result.current.quotas[0].max_social_accounts).toBeNull();
    expect(result.current.quotas[0].max_posts_per_month).toBeNull();
    expect(result.current.quotas[0].max_posts_per_day).toBeNull();
    expect(result.current.quotas[0].max_media_uploads_per_day).toBeNull();
  });

  it("updateQuota writes edited values to subscription_plans keyed by id (A13)", async () => {
    const calls = mockPlansTable([FREE_ROW]);

    const { result } = renderHook(() => usePlanQuotas(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const edited: PlanQuota = {
      id: "p1",
      plan_slug: "free",
      plan_name: "Free",
      profile_limit: 5,
      max_social_accounts: null,
      max_posts_per_month: 100,
      max_posts_per_day: 10,
      max_media_uploads_per_day: -1,
    };

    act(() => result.current.updateQuota.mutate(edited));
    await waitFor(() => expect(result.current.updateQuota.isSuccess).toBe(true));

    expect(calls.updatePayload).toMatchObject({
      profile_limit: 5,
      max_social_accounts: null,
      max_posts_per_month: 100,
      max_posts_per_day: 10,
      max_media_uploads_per_day: -1,
    });
    // A10: a NULL field must be sent as null, never coerced to 0.
    expect(calls.updatePayload?.max_social_accounts).toBeNull();
    expect(calls.updatePayload?.max_social_accounts).not.toBe(0);
    expect(calls.eqArgs).toEqual(["id", "p1"]);
    expect(fromMock).toHaveBeenCalledWith("subscription_plans");
    expect(fromMock).not.toHaveBeenCalledWith("app_settings");
  });
});
