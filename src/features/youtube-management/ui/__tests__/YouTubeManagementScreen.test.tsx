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
        unit_costs: {
          channel: 1 as const,
          videos_page: 2 as const,
          video: 1 as const,
          playlists_page: 1 as const,
          captions_list: 50 as const,
          caption_upload: 400 as const,
        },
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

describe("YouTubeManagementScreen thumbnail replacement", () => {
  const CANDIDATES = [
    { id: "media-jpeg", file_name: "cover.jpg", mime_type: "image/jpeg", file_type: "image", file_size: 120_000 },
    { id: "media-webp", file_name: "sticker.webp", mime_type: "image/webp", file_type: "image", file_size: 40_000 },
  ];

  function thumbnailGateway(options: {
    manageThumbnail?: YouTubeCapabilityState;
    setThumbnail?: YouTubeResourcesGateway["setThumbnail"];
  }): YouTubeResourcesGateway {
    const base = gateway();
    return {
      ...base,
      getCapabilities: vi.fn((accountId: string) => Promise.resolve(envelope({
        account_id: accountId,
        channel_id: `UC-${accountId}`,
        channel_title: accountId,
        provider: "native" as const,
        connection: "ok" as const,
        scopes: { readonly: "granted" as const, upload: "granted" as const, force_ssl: "granted" as const },
        capabilities: {
          browse: { state: "available" as const },
          upload: { state: "available" as const },
          comments: { state: "available" as const },
          manage_thumbnail: options.manageThumbnail ?? { state: "available" as const },
        },
        quota: {
          provider_quota: "not_tracked" as const,
          unit_costs: {
          channel: 1 as const,
          videos_page: 2 as const,
          video: 1 as const,
          playlists_page: 1 as const,
          captions_list: 50 as const,
          caption_upload: 400 as const,
        },
          per_user_burst: { limit: 30 as const, window_seconds: 600 as const },
          per_user_daily: { limit: 300 as const, window_seconds: 86400 as const },
        },
      }))),
      setThumbnail: options.setThumbnail,
    };
  }

  it("offers only JPEG and PNG images and writes once after the confirmation", async () => {
    const setThumbnail = vi.fn(async () => envelope({ video_id: "acc-a-video", applied: true as const }));
    const listOwnedImages = vi.fn(async () => CANDIDATES);
    await renderScreen(
      <YouTubeManagementScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={thumbnailGateway({ setThumbnail })}
        mediaGateway={{ listOwnedImages }}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Change thumbnail" }));

    expect(await screen.findByRole("radio", { name: "cover.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "sticker.webp" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "cover.jpg" }));
    expect(screen.getByText("This replaces the thumbnail viewers see on YouTube")).toBeInTheDocument();
    expect(setThumbnail).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Confirm thumbnail change" }));

    expect(setThumbnail).toHaveBeenCalledTimes(1);
    expect(setThumbnail).toHaveBeenCalledWith({
      accountId: "acc-a",
      videoId: "acc-a-video",
      mediaFileId: "media-jpeg",
    });
    const outcome = await screen.findByText("Thumbnail updated on YouTube.");
    expect(outcome).toHaveAttribute("role", "status");
  });

  it("reads the video again after an applied thumbnail so the drawer shows the new one", async () => {
    const setThumbnail = vi.fn(async () => envelope({ video_id: "acc-a-video", applied: true as const }));
    const fake = thumbnailGateway({ setThumbnail });
    await renderScreen(
      <YouTubeManagementScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={fake}
        mediaGateway={{ listOwnedImages: vi.fn(async () => CANDIDATES) }}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Change thumbnail" }));
    await userEvent.click(await screen.findByRole("radio", { name: "cover.jpg" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm thumbnail change" }));

    await screen.findByText("Thumbnail updated on YouTube.");
    await waitFor(() => expect(fake.getVideo).toHaveBeenCalledTimes(2));
  });

  it("disables the control and reads no library when the channel cannot set thumbnails", async () => {
    const listOwnedImages = vi.fn(async () => CANDIDATES);
    await renderScreen(
      <YouTubeManagementScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={thumbnailGateway({ manageThumbnail: { state: "unavailable", reason: "reconnect_required" } })}
        mediaGateway={{ listOwnedImages }}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));

    const control = await screen.findByRole("button", { name: "Change thumbnail" });
    expect(control).toBeDisabled();
    expect(
      screen.getByText("This channel needs to be reconnected before changing thumbnails is available."),
    ).toBeInTheDocument();
    expect(listOwnedImages).not.toHaveBeenCalled();
  });

  it("reports a channel that may not set custom thumbnails", async () => {
    const setThumbnail = vi.fn(async () => {
      throw new YouTubeResourceError("thumbnail_not_allowed");
    });
    await renderScreen(
      <YouTubeManagementScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={thumbnailGateway({ setThumbnail })}
        mediaGateway={{ listOwnedImages: vi.fn(async () => CANDIDATES) }}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Change thumbnail" }));
    await userEvent.click(await screen.findByRole("radio", { name: "cover.jpg" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm thumbnail change" }));

    expect(await screen.findByText("This YouTube channel is not eligible to set custom thumbnails.")).toBeInTheDocument();
  });
});


describe("YouTubeManagementScreen caption tracks", () => {
  const CAPTION_TRACK = {
    id: "track-1",
    language: "en",
    name: "English",
    track_kind: "standard",
    is_draft: false,
    status: "published",
    last_updated: null,
  };

  function captionsGateway(options: {
    manageCaptions?: YouTubeCapabilityState;
    listCaptions?: YouTubeResourcesGateway["listCaptions"];
    uploadCaption?: YouTubeResourcesGateway["uploadCaption"];
  }): YouTubeResourcesGateway {
    const base = gateway();
    return {
      ...base,
      getCapabilities: vi.fn((accountId: string) => Promise.resolve(envelope({
        account_id: accountId,
        channel_id: `UC-${accountId}`,
        channel_title: accountId,
        provider: "native" as const,
        connection: "ok" as const,
        scopes: { readonly: "granted" as const, upload: "granted" as const, force_ssl: "granted" as const },
        capabilities: {
          browse: { state: "available" as const },
          upload: { state: "available" as const },
          comments: { state: "available" as const },
          manage_captions: options.manageCaptions ?? { state: "available" as const },
        },
        quota: {
          provider_quota: "not_tracked" as const,
          unit_costs: {
            channel: 1 as const,
            videos_page: 2 as const,
            video: 1 as const,
            playlists_page: 1 as const,
            captions_list: 50 as const,
            caption_upload: 400 as const,
          },
          per_user_burst: { limit: 30 as const, window_seconds: 600 as const },
          per_user_daily: { limit: 300 as const, window_seconds: 86400 as const },
        },
      }))),
      listCaptions: options.listCaptions,
      uploadCaption: options.uploadCaption,
    };
  }

  it("spends no caption list when the drawer opens", async () => {
    const listCaptions = vi.fn(async () => envelope({ video_id: "acc-a-video", items: [CAPTION_TRACK] }));
    await renderScreen(
      <YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={captionsGateway({ listCaptions })} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));

    expect(await screen.findByRole("button", { name: "Show caption tracks" })).toBeInTheDocument();
    expect(listCaptions).not.toHaveBeenCalled();
  });

  it("lists the tracks of the picked video once the creator asks", async () => {
    const listCaptions = vi.fn(async () => envelope({ video_id: "acc-a-video", items: [CAPTION_TRACK] }));
    await renderScreen(
      <YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={captionsGateway({ listCaptions })} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Show caption tracks" }));

    await waitFor(() => expect(listCaptions).toHaveBeenCalledTimes(1));
    expect(listCaptions).toHaveBeenCalledWith({ accountId: "acc-a", videoId: "acc-a-video" });
    expect(await screen.findByRole("table")).toHaveTextContent("English");
  });

  it("uploads one caption track after the confirmation and shows the outcome", async () => {
    const uploadCaption = vi.fn(async () => envelope({ video_id: "acc-a-video", track: CAPTION_TRACK }));
    await renderScreen(
      <YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={captionsGateway({ uploadCaption })} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    const file = new File(["WEBVTT\n"], "captions.vtt", { type: "text/plain" });
    await userEvent.upload(await screen.findByLabelText("Caption file (.srt or .vtt)"), file);
    await userEvent.click(screen.getByRole("button", { name: "Prepare caption upload" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm caption upload" }));

    await waitFor(() => expect(uploadCaption).toHaveBeenCalledTimes(1));
    expect(uploadCaption).toHaveBeenCalledWith({
      accountId: "acc-a",
      videoId: "acc-a-video",
      language: "en",
      name: "",
      format: "vtt",
      content: "WEBVTT\n",
    });
    expect(await screen.findByText("Caption track uploaded to YouTube.")).toHaveAttribute("role", "status");
  });

  it("disables the caption control when the channel cannot manage captions", async () => {
    const listCaptions = vi.fn(async () => envelope({ video_id: "acc-a-video", items: [] }));
    await renderScreen(
      <YouTubeManagementScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={captionsGateway({
          manageCaptions: { state: "unavailable", reason: "missing_scope" },
          listCaptions,
        })}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));

    expect(await screen.findByRole("button", { name: "Show caption tracks" })).toBeDisabled();
    expect(
      screen.getByText("Reconnect this channel and grant YouTube caption permissions (force-ssl) to manage captions."),
    ).toBeInTheDocument();
    expect(listCaptions).not.toHaveBeenCalled();
  });
});

describe("YouTubeManagementScreen published metadata editing", () => {
  function editGateway(options: {
    editMetadata?: YouTubeCapabilityState;
    updateVideo?: YouTubeResourcesGateway["updateVideo"];
  }): YouTubeResourcesGateway {
    const base = gateway();
    return {
      ...base,
      getCapabilities: vi.fn((accountId: string) => Promise.resolve(envelope({
        account_id: accountId,
        channel_id: `UC-${accountId}`,
        channel_title: accountId,
        provider: "native" as const,
        connection: "ok" as const,
        scopes: { readonly: "granted" as const, upload: "granted" as const, force_ssl: "granted" as const },
        capabilities: {
          browse: { state: "available" as const },
          upload: { state: "available" as const },
          comments: { state: "available" as const },
          edit_metadata: options.editMetadata ?? { state: "available" as const },
        },
        quota: {
          provider_quota: "not_tracked" as const,
          unit_costs: {
            channel: 1 as const,
            videos_page: 2 as const,
            video: 1 as const,
            playlists_page: 1 as const,
            captions_list: 50 as const,
            caption_upload: 400 as const,
          },
          per_user_burst: { limit: 30 as const, window_seconds: 600 as const },
          per_user_daily: { limit: 300 as const, window_seconds: 86400 as const },
        },
      }))),
      getVideo: vi.fn(({ videoId }: { accountId: string; videoId: string }) => Promise.resolve(envelope({
        id: videoId, channel_id: "UC", title: `Details of ${videoId}`, description: "Body text", thumbnail_url: null,
        published_at: null, tags: ["one"], category_id: "22", default_language: null, duration_iso8601: null,
        privacy_status: "public", upload_status: null, made_for_kids: null,
        statistics: { view_count: null, like_count: null, comment_count: null },
        url: "https://www.youtube.com/watch?v=x",
      }))),
      getEditSnapshot: vi.fn(async () => envelope({
        revision: "rev-1",
        values: { title: "Details of acc-a-video", description: "Body text", tags: ["one"], privacyStatus: "public", categoryId: "22" },
      })),
      updateVideo: options.updateVideo ?? vi.fn(async () => envelope({ revision: "rev-2" })),
    };
  }

  async function openTheEditor() {
    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit video details" }));
    await screen.findByLabelText("Title");
  }

  it("saves the title, the description, the tags and the category, then reads the video again", async () => {
    const updateVideo = vi.fn(async () => envelope({ revision: "rev-2" }));
    const fake = editGateway({ updateVideo: updateVideo as unknown as YouTubeResourcesGateway["updateVideo"] });
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    await openTheEditor();

    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Renamed");
    await userEvent.clear(screen.getByLabelText("Description"));
    await userEvent.type(screen.getByLabelText("Description"), "New body");
    await userEvent.clear(screen.getByLabelText("Tags (comma-separated)"));
    await userEvent.type(screen.getByLabelText("Tags (comma-separated)"), "alpha, beta");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateVideo).toHaveBeenCalledTimes(1));
    expect(updateVideo).toHaveBeenCalledWith({
      accountId: "acc-a",
      videoId: "acc-a-video",
      baseRevision: "rev-1",
      changes: {
        title: "Renamed",
        description: "New body",
        tags: ["alpha", "beta"],
        category_id: "22",
      },
    });
    // The saved answer is a claim; the drawer shows the values YouTube kept.
    await waitFor(() => expect(fake.getVideo).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.listVideos).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["reconnect_required", "This channel needs to be reconnected before editing is available."],
    ["missing_scope", "Reconnect this channel and grant YouTube edit permissions (force-ssl) to edit video details."],
    ["provider_unsupported", "Editing video details is not available for managed connections."],
  ] as const)("explains a %s capability instead of a generic sentence", async (reason, expected) => {
    const fake = editGateway({ editMetadata: { state: "unavailable", reason } });
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);

    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));

    expect(await screen.findByRole("button", { name: "Edit video details" })).toBeDisabled();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("explains an unknown capability without pretending the edit is available", async () => {
    const fake = editGateway({ editMetadata: { state: "unknown" } });
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);

    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));

    expect(await screen.findByRole("button", { name: "Edit video details" })).toBeDisabled();
    expect(
      screen.getByText("Editing video details is currently unavailable for this channel."),
    ).toBeInTheDocument();
  });

  it.each([
    ["a conflict", new YouTubeResourceError("edit_conflict"), "Review the latest details"],
    ["a rate limit", new YouTubeResourceError("rate_limited", 90), "Try again in 90 seconds"],
    ["a pre-write refusal", new YouTubeResourceError("invalid_request"), "Nothing was changed on YouTube"],
    ["a lost answer", new YouTubeResourceError("outcome_unknown"), "may have saved"],
  ] as const)("reports %s without claiming a save", async (_scenario, failure, expected) => {
    const updateVideo = vi.fn(async () => {
      throw failure;
    });
    const fake = editGateway({ updateVideo: updateVideo as unknown as YouTubeResourcesGateway["updateVideo"] });
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    await openTheEditor();

    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("status")).toHaveTextContent(expected);
  });
});