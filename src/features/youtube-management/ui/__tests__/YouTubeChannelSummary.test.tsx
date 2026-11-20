import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { YouTubeChannelSummary } from "../YouTubeChannelSummary";

async function renderUi(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  return render(<MemoryRouter><I18nextProvider i18n={i18n}>{ui}</I18nextProvider></MemoryRouter>);
}

const channel = {
  id: "UCfixturechannel000000001",
  title: "Fixture channel",
  description: "",
  custom_url: "@fixture",
  thumbnail_url: null,
  published_at: null,
  country: null,
  privacy_status: "public",
  statistics: { view_count: 1200, subscriber_count: null, subscriber_count_hidden: true, video_count: 7 },
};

describe("YouTubeChannelSummary", () => {
  it("shows the channel, says when subscribers are hidden, and labels the counters honestly", async () => {
    await renderUi(<YouTubeChannelSummary channel={channel} fetchedAt="2026-11-20T10:00:00.000Z" />);
    expect(screen.getByRole("heading", { name: "Fixture channel" })).toBeInTheDocument();
    expect(screen.getByText("Hidden")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Counters come from YouTube. They are not watch-time reports.")).toBeInTheDocument();
  });
});
