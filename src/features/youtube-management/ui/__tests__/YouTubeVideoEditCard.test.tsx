import type { ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";

import { YouTubeVideoEditCard } from "../YouTubeVideoEditCard";

const video = {
  id: "videoAAAAAAA",
  channel_id: "UCfixturechannel000000001",
  title: "First video",
  description: "Body text",
  thumbnail_url: null,
  published_at: "2026-10-31T00:00:00Z",
  tags: ["one"],
  category_id: "998",
  default_language: null,
  duration_iso8601: "PT4M13S",
  privacy_status: "private",
  upload_status: "processed",
  made_for_kids: false,
  statistics: { view_count: 0, like_count: null, comment_count: null },
  url: "https://www.youtube.com/watch?v=videoAAAAAAA",
};

async function renderUi(ui: ReactElement, language = "en") {
  const i18n = createInstance();
  await i18n.init({ lng: language, resources: { [language]: { accounts: {} } }, defaultNS: "accounts" });
  return render(<MemoryRouter><I18nextProvider i18n={i18n}>{ui}</I18nextProvider></MemoryRouter>);
}

const visibleText = (element: HTMLElement) => element.textContent?.replace(/[\u2068\u2069]/g, "");

beforeEach(cleanup);

describe("YouTubeVideoEditCard", () => {
  it("keeps edit disabled with an adjacent reason when the capability is absent", async () => {
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit={false}
        disabledReason="Editing is not enabled until conditional write enforcement is verified."
      />,
    );

    expect(screen.getByRole("button", { name: "Edit video details" })).toBeDisabled();
    expect(screen.getByText(/conditional write enforcement/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("uses the same numbered category dropdown and preserves an unlisted category", async () => {
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));

    const combobox = screen.getByRole("combobox");
    expect(visibleText(combobox)).toBe("998 (Currently unavailable)");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows Arabic number-first labels in the edit dropdown", async () => {
    await renderUi(
      <YouTubeVideoEditCard
        video={{ ...video, category_id: "22" }}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
      />,
      "ar",
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));

    expect(visibleText(screen.getByRole("combobox"))).toBe("22 (الأشخاص والمدونات)");
  });
});
