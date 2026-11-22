import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// The catalog hook is a network boundary; tests answer it with the committed
// catalog shape and never call YouTube.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: vi.fn(async (name: string, options?: { body?: unknown }) => {
        if (name !== "youtube-resources") return { data: null, error: new Error("unexpected function") };
        const body = (options?.body ?? {}) as { locale?: string };
        const arabic = body.locale?.startsWith("ar");
        return {
          data: {
            schema_version: 1,
            request_id: "req",
            freshness: { fetched_at: "2026-11-22T10:00:00Z", source: "database" },
            data: {
              region: "US",
              locale: arabic ? "ar" : "en",
              categories: [
                {
                  id: "22",
                  name: arabic ? "الأشخاص والمدونات" : "People & Blogs",
                  label: arabic ? "⁨22⁩ (الأشخاص والمدونات)" : "⁨22⁩ (People & Blogs)",
                  assignable: true,
                },
                { id: "30", name: "Movies", label: "⁨30⁩ (Movies)", assignable: false },
              ],
            },
          },
          error: null,
        };
      }),
    },
  },
}));

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

  it("reports saved, conflict and unknown results through the injected save seam", async () => {
    const outcomes = ["saved", "edit_conflict", "outcome_unknown"] as const;
    for (const expected of outcomes) {
      cleanup();
      const onSave = vi.fn().mockResolvedValue(expected);
      await renderUi(
        <YouTubeVideoEditCard
          video={video}
          fetchedAt="2026-11-20T10:00:00.000Z"
          canEdit
          disabledReason=""
          accountId="acc-1"
          onSave={onSave}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(onSave).toHaveBeenCalledWith({
        title: "Renamed",
        categoryId: "998",
      }));
      expect(await screen.findByRole("status")).toBeInTheDocument();
      expect(screen.getByRole("status").textContent).toContain(
        expected === "saved" ? "match your changes"
          : expected === "edit_conflict" ? "Review the latest details"
            : "may have saved",
      );
    }
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
