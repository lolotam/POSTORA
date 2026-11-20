import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { YouTubeResourceError } from "../domain/errors";
import type { YouTubeResourcesGateway } from "./ports";
import { useYouTubeVideos } from "./useYouTubeVideos";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));

function page(prefix: string, next: string | null) {
  return {
    schema_version: 1 as const,
    request_id: "req",
    freshness: { fetched_at: "2026-11-20T10:00:00.000Z", source: "provider" as const },
    data: {
      items: [{ id: `${prefix}-1`, title: `${prefix} video`, thumbnail_url: null, published_at: null, privacy_status: "public", url: "https://www.youtube.com/watch?v=x" }],
      next_page_token: next,
      total_results: 1,
    },
  };
}

function gatewayWith(listVideos: YouTubeResourcesGateway["listVideos"]): YouTubeResourcesGateway {
  const unused = () => Promise.reject(new Error("not used"));
  return { getCapabilities: unused, getChannel: unused, getVideo: unused, listVideos };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useYouTubeVideos", () => {
  it("never shows the previous account's videos after a switch", async () => {
    let releaseB: (value: ReturnType<typeof page>) => void = () => {};
    const listVideos = vi.fn(({ accountId }: { accountId: string }) =>
      accountId === "acc-a"
        ? Promise.resolve(page("A", null))
        : new Promise<ReturnType<typeof page>>((resolve) => { releaseB = resolve; }));
    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string }) => useYouTubeVideos({ gateway: gatewayWith(listVideos), accountId, enabled: true }),
      { wrapper: wrapper(), initialProps: { accountId: "acc-a" } },
    );
    await waitFor(() => expect(result.current.data?.pages[0].data.items[0].id).toBe("A-1"));

    rerender({ accountId: "acc-b" });
    expect(result.current.data).toBeUndefined();

    releaseB(page("B", null));
    await waitFor(() => expect(result.current.data?.pages[0].data.items[0].id).toBe("B-1"));
  });

  it("requests the next page with the cursor of the last page", async () => {
    const listVideos = vi.fn(({ pageToken }: { pageToken?: string | null }) =>
      Promise.resolve(pageToken ? page("second", null) : page("first", "PAGE2")));
    const { result } = renderHook(
      () => useYouTubeVideos({ gateway: gatewayWith(listVideos), accountId: "acc-a", enabled: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(listVideos).toHaveBeenLastCalledWith({ accountId: "acc-a", pageToken: "PAGE2" });
    expect(result.current.hasNextPage).toBe(false);
  });

  it("reports a failed page as an error, not as an empty list", async () => {
    const listVideos = vi.fn(() => Promise.reject(new YouTubeResourceError("quota_exceeded")));
    const { result } = renderHook(
      () => useYouTubeVideos({ gateway: gatewayWith(listVideos), accountId: "acc-a", enabled: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(listVideos).toHaveBeenCalledTimes(1);
  });

  it("does not call the gateway while disabled or without an account", () => {
    const listVideos = vi.fn(() => Promise.resolve(page("A", null)));
    renderHook(() => useYouTubeVideos({ gateway: gatewayWith(listVideos), accountId: null, enabled: true }), { wrapper: wrapper() });
    renderHook(() => useYouTubeVideos({ gateway: gatewayWith(listVideos), accountId: "acc-a", enabled: false }), { wrapper: wrapper() });
    expect(listVideos).not.toHaveBeenCalled();
  });
});
