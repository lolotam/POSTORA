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
import { YouTubeManagementScreen } from "../YouTubeManagementScreen";

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
        unit_costs: { channel: 1 as const, videos_page: 1 as const, video: 1 as const },
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

async function renderScreen(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter><QueryClientProvider client={client}><I18nextProvider i18n={i18n}>{ui}</I18nextProvider></QueryClientProvider></MemoryRouter>,
  );
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
});
