import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { YouTubeVideoDetail } from "../YouTubeVideoDetail";

async function renderUi(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  return render(<MemoryRouter><I18nextProvider i18n={i18n}>{ui}</I18nextProvider></MemoryRouter>);
}

const details = {
  id: "videoAAAAAAA",
  channel_id: "UCfixturechannel000000001",
  title: "First video",
  description: "Body text",
  thumbnail_url: null,
  published_at: "2026-10-31T00:00:00Z",
  tags: ["one", "two"],
  category_id: "22",
  default_language: "ar",
  duration_iso8601: "PT4M13S",
  privacy_status: "public",
  upload_status: "processed",
  made_for_kids: false,
  statistics: { view_count: 10, like_count: null, comment_count: 1 },
  url: "https://www.youtube.com/watch?v=videoAAAAAAA",
};

describe("YouTubeVideoDetail", () => {
  it("shows the details and a safe link to YouTube", async () => {
    await renderUi(<YouTubeVideoDetail video={details} fetchedAt="2026-11-20T10:00:00.000Z" />);
    expect(screen.getByRole("heading", { name: "First video" })).toBeInTheDocument();
    expect(screen.getByText("Body text")).toBeInTheDocument();
    expect(screen.getByText("4:13")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open on YouTube" });
    expect(link).toHaveAttribute("href", details.url);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows a counter YouTube did not return as unavailable, not as zero", async () => {
    await renderUi(<YouTubeVideoDetail video={details} fetchedAt="2026-11-20T10:00:00.000Z" />);
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });
});
