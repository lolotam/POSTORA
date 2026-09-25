import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  from: vi.fn(), select: vi.fn(), eq: vi.fn(), in: vi.fn(), not: vi.fn(), gt: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (...args: unknown[]) => db.from(...args) },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } } }),
}));

import { useHandoffSummaries } from "@/hooks/useHandoffSummaries";

interface SummaryRow {
  user_id: string;
  conversation_id: string;
  handoff_summary: string | null;
  expires_at: string | null;
}

let rows: SummaryRow[];

function renderHookWithClient(conversationIds: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useHandoffSummaries(conversationIds), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

describe("useHandoffSummaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    db.from.mockImplementation(() => {
      const filters: Array<(row: SummaryRow) => boolean> = [];
      const query = {
        select: db.select, eq: db.eq, in: db.in, not: db.not, gt: db.gt,
        then: (resolve: (result: { data: SummaryRow[]; error: null }) => unknown) =>
          Promise.resolve({ data: rows.filter((row) => filters.every((filter) => filter(row))), error: null }).then(resolve),
      };
      db.select.mockReturnValue(query);
      db.eq.mockImplementation((column: keyof SummaryRow, value: string) => {
        filters.push((row) => row[column] === value);
        return query;
      });
      db.in.mockImplementation((column: keyof SummaryRow, ids: string[]) => {
        filters.push((row) => ids.includes(row[column] ?? ""));
        return query;
      });
      db.not.mockImplementation((column: keyof SummaryRow) => {
        filters.push((row) => row[column] !== null);
        return query;
      });
      db.gt.mockImplementation((column: keyof SummaryRow, value: string) => {
        filters.push((row) => row[column] !== null && row[column]! > value);
        return query;
      });
      return query;
    });
  });

  afterEach(() => vi.useRealTimers());

  it("fetches active user summaries once and matches a large queue locally", async () => {
    rows = [
      { user_id: "user-1", conversation_id: "c2", handoff_summary: "Second", expires_at: "2099-01-01T00:00:00.000Z" },
      { user_id: "user-1", conversation_id: "c1", handoff_summary: "First", expires_at: "2099-01-01T00:00:00.000Z" },
      { user_id: "user-1", conversation_id: "c3", handoff_summary: "Expired", expires_at: "2000-01-01T00:00:00.000Z" },
      { user_id: "user-1", conversation_id: "c4", handoff_summary: "Manual", expires_at: null },
      { user_id: "user-1", conversation_id: "c5", handoff_summary: null, expires_at: "2099-01-01T00:00:00.000Z" },
      { user_id: "user-1", conversation_id: "outside", handoff_summary: "Outside queue", expires_at: "2099-01-01T00:00:00.000Z" },
      { user_id: "user-2", conversation_id: "c1", handoff_summary: "Foreign", expires_at: "2099-01-01T00:00:00.000Z" },
    ];
    const before = new Date().toISOString();
    const { result } = renderHookWithClient(Array.from({ length: 3_000 }, (_, i) => `c${i}`));

    await waitFor(() => expect(result.current.summaries).toEqual({ c1: "First", c2: "Second" }));
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(db.from).toHaveBeenCalledWith("ai_conversation_modes");
    expect(db.select).toHaveBeenCalledWith("conversation_id, handoff_summary, expires_at");
    expect(db.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(db.not).toHaveBeenCalledWith("handoff_summary", "is", null);
    expect(db.gt).toHaveBeenCalledWith("expires_at", expect.any(String));
    const cutoff = db.gt.mock.calls[0][1] as string;
    expect(cutoff >= before && cutoff <= new Date().toISOString()).toBe(true);
    expect(new Date(cutoff).toISOString()).toBe(cutoff);
    expect(db.in).not.toHaveBeenCalled();
  });

  it("refreshes after 30 seconds and removes a summary that has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T00:00:00.000Z"));
    rows = [{ user_id: "user-1", conversation_id: "c1", handoff_summary: "Fresh", expires_at: "2026-09-26T00:00:30.000Z" }];
    const { result, unmount } = renderHookWithClient(["c1"]);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.summaries).toEqual({ c1: "Fresh" });
    await act(() => vi.advanceTimersByTimeAsync(30_001));
    expect(db.from).toHaveBeenCalledTimes(2);
    expect(result.current.summaries).toEqual({});
    unmount();
  });

  it("queries nothing while there are no conversations to list", () => {
    const { result } = renderHookWithClient([]);
    expect(result.current.summaries).toEqual({});
    expect(db.from).not.toHaveBeenCalled();
  });
});
