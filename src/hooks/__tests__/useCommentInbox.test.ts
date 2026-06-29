import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const invokeMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "test-user" } }),
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}));

import { useComments } from "../useCommentInbox";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

function renderComments() {
  return renderHook(
    () =>
      useComments({
        platform: "instagram",
        socialAccountId: "acc-1",
        igUserId: "ig-1",
      }),
    { wrapper },
  );
}

describe("useComments object-shaped error extraction", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("extracts error_user_msg first", async () => {
    invokeMock.mockResolvedValue({
      data: { error_type: "permission", error: { error_user_msg: "Reconnect required" } },
      error: null,
    });
    const { result } = renderComments();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe("Reconnect required");
  });

  it("falls back to message when error_user_msg missing", async () => {
    invokeMock.mockResolvedValue({
      data: { error_type: "token", error: { message: "Token expired" } },
      error: null,
    });
    const { result } = renderComments();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe("Token expired");
  });

  it("falls back to error_description when message variants missing", async () => {
    invokeMock.mockResolvedValue({
      data: { error_type: "oauth", error: { error_description: "Bad scope" } },
      error: null,
    });
    const { result } = renderComments();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe("Bad scope");
  });

  it("never renders [object Object] for unknown shapes", async () => {
    invokeMock.mockResolvedValue({
      data: { error_type: "unknown", error: { weird: "shape" } },
      error: null,
    });
    const { result } = renderComments();
    await waitFor(() => expect(result.current.isError).toBe(true));
    const msg = (result.current.error as Error).message;
    expect(msg).not.toBe("[object Object]");
    expect(msg).toContain("weird");
  });
});
