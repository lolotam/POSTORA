import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { YouTubeBenchmarkError } from "../domain/errors";
import type { YouTubeBenchmarkChannel } from "../domain/types";
import type { YouTubeBenchmarkGateway } from "./ports";
import { useYouTubeChannelBenchmark, youtubeBenchmarkChannelKey } from "./useYouTubeChannelBenchmark";

function channel(overrides: Partial<YouTubeBenchmarkChannel> = {}): YouTubeBenchmarkChannel {
  return {
    input: "@alpha",
    status: "found",
    channel_id: "UCabcdefghijklmnopqrstuv",
    title: "Alpha",
    thumbnail_url: null,
    subscriber_count: 10,
    subscriber_count_hidden: false,
    view_count: 100,
    video_count: 5,
    recent_videos: [],
    ...overrides,
  };
}

function envelope(channels: YouTubeBenchmarkChannel[]) {
  return {
    schema_version: 1 as const,
    request_id: "req-1",
    freshness: { fetched_at: "2026-11-27T10:00:00.000Z", source: "provider" as const },
    data: { account_id: "acc-a", channels },
  };
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function gatewayWith(lookupChannels: YouTubeBenchmarkGateway["lookupChannels"]) {
  return { lookupChannels } as YouTubeBenchmarkGateway;
}

describe("useYouTubeChannelBenchmark", () => {
  it("reads nothing before the creator asks for a comparison", async () => {
    const lookupChannels = vi.fn(() => Promise.resolve(envelope([])));
    renderHook(
      () =>
        useYouTubeChannelBenchmark({
          gateway: gatewayWith(lookupChannels),
          userId: "user-a",
          accountId: "acc-a",
        }),
      { wrapper: wrapperFor(new QueryClient()) },
    );

    await Promise.resolve();
    expect(lookupChannels).not.toHaveBeenCalled();
  });

  it("reads nothing without a signed-in user", async () => {
    const lookupChannels = vi.fn(() => Promise.resolve(envelope([])));
    const { result } = renderHook(
      () =>
        useYouTubeChannelBenchmark({
          gateway: gatewayWith(lookupChannels),
          userId: null,
          accountId: "acc-a",
        }),
      { wrapper: wrapperFor(new QueryClient()) },
    );

    await act(async () => {
      result.current.compare(["@alpha"]);
    });
    expect(lookupChannels).not.toHaveBeenCalled();
  });

  it("reads nothing without a connection to borrow the credential from", async () => {
    const lookupChannels = vi.fn(() => Promise.resolve(envelope([])));
    const { result } = renderHook(
      () =>
        useYouTubeChannelBenchmark({
          gateway: gatewayWith(lookupChannels),
          userId: "user-a",
          accountId: null,
        }),
      { wrapper: wrapperFor(new QueryClient()) },
    );

    await act(async () => {
      result.current.compare(["@alpha"]);
    });
    expect(lookupChannels).not.toHaveBeenCalled();
  });

  it("caches one entry per channel under the user's and the account's key", async () => {
    const client = new QueryClient();
    const lookupChannels = vi.fn(() => Promise.resolve(envelope([channel()])));
    const { result } = renderHook(
      () =>
        useYouTubeChannelBenchmark({
          gateway: gatewayWith(lookupChannels),
          userId: "user-a",
          accountId: "acc-a",
        }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      result.current.compare(["@Alpha"]);
    });
    await waitFor(() => expect(result.current.columns[0]?.state).toBe("ready"));

    expect(lookupChannels).toHaveBeenCalledTimes(1);
    expect(lookupChannels).toHaveBeenCalledWith({ accountId: "acc-a", channels: ["@alpha"] });
    const cached = client.getQueryData(youtubeBenchmarkChannelKey("user-a", "acc-a", "@alpha"));
    expect(cached).toMatchObject({ channel: { title: "Alpha" } });
  });

  it("serves a settled channel from the cache and spends no provider unit again", async () => {
    const client = new QueryClient();
    const lookupChannels = vi.fn(() => Promise.resolve(envelope([channel()])));
    const { result } = renderHook(
      () =>
        useYouTubeChannelBenchmark({
          gateway: gatewayWith(lookupChannels),
          userId: "user-a",
          accountId: "acc-a",
        }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      result.current.compare(["@alpha"]);
    });
    await waitFor(() => expect(result.current.columns[0]?.state).toBe("ready"));

    await act(async () => {
      result.current.compare(["@alpha"]);
    });
    await waitFor(() => expect(result.current.columns[0]?.state).toBe("ready"));

    expect(lookupChannels).toHaveBeenCalledTimes(1);
  });

  it("reads an unavailable channel again while the settled one stays cached", async () => {
    const client = new QueryClient();
    const lookupChannels = vi
      .fn()
      .mockResolvedValueOnce(
        envelope([
          channel({ input: "@alpha" }),
          channel({ input: "@beta", status: "unavailable", error: "quota_exceeded" }),
        ]),
      )
      .mockResolvedValueOnce(envelope([channel({ input: "@beta", status: "found" })]));
    const { result } = renderHook(
      () =>
        useYouTubeChannelBenchmark({
          gateway: gatewayWith(lookupChannels),
          userId: "user-a",
          accountId: "acc-a",
        }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      result.current.compare(["@alpha", "@beta"]);
    });
    await waitFor(() => expect(result.current.columns[1]?.channel?.status).toBe("unavailable"));

    await act(async () => {
      result.current.compare(["@alpha", "@beta"]);
    });
    await waitFor(() => expect(result.current.columns[1]?.channel?.status).toBe("found"));

    expect(lookupChannels).toHaveBeenCalledTimes(2);
    // The second read names ONLY the channel that was not settled.
    expect(lookupChannels).toHaveBeenLastCalledWith({ accountId: "acc-a", channels: ["@beta"] });
  });

  it("retries one channel without reading the others again", async () => {
    const client = new QueryClient();
    const lookupChannels = vi
      .fn()
      .mockResolvedValueOnce(
        envelope([
          channel({ input: "@alpha" }),
          channel({ input: "@beta", status: "unavailable", error: "upstream_unavailable" }),
        ]),
      )
      .mockResolvedValueOnce(envelope([channel({ input: "@beta", status: "found" })]));
    const { result } = renderHook(
      () =>
        useYouTubeChannelBenchmark({
          gateway: gatewayWith(lookupChannels),
          userId: "user-a",
          accountId: "acc-a",
        }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      result.current.compare(["@alpha", "@beta"]);
    });
    await waitFor(() => expect(result.current.columns[1]?.channel?.status).toBe("unavailable"));

    await act(async () => {
      result.current.retry("@beta");
    });
    await waitFor(() => expect(result.current.columns[1]?.channel?.status).toBe("found"));

    expect(lookupChannels).toHaveBeenCalledTimes(2);
    expect(lookupChannels).toHaveBeenLastCalledWith({ accountId: "acc-a", channels: ["@beta"] });
  });

  it("never caches a failed request as a fresh answer", async () => {
    const client = new QueryClient();
    const lookupChannels = vi
      .fn()
      .mockRejectedValueOnce(new YouTubeBenchmarkError("quota_exceeded"))
      .mockResolvedValueOnce(envelope([channel()]));
    const { result } = renderHook(
      () =>
        useYouTubeChannelBenchmark({
          gateway: gatewayWith(lookupChannels),
          userId: "user-a",
          accountId: "acc-a",
        }),
      { wrapper: wrapperFor(client) },
    );

    await act(async () => {
      result.current.compare(["@alpha"]);
    });
    await waitFor(() => expect(result.current.columns[0]?.state).toBe("failed"));
    expect(result.current.columns[0]?.error?.code).toBe("quota_exceeded");
    expect(client.getQueryData(youtubeBenchmarkChannelKey("user-a", "acc-a", "@alpha"))).toBeUndefined();

    await act(async () => {
      result.current.compare(["@alpha"]);
    });
    await waitFor(() => expect(result.current.columns[0]?.state).toBe("ready"));
    expect(lookupChannels).toHaveBeenCalledTimes(2);
  });
});
