import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { YouTubeResourceError } from "../domain/errors";
import type { YouTubeResourcesGateway } from "./ports";
import { useYouTubeCapabilities } from "./useYouTubeCapabilities";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));

function capabilitiesData(accountId: string) {
  return {
    account_id: accountId,
    channel_id: "UC",
    channel_title: "Channel",
    provider: "native" as const,
    connection: "ok" as const,
    scopes: { readonly: "granted" as const, upload: "granted" as const, force_ssl: "granted" as const },
    capabilities: { browse: { state: "available" } as const, upload: { state: "available" } as const, comments: { state: "available" } as const },
    quota: {
      provider_quota: "not_tracked" as const,
      unit_costs: { channel: 1 as const, videos_page: 1 as const, video: 1 as const },
      per_user_burst: { limit: 30 as const, window_seconds: 600 as const },
      per_user_daily: { limit: 300 as const, window_seconds: 86400 as const },
    },
  };
}

function envelope<T>(data: T) {
  return {
    schema_version: 1 as const,
    request_id: "req",
    freshness: { fetched_at: "2026-11-20T10:00:00.000Z", source: "provider" as const },
    data,
  };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useYouTubeCapabilities", () => {
  it("recovers from one transient failure through the query retry", async () => {
    const getCapabilities = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new YouTubeResourceError("upstream_unavailable")))
      .mockImplementationOnce((accountId: string) => Promise.resolve(envelope(capabilitiesData(accountId))));
    const gateway: YouTubeResourcesGateway = {
      getCapabilities: getCapabilities as unknown as YouTubeResourcesGateway["getCapabilities"],
      getChannel: () => Promise.reject(new Error("not used")),
      listVideos: () => Promise.reject(new Error("not used")),
      getVideo: () => Promise.reject(new Error("not used")),
    };

    const { result } = renderHook(
      () => useYouTubeCapabilities({ gateway, accountId: "acc-a" }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.data?.data.capabilities.browse).toEqual({ state: "available" }));
    expect(getCapabilities).toHaveBeenCalledTimes(2);
  });
});
