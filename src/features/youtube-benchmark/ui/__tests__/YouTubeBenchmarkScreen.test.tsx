import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import type { YouTubeBenchmarkGateway } from "../../application/ports";
import type { YouTubeBenchmarkChannel } from "../../domain/types";
import { YouTubeBenchmarkScreen } from "../YouTubeBenchmarkScreen";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));

const ACCOUNTS = [
  { id: "acc-a", title: "My channel", avatarUrl: null },
  { id: "acc-b", title: "My second channel", avatarUrl: null },
];

function channel(overrides: Partial<YouTubeBenchmarkChannel> = {}): YouTubeBenchmarkChannel {
  return {
    input: "@alpha",
    status: "found",
    channel_id: "UCabcdefghijklmnopqrstuv",
    title: "Alpha Channel",
    thumbnail_url: null,
    subscriber_count: 1234,
    subscriber_count_hidden: false,
    view_count: 56789,
    video_count: 42,
    recent_videos: [
      {
        id: "v1",
        title: "First video",
        published_at: null,
        view_count: 100,
        like_count: 10,
        comment_count: 1,
      },
      {
        id: "v2",
        title: "Second video",
        published_at: null,
        view_count: 300,
        like_count: 30,
        comment_count: 3,
      },
    ],
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

async function renderScreen(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { accounts: {} } },
    defaultNS: "accounts",
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const VALIDATION_CASES = [
  {
    name: "empty",
    entries: [] as Array<{ label: string; value: string }>,
    message: "Enter at least one channel handle or channel ID.",
  },
  {
    name: "malformed",
    entries: [{ label: "Channel 1", value: "not-a-handle" }],
    message: "That is not a YouTube handle or channel ID.",
  },
  {
    name: "repeated",
    entries: [
      { label: "Channel 1", value: "@alpha" },
      { label: "Channel 2 (optional)", value: "@Alpha" },
    ],
    message: "The same channel was entered twice.",
  },
];

describe("YouTubeBenchmarkScreen", () => {
  it("invites a creator with no YouTube channel to connect one", async () => {
    const lookupChannels = vi.fn();
    await renderScreen(
      <YouTubeBenchmarkScreen
        accounts={[]}
        accountsLoading={false}
        gateway={{ lookupChannels } as unknown as YouTubeBenchmarkGateway}
      />,
    );
    expect(screen.getByText("No YouTube channel is connected yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Profiles" })).toHaveAttribute("href", "/profiles");
  });

  it.each(VALIDATION_CASES)(
    "refuses a $name comparison before it spends a provider unit",
    async ({ entries, message }) => {
      const lookupChannels = vi.fn();
      await renderScreen(
        <YouTubeBenchmarkScreen
          accounts={ACCOUNTS}
          accountsLoading={false}
          gateway={{ lookupChannels } as unknown as YouTubeBenchmarkGateway}
        />,
      );

      for (const entry of entries) {
        await userEvent.type(screen.getByLabelText(entry.label), entry.value);
      }
      await userEvent.click(screen.getByRole("button", { name: "Compare channels" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(lookupChannels).not.toHaveBeenCalled();
    },
  );

  it("shows the figures, the averages and the recent videos of a channel", async () => {
    const lookupChannels = vi.fn(() => Promise.resolve(envelope([channel()])));
    await renderScreen(
      <YouTubeBenchmarkScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={{ lookupChannels } as unknown as YouTubeBenchmarkGateway}
      />,
    );

    await userEvent.type(screen.getByLabelText("Channel 1"), "@alpha");
    await userEvent.click(screen.getByRole("button", { name: "Compare channels" }));

    expect(await screen.findByRole("heading", { name: "Alpha Channel" })).toBeInTheDocument();
    expect(screen.getByText("Subscribers").nextSibling).toHaveTextContent("1,234");
    expect(screen.getByText("Total views").nextSibling).toHaveTextContent("56,789");
    expect(screen.getByText("Total videos").nextSibling).toHaveTextContent("42");
    expect(screen.getByText("Average views (last 2 videos)").nextSibling).toHaveTextContent("200");
    expect(screen.getByText("Average likes").nextSibling).toHaveTextContent("20");
    expect(screen.getByText("Average comments").nextSibling).toHaveTextContent("2");
    expect(screen.getByText("First video")).toBeInTheDocument();
    expect(screen.getByText("Second video")).toBeInTheDocument();
    expect(screen.getByText(/Fetched at/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Public channel data provided by YouTube API Services. Nothing is stored by Postora.",
      ),
    ).toBeInTheDocument();
  });

  it("says a hidden subscriber count is hidden", async () => {
    const lookupChannels = vi.fn(() =>
      Promise.resolve(envelope([channel({ subscriber_count: null, subscriber_count_hidden: true })])),
    );
    await renderScreen(
      <YouTubeBenchmarkScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={{ lookupChannels } as unknown as YouTubeBenchmarkGateway}
      />,
    );

    await userEvent.type(screen.getByLabelText("Channel 1"), "@alpha");
    await userEvent.click(screen.getByRole("button", { name: "Compare channels" }));

    expect(await screen.findByText("Hidden by channel owner")).toBeInTheDocument();
  });

  it("says a channel that does not exist was not found", async () => {
    const lookupChannels = vi.fn(() =>
      Promise.resolve(envelope([channel({ status: "not_found" })])),
    );
    await renderScreen(
      <YouTubeBenchmarkScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={{ lookupChannels } as unknown as YouTubeBenchmarkGateway}
      />,
    );

    await userEvent.type(screen.getByLabelText("Channel 1"), "@alpha");
    await userEvent.click(screen.getByRole("button", { name: "Compare channels" }));

    expect(
      await screen.findByText("No channel found for this handle or channel ID."),
    ).toBeInTheDocument();
  });

  it("never calls an unavailable channel a missing channel", async () => {
    const lookupChannels = vi.fn(() =>
      Promise.resolve(
        envelope([channel({ status: "unavailable", error: "quota_exceeded" })]),
      ),
    );
    await renderScreen(
      <YouTubeBenchmarkScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={{ lookupChannels } as unknown as YouTubeBenchmarkGateway}
      />,
    );

    await userEvent.type(screen.getByLabelText("Channel 1"), "@alpha");
    await userEvent.click(screen.getByRole("button", { name: "Compare channels" }));

    expect(
      await screen.findByText("YouTube benchmark quota limit reached. Try again after the daily reset."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No channel found for this handle or channel ID.")).not.toBeInTheDocument();
  });

  it("keeps the figures of a channel whose uploads lookup failed and offers a retry", async () => {
    const lookupChannels = vi.fn(() =>
      Promise.resolve(
        envelope([channel({ error: "upstream_unavailable", recent_videos: [] })]),
      ),
    );
    await renderScreen(
      <YouTubeBenchmarkScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={{ lookupChannels } as unknown as YouTubeBenchmarkGateway}
      />,
    );

    await userEvent.type(screen.getByLabelText("Channel 1"), "@alpha");
    await userEvent.click(screen.getByRole("button", { name: "Compare channels" }));

    expect(await screen.findByRole("heading", { name: "Alpha Channel" })).toBeInTheDocument();
    expect(screen.getByText("Total views").nextSibling).toHaveTextContent("56,789");
    expect(
      screen.getByText("YouTube public channel data is temporarily unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry @alpha" })).toBeInTheDocument();
  });

  it("retries only the channel that failed", async () => {
    const lookupChannels = vi
      .fn()
      .mockResolvedValueOnce(
        envelope([
          channel({ input: "@alpha" }),
          channel({ input: "@beta", status: "unavailable", error: "quota_exceeded" }),
        ]),
      )
      .mockResolvedValueOnce(envelope([channel({ input: "@beta", status: "found" })]));
    await renderScreen(
      <YouTubeBenchmarkScreen
        accounts={ACCOUNTS}
        accountsLoading={false}
        gateway={{ lookupChannels } as unknown as YouTubeBenchmarkGateway}
      />,
    );

    await userEvent.type(screen.getByLabelText("Channel 1"), "@alpha");
    await userEvent.type(screen.getByLabelText("Channel 2 (optional)"), "@beta");
    await userEvent.click(screen.getByRole("button", { name: "Compare channels" }));

    const retry = await screen.findByRole("button", { name: "Retry @beta" });
    await userEvent.click(retry);

    await waitFor(() => expect(lookupChannels).toHaveBeenCalledTimes(2));
    expect(lookupChannels).toHaveBeenLastCalledWith({ accountId: "acc-a", channels: ["@beta"] });
  });
});
