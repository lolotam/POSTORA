import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => localStorage.clear());
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


describe("YouTubeVideoLibrary enhanced views", () => {
  beforeEach(() => localStorage.clear());

  it("sorts with aria-sort and renumbers the visible order", async () => {
    const rows = [
      { ...video("a"), statistics: { view_count: 5, like_count: null, comment_count: null } },
      { ...video("b"), statistics: { view_count: 10, like_count: null, comment_count: null } },
    ];
    await renderUi(<YouTubeVideoLibrary videos={rows} selectedVideoId={null} onSelect={vi.fn()} hasMore={false} isLoadingMore={false} onLoadMore={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(screen.getByRole("columnheader", { name: "Views" })).toHaveAttribute("aria-sort", "descending");
    const tableRows = screen.getAllByRole("row").slice(1);
    expect(tableRows[0]).toHaveTextContent("Title b");
    expect((tableRows[0] as HTMLTableRowElement).cells[0]).toHaveTextContent("1");
    await userEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getByText("#1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "6 per row" }));
    expect(localStorage.getItem("ytManagementLibraryView")).toBe("grid");
    expect(localStorage.getItem("ytManagementLibraryGridColumns")).toBe("6");
  });

  it("filters Shorts and searches descriptions", async () => {
    const rows = [
      { ...video("a"), description: "Regular upload" },
      { ...video("b"), title: "My clip #Shorts", description: "Vertical" },
    ];
    await renderUi(<YouTubeVideoLibrary videos={rows} selectedVideoId={null} onSelect={vi.fn()} hasMore={false} isLoadingMore={false} onLoadMore={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Shorts" }));
    expect(screen.getByRole("button", { name: /My clip/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Title a/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search uploads" }), "Vertical");
    expect(screen.getByRole("button", { name: /My clip/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Title a/ })).not.toBeInTheDocument();
  });

  it("shows the filtered empty state and resets it", async () => {
    await renderUi(<YouTubeVideoLibrary videos={[video("a")]} selectedVideoId={null} onSelect={vi.fn()} hasMore isLoadingMore={false} onLoadMore={vi.fn()} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search uploads" }), "not present");
    expect(screen.getByText("No uploads match these filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByRole("button", { name: /Title a/ })).toBeInTheDocument();
  });

  it("renders a fallback dash for unparseable published_at in both table and grid views", async () => {
    const badRow = { ...video("bad"), published_at: "not-a-date", privacy_status: null };
    await renderUi(<YouTubeVideoLibrary videos={[badRow]} selectedVideoId={null} onSelect={vi.fn()} hasMore={false} isLoadingMore={false} onLoadMore={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Title bad/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getByRole("button", { name: /Title bad/ })).toBeInTheDocument();
  });
});
