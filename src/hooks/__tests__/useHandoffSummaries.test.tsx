import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The queue reads every conversation's handoff summary in ONE
// ai_conversation_modes query filtered by the current user and the listed
// conversation ids — never one query per row.

const db = vi.hoisted(() => ({ from: vi.fn(), eq: vi.fn(), in: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (...args: unknown[]) => db.from(...args) },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } } }),
}));

import { useHandoffSummaries } from "@/hooks/useHandoffSummaries";

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
    db.from.mockReturnValue({
      select: vi.fn(() => ({ eq: db.eq })),
    });
    db.eq.mockReturnValue({ in: db.in });
    db.in.mockResolvedValue({ data: [], error: null });
  });

  it("fetches all summaries in one user-scoped query keyed by conversation id", async () => {
    db.in.mockResolvedValue({
      data: [
        { conversation_id: "c2", handoff_summary: "Second", handoff_summary_at: null },
        { conversation_id: "c1", handoff_summary: "First", handoff_summary_at: "2026-09-25T09:00:00Z" },
        { conversation_id: "c3", handoff_summary: null, handoff_summary_at: null },
      ],
      error: null,
    });

    const { result } = renderHookWithClient(["c2", "c1"]);

    await waitFor(() => expect(result.current.summaries).toEqual({ c1: "First", c2: "Second" }));
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(db.from).toHaveBeenCalledWith("ai_conversation_modes");
    expect(db.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(db.in).toHaveBeenCalledWith("conversation_id", ["c1", "c2"]);
  });

  it("queries nothing while there are no conversations to list", async () => {
    const { result } = renderHookWithClient([]);

    expect(result.current.summaries).toEqual({});
    expect(db.from).not.toHaveBeenCalled();
  });
});
