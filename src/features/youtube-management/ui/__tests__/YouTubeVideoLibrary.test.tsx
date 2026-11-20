import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { YouTubeVideoLibrary } from "../YouTubeVideoLibrary";

async function renderUi(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  return render(<MemoryRouter><I18nextProvider i18n={i18n}>{ui}</I18nextProvider></MemoryRouter>);
}

const video = (id: string) => ({
  id,
  title: `Title ${id}`,
  thumbnail_url: null,
  published_at: "2026-11-01T00:00:00Z",
  privacy_status: "unlisted",
  url: `https://www.youtube.com/watch?v=${id}`,
});

describe("YouTubeVideoLibrary", () => {
  it("lists the videos and reports the one the user picks", async () => {
    const onSelect = vi.fn();
    await renderUi(
      <YouTubeVideoLibrary videos={[video("a"), video("b")]} selectedVideoId={null} onSelect={onSelect}
        hasMore={false} isLoadingMore={false} onLoadMore={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Title b/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("offers more only while another page exists", async () => {
    const onLoadMore = vi.fn();
    await renderUi(
      <YouTubeVideoLibrary videos={[video("a")]} selectedVideoId={null} onSelect={vi.fn()}
        hasMore isLoadingMore={false} onLoadMore={onLoadMore} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("This channel has no uploaded videos yet.")).not.toBeInTheDocument();
  });

  it("says the channel has no uploads when the list is empty", async () => {
    await renderUi(
      <YouTubeVideoLibrary videos={[]} selectedVideoId={null} onSelect={vi.fn()}
        hasMore={false} isLoadingMore={false} onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText("This channel has no uploaded videos yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("still offers Load more when an empty page carries a token", async () => {
    const onLoadMore = vi.fn();
    await renderUi(
      <YouTubeVideoLibrary videos={[]} selectedVideoId={null} onSelect={vi.fn()}
        hasMore isLoadingMore={false} onLoadMore={onLoadMore} />,
    );
    expect(screen.queryByText("This channel has no uploaded videos yet.")).not.toBeInTheDocument();
    expect(screen.getByText("More results are available, load the next page")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
