import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import type { YouTubeResourcesGateway } from "../../application/ports";
import type { YouTubeCapabilityState } from "../../domain/types";
import { YouTubeResourceError } from "../../domain/errors";
import { YouTubeManagementScreen } from "../YouTubeManagementScreen";
import { youtubeResourceKey } from "../../application/queryKeys";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));

const ACCOUNTS = [
  { id: "acc-a", title: "Channel A", avatarUrl: null, provider: "native" as const },
  { id: "acc-b", title: "Channel B", avatarUrl: null, provider: "native" as const },
];

const envelope = <T,>(data: T) => ({
  schema_version: 1 as const,
  request_id: "req",
  freshness: { fetched_at: "2026-11-20T10:00:00.000Z", source: "provider" as const },
  data,
});

function gateway(browse: YouTubeCapabilityState = { state: "available" }): YouTubeResourcesGateway {
  return {
    getCapabilities: vi.fn((accountId: string) => Promise.resolve(envelope({
      account_id: accountId,
      channel_id: `UC-${accountId}`,
      channel_title: accountId,
      provider: "native" as const,
      connection: "ok" as const,
      scopes: { readonly: "granted" as const, upload: "granted" as const, force_ssl: "granted" as const },
      capabilities: { browse, upload: { state: "available" as const }, comments: { state: "available" as const } },
      quota: {
        provider_quota: "not_tracked" as const,
        unit_costs: { channel: 1 as const, videos_page: 2 as const, video: 1 as const },
        per_user_burst: { limit: 30 as const, window_seconds: 600 as const },
        per_user_daily: { limit: 300 as const, window_seconds: 86400 as const },
      },
    }))),
    getChannel: vi.fn((accountId: string) => Promise.resolve(envelope({
      id: `UC-${accountId}`, title: `Channel of ${accountId}`, description: "", custom_url: null, thumbnail_url: null,
      published_at: null, country: null, privacy_status: "public",
      statistics: { view_count: 1, subscriber_count: 1, subscriber_count_hidden: false, video_count: 1 },
    }))),
    listVideos: vi.fn(({ accountId }: { accountId: string }) => Promise.resolve(envelope({
      items: [{ id: `${accountId}-video`, title: `Video of ${accountId}`, thumbnail_url: null, published_at: null, privacy_status: "public", url: "https://www.youtube.com/watch?v=x" }],
      next_page_token: null,
      total_results: 1,
    }))),
    getVideo: vi.fn(({ videoId }: { accountId: string; videoId: string }) => Promise.resolve(envelope({
      id: videoId, channel_id: "UC", title: `Details of ${videoId}`, description: "", thumbnail_url: null, published_at: null,
      tags: [], category_id: null, default_language: null, duration_iso8601: null, privacy_status: "public",
      upload_status: null, made_for_kids: null, statistics: { view_count: null, like_count: null, comment_count: null },
      url: "https://www.youtube.com/watch?v=x",
    }))),
  };
}

async function renderScreen(ui: ReactElement, locale: "en" | "ar" = "en") {
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { en: { accounts: {} }, ar: { accounts: {} } }, defaultNS: "accounts" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <MemoryRouter><QueryClientProvider client={client}><I18nextProvider i18n={i18n}>{ui}</I18nextProvider></QueryClientProvider></MemoryRouter>,
  );
  return {
    ...view,
    client,
    rerenderWith: (next: ReactElement) => view.rerender(
      <MemoryRouter><QueryClientProvider client={client}><I18nextProvider i18n={i18n}>{next}</I18nextProvider></QueryClientProvider></MemoryRouter>,
    ),
  };
}

describe("YouTubeManagementScreen", () => {
  it("invites a user with no YouTube channel to connect one", async () => {
    await renderScreen(<YouTubeManagementScreen accounts={[]} accountsLoading={false} gateway={gateway()} />);
    expect(screen.getByText("No YouTube channel is connected yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Profiles" })).toHaveAttribute("href", "/profiles");
  });

  it("loads the first channel, its videos, and the details of a picked video", async () => {
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={gateway()} />);
    expect(await screen.findByRole("heading", { name: "Channel of acc-a" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    expect(await screen.findByRole("heading", { name: "Details of acc-a-video" })).toBeInTheDocument();
  });

  it("drops the previous channel's video and details when the account changes", async () => {
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={gateway()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    await screen.findByRole("heading", { name: "Details of acc-a-video" });

    await userEvent.selectOptions(screen.getByLabelText("Channel"), "acc-b");

    expect(screen.queryByRole("heading", { name: "Details of acc-a-video" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Video of acc-a/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Video of acc-b/ })).toBeInTheDocument();
  });

  it("explains an unavailable browse capability and spends no provider call", async () => {
    const fake = gateway({ state: "unavailable", reason: "provider_unsupported" });
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("managed connector");
    await waitFor(() => expect(fake.getCapabilities).toHaveBeenCalled());
    expect(fake.getChannel).not.toHaveBeenCalled();
    expect(fake.listVideos).not.toHaveBeenCalled();
  });

  it("refetches the channel and the videos when the user clicks Refresh", async () => {
    const fake = gateway();
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    await screen.findByRole("heading", { name: "Channel of acc-a" });
    expect(fake.getChannel).toHaveBeenCalledTimes(1);
    expect(fake.listVideos).toHaveBeenCalledTimes(1);

    await userEvent.click(await screen.findByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(fake.getChannel).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.listVideos).toHaveBeenCalledTimes(2));
  });

  it("keeps Refresh disabled and spends no call when browse is unavailable", async () => {
    const fake = gateway({ state: "unavailable", reason: "provider_unsupported" });
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("managed connector");

    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh).toBeDisabled();
    await userEvent.click(refresh);

    expect(fake.getCapabilities).toHaveBeenCalledTimes(1);
    expect(fake.getChannel).not.toHaveBeenCalled();
    expect(fake.listVideos).not.toHaveBeenCalled();
  });

  it("refetches capabilities from Refresh after a rate limited failure", async () => {
    const base = gateway();
    const caps = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new YouTubeResourceError("rate_limited", 120)))
      .mockImplementationOnce((accountId: string) => base.getCapabilities(accountId));
    const fake: YouTubeResourcesGateway = {
      ...base,
      getCapabilities: caps as unknown as YouTubeResourcesGateway["getCapabilities"],
    };
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Try again in about 2 min.");

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("heading", { name: "Channel of acc-a" })).toBeInTheDocument();
    expect(caps).toHaveBeenCalledTimes(2);
  });

  it("keeps loaded pages visible when Load more fails and retries only the next page", async () => {
    const videoItem = (id: string) => ({
      id, title: `Video ${id}`, thumbnail_url: null, published_at: null, privacy_status: "public", url: "https://www.youtube.com/watch?v=x",
    });
    const pageOf = (items: ReturnType<typeof videoItem>[], next: string | null) => envelope({
      items, next_page_token: next, total_results: null,
    });
    const listVideos = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(pageOf([videoItem("one")], "P2")))
      .mockImplementationOnce(() => Promise.resolve(pageOf([videoItem("two")], "P3")))
      .mockImplementationOnce(() => Promise.reject(new YouTubeResourceError("upstream_unavailable")))
      .mockImplementationOnce(() => Promise.reject(new YouTubeResourceError("upstream_unavailable")))
      .mockImplementationOnce(() => Promise.resolve(pageOf([videoItem("three")], null)));
    const base = gateway();
    const fake: YouTubeResourcesGateway = { ...base, listVideos: listVideos as unknown as YouTubeResourcesGateway["listVideos"] };
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);

    await screen.findByRole("button", { name: /Video one/ });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /Video two/ });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("YouTube did not answer");

    expect(screen.getByRole("button", { name: /Video one/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Video two/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: /Video three/ })).toBeInTheDocument();
    expect(listVideos).toHaveBeenCalledTimes(5);
  });

  it("ignores the selected video when its account disappears from the list", async () => {
    const fake = gateway();
    const view = await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    expect(await screen.findByRole("heading", { name: "Details of acc-a-video" })).toBeInTheDocument();
    expect(fake.getVideo).toHaveBeenCalledTimes(1);

    view.rerenderWith(<YouTubeManagementScreen accounts={[ACCOUNTS[1]]} accountsLoading={false} gateway={fake} />);

    await screen.findByRole("button", { name: /Video of acc-b/ });
    expect(fake.getVideo).toHaveBeenCalledTimes(1);
  });

  it("shows a loading status while the channel loads", async () => {
    const base = gateway();
    const fake: YouTubeResourcesGateway = {
      ...base,
      getChannel: () => new Promise(() => {}),
    };
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    const statuses = await screen.findAllByRole("status");
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[0]).toHaveTextContent("Loading…");
  });

  it("renders a video id repeated across pages once", async () => {
    const videoItem = (id: string, title: string) => ({
      id, title, thumbnail_url: null, published_at: null, privacy_status: "public", url: "https://www.youtube.com/watch?v=x",
    });
    const pageOf = (items: ReturnType<typeof videoItem>[], next: string | null) => envelope({
      items, next_page_token: next, total_results: null,
    });
    const listVideos = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(pageOf([videoItem("dup", "Repeated video")], "P2")))
      .mockImplementationOnce(() => Promise.resolve(pageOf([videoItem("dup", "Repeated video"), videoItem("other", "Other video")], null)));
    const base = gateway();
    const fake: YouTubeResourcesGateway = { ...base, listVideos: listVideos as unknown as YouTubeResourcesGateway["listVideos"] };
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);

    await screen.findByRole("button", { name: /Repeated video/ });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("button", { name: /Other video/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Repeated video/ })).toHaveLength(1);
  });

  it("keeps cached pages visible when a Refresh of the list fails and retries the whole list", async () => {
    const videoItem = (id: string) => ({
      id, title: `Video ${id}`, thumbnail_url: null, published_at: null, privacy_status: "public", url: "https://www.youtube.com/watch?v=x",
    });
    const pageOf = (items: ReturnType<typeof videoItem>[], next: string | null) => envelope({
      items, next_page_token: next, total_results: null,
    });
    const listVideos = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(pageOf([videoItem("one")], "P2")))
      .mockImplementationOnce(() => Promise.reject(new YouTubeResourceError("upstream_unavailable")))
      .mockImplementationOnce(() => Promise.reject(new YouTubeResourceError("upstream_unavailable")))
      .mockImplementationOnce(() => Promise.resolve(pageOf([videoItem("two")], null)));
    const base = gateway();
    const fake: YouTubeResourcesGateway = { ...base, listVideos: listVideos as unknown as YouTubeResourcesGateway["listVideos"] };
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    await screen.findByRole("button", { name: /Video one/ });

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("YouTube did not answer");
    expect(screen.getByRole("button", { name: /Video one/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("button", { name: /Video two/ })).toBeInTheDocument();
    expect(listVideos).toHaveBeenCalledTimes(4);
    expect(listVideos).toHaveBeenLastCalledWith({ accountId: "acc-a", pageToken: null });
  });

  it("disables Load more while a refresh is pending and does not fetch the next page", async () => {
    const videoItem = (id: string) => ({
      id, title: `Video ${id}`, thumbnail_url: null, published_at: null, privacy_status: "public", url: "https://www.youtube.com/watch?v=x",
    });
    const pageOf = (items: ReturnType<typeof videoItem>[], next: string | null) => envelope({
      items, next_page_token: next, total_results: null,
    });
    const channelData = (accountId: string) => ({
      id: `UC-${accountId}`, title: `Channel of ${accountId}`, description: "", custom_url: null, thumbnail_url: null,
      published_at: null, country: null, privacy_status: "public",
      statistics: { view_count: 1, subscriber_count: 1, subscriber_count_hidden: false, video_count: 1 },
    });
    const base = gateway();
    const fake: YouTubeResourcesGateway = {
      ...base,
      getChannel: vi.fn()
        .mockImplementationOnce((accountId: string) => Promise.resolve(envelope(channelData(accountId))))
        .mockImplementationOnce(() => new Promise(() => {})) as unknown as YouTubeResourcesGateway["getChannel"],
      listVideos: vi.fn()
        .mockImplementationOnce(() => Promise.resolve(pageOf([videoItem("one")], "P2")))
        .mockImplementationOnce(() => new Promise(() => {})) as unknown as YouTubeResourcesGateway["listVideos"],
    };
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    await screen.findByRole("button", { name: /Video one/ });
    await screen.findByRole("heading", { name: "Channel of acc-a" });

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    const loadMore = await screen.findByRole("button", { name: "Load more" });
    expect(loadMore).toBeDisabled();
    const callsAfterRefresh = vi.mocked(fake.listVideos).mock.calls.length;
    await userEvent.click(loadMore);
    expect(vi.mocked(fake.listVideos)).toHaveBeenCalledTimes(callsAfterRefresh);
  });

  it("shows an accounts error with a retry instead of the empty state", async () => {
    const onRetryAccounts = vi.fn();
    await renderScreen(
      <YouTubeManagementScreen
        accounts={[]} accountsLoading={false} accountsError={new Error("read failed")}
        onRetryAccounts={onRetryAccounts} gateway={gateway()} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Postora could not read your connected accounts. Nothing was changed.");
    expect(screen.queryByText("No YouTube channel is connected yet.")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryAccounts).toHaveBeenCalledTimes(1);
  });
});


describe("YouTubeManagementScreen page trimming", () => {
  it("loads three pages then refreshes exactly one and resets pageParams", async () => {
    const item = (id: string) => ({ id, title: `Video ${id}`, thumbnail_url: null, published_at: null, privacy_status: "public", url: "https://www.youtube.com/watch?v=x" });
    const listVideos = vi.fn(({ pageToken }: { pageToken?: string | null }) => Promise.resolve(envelope({
      items: [item(pageToken ?? "one")],
      next_page_token: pageToken === null || pageToken === undefined ? "two" : pageToken === "two" ? "three" : null,
      total_results: 3,
    })));
    const fake = { ...gateway(), listVideos } as YouTubeResourcesGateway;
    const view = await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    await screen.findByRole("button", { name: /Video one/ });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /Video two/ });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /Video three/ });
    expect(listVideos).toHaveBeenCalledTimes(3);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(listVideos).toHaveBeenCalledTimes(4));
    expect(listVideos).toHaveBeenLastCalledWith({ accountId: "acc-a", pageToken: null });
    const key = youtubeResourceKey("user-a", "acc-a", "videos");
    expect(view.client.getQueryData(key)).toMatchObject({ pageParams: [null] });
    expect(view.client.getQueryData<{ pages: unknown[] }>(key)?.pages).toHaveLength(1);
  });
});


describe("YouTubeManagementScreen drawer behavior", () => {
  it("uses the locale-aware side and restores focus when closed", async () => {
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={gateway()} />, "ar");
    const trigger = await screen.findByRole("button", { name: /Video of acc-a/ });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("dir", "rtl");
    expect(dialog.className).toContain("left-0");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
