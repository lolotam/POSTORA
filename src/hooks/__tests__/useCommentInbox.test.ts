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

// `useQuery` is wrapped, not replaced: the error-extraction cases above need the real client
// to run the queryFn, while the YouTube case needs to see the options the hook handed over.
const useQuerySpy = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-query", async (orig) => {
  const actual = await orig<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (...args: Parameters<typeof actual.useQuery>) => {
      useQuerySpy(...args);
      return actual.useQuery(...args);
    },
  };
});

import { parseYouTubeComments, useComments } from "../useCommentInbox";

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

describe("parseYouTubeComments", () => {
  it("flattens videos -> threads -> replies into the inbox shape, video title as the post label", () => {
    const comments = parseYouTubeComments({
      videos: [{
        id: "v1", title: "Launch day", url: "https://www.youtube.com/watch?v=v1",
        threads: [{
          id: "t1", text: "hello", author: { id: "UC-ann", name: "Ann", avatar_url: null }, published_at: "2026-09-01T00:00:00Z",
          like_count: 2, moderation_status: "rejected", is_own: false, total_reply_count: 1,
          replies: [{ id: "r1", text: "hi", author: { id: "UC-me", name: "Me", avatar_url: null }, published_at: "2026-09-01T01:00:00Z", like_count: 0, moderation_status: null, is_own: true }],
        }],
      }],
    });
    expect(comments.map((c) => [c.id, c.is_reply, c.parent_id, c.is_hidden, c.is_own, c.post_message])).toEqual([
      ["r1", true, "t1", false, true, "Launch day"],
      ["t1", false, undefined, true, false, "Launch day"],
    ]);
    expect(comments.every((c) => c.platform === "youtube")).toBe(true);
  });
});

describe("useComments for YouTube", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useQuerySpy.mockClear();
  });

  it("asks for the YouTube action, needs no page id, and never auto-refetches", async () => {
    // Each YouTube read costs 2 quota units (threads + titles); a 30 s poll from one open tab
    // would burn most of the 10,000 daily units. The poller's inbox writes invalidate the
    // query instead, and the Refresh button covers the rest.
    invokeMock.mockResolvedValue({ data: { videos: [] }, error: null });
    const { result } = renderHook(
      () => useComments({ platform: "youtube", socialAccountId: "acc-yt" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invokeMock).toHaveBeenCalledWith("comment-manager", {
      body: expect.objectContaining({ action: "get_youtube_comments", social_account_id: "acc-yt" }),
    });
    expect(useQuerySpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["comments", "youtube", "acc-yt"], enabled: true, refetchInterval: false }),
    );
  });
});
