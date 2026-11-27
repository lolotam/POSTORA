import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";

import { YouTubeVideoEditCard, type EditSaveOutcome } from "../YouTubeVideoEditCard";

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: { analyticsYoutube: false }, isLoading: false }),
}));

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

// The category dropdown is the only combobox of the editor; the embedded
// player has a speed selector of its own.
const categoryCombobox = () => screen.getByRole("combobox", { name: "Category" });

beforeEach(cleanup);

describe("YouTubeVideoEditCard", () => {
  it("keeps edit disabled with an adjacent reason when the capability is absent", async () => {
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit={false}
        disabledReason="Editing video details is currently unavailable for this channel."
      />,
    );

    expect(screen.getByRole("button", { name: "Edit video details" })).toBeDisabled();
    expect(screen.getByText(/currently unavailable for this channel/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Category" })).not.toBeInTheDocument();
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

    expect(visibleText(categoryCombobox())).toBe("998 (Currently unavailable)");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("offers no visibility confirmation, because privacy is not part of this activation", async () => {
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/changes who can see the video/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Visibility")).not.toBeInTheDocument();
  });

  it("starts the description and the tag field from the video the server confirmed", async () => {
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));

    expect(screen.getByLabelText("Description")).toHaveValue("Body text");
    expect(screen.getByLabelText("Tags (comma-separated)")).toHaveValue("one");
  });

  it("saves the title, the description, the tags and the category as one draft", async () => {
    const onSave = vi.fn().mockResolvedValue("saved");
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
        accountId="acc-1"
        onSave={onSave}
        onSnapshot={vi.fn().mockResolvedValue("rev-1")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "New body" } });
    fireEvent.change(screen.getByLabelText("Tags (comma-separated)"), { target: { value: "alpha, beta ,, gamma" } });
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      title: "Renamed",
      description: "New body",
      tags: ["alpha", "beta", "gamma"],
      categoryId: "998",
      baseRevision: "rev-1",
    }));
  });

  it("refuses a draft YouTube would reject, before the request leaves the page", async () => {
    const onSave = vi.fn().mockResolvedValue("saved");
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
        accountId="acc-1"
        onSave={onSave}
        onSnapshot={vi.fn().mockResolvedValue("rev-1")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).not.toBeDisabled());

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "   " } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fine" } });
    expect(save).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "a < b" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "a b" } });
    expect(save).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText("Tags (comma-separated)"), { target: { value: "ok, <bad>" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Tags (comma-separated)"), { target: { value: "ok" } });
    expect(save).not.toBeDisabled();
  });

  it.each([
    ["saved", "saved", "match your changes"],
    ["edit_conflict", "edit_conflict", "Review the latest details"],
    ["rate_limited", { outcome: "rate_limited", retryAfterSeconds: 90 }, "Try again in 90 seconds"],
    ["rate_limited without a wait", { outcome: "rate_limited", retryAfterSeconds: null }, "Try again later"],
    ["refused", "refused", "Nothing was changed on YouTube"],
    ["outcome_unknown", "outcome_unknown", "may have saved"],
  ] as const)("reports %s through the injected save seam", async (_scenario, result, expected) => {
    const onSave = vi.fn().mockResolvedValue(result);
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
        accountId="acc-1"
        onSave={onSave}
        onSnapshot={vi.fn().mockResolvedValue("rev-1")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed" } });
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toContain(expected);
  });

  it("hydrates draft values from the fresh snapshot and updates baseRevision after a save", async () => {
    // The server answers a snapshot with the revision it currently holds, and
    // a saved write is the new revision.
    let currentRevision = "rev-fresh-1";
    const onSnapshot = vi.fn(async () => ({
      revision: currentRevision,
      values: {
        title: "Studio title",
        description: "Studio description",
        tags: ["studio", "fresh"],
        categoryId: "22",
      },
    }));
    const onSave = vi.fn(async () => {
      currentRevision = "rev-fresh-2";
      return { outcome: "saved" as const, revision: "rev-fresh-2" };
    });
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
        accountId="acc-1"
        onSnapshot={onSnapshot}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Studio title"));
    expect(screen.getByLabelText("Description")).toHaveValue("Studio description");
    expect(screen.getByLabelText("Tags (comma-separated)")).toHaveValue("studio, fresh");

    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: "rev-fresh-1",
    })));

    // A saved write closes the editor, so the next one starts by reopening it
    // and reading the revision the server now holds.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Second rename" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Second rename",
      baseRevision: "rev-fresh-2",
    })));
  });

  it("preserves escaped commas inside individual tags across hydration and save", async () => {
    const onSave = vi.fn().mockResolvedValue("saved");
    await renderUi(
      <YouTubeVideoEditCard
        video={{ ...video, tags: ["science, technology", "ai"] }}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
        accountId="acc-1"
        onSnapshot={vi.fn().mockResolvedValue({
          revision: "rev-comma-1",
          values: {
            title: "First video",
            description: "Body text",
            tags: ["science, technology", "ai"],
            categoryId: "998",
          },
        })}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));
    await waitFor(() => expect(screen.getByLabelText("Tags (comma-separated)")).toHaveValue("science\\, technology, ai"));

    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      tags: ["science, technology", "ai"],
    })));
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

    expect(visibleText(categoryCombobox())).toBe("22 (الأشخاص والمدونات)");
  });
});

describe("YouTubeVideoEditCard — the edit toggle", () => {
  it("closes the editor on the second click without saving anything", async () => {
    const onSave = vi.fn().mockResolvedValue("saved");
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
        accountId="acc-1"
        onSave={onSave}
        onSnapshot={vi.fn().mockResolvedValue("rev-1")}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Edit video details" });

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("reads a fresh snapshot when the editor is opened again", async () => {
    const onSnapshot = vi.fn().mockResolvedValue("rev-1");
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
        accountId="acc-1"
        onSnapshot={onSnapshot}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Edit video details" });

    fireEvent.click(toggle);
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));
  });

  it("says whether the editor is open", async () => {
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
      />,
    );
    const toggle = screen.getByRole("button", { name: "Edit video details" });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "youtube-video-edit-form");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("#youtube-video-edit-form")).not.toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the form after a saved write and keeps the confirmation visible", async () => {
    const onSave = vi.fn().mockResolvedValue("saved");
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
        accountId="acc-1"
        onSave={onSave}
        onSnapshot={vi.fn().mockResolvedValue("rev-1")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
    expect(screen.getByText("Current details match your changes.")).toBeInTheDocument();
  });

  it("keeps the form open and the draft intact after a conflict", async () => {
    const onSave = vi.fn().mockResolvedValue("edit_conflict");
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
        accountId="acc-1"
        onSave={onSave}
        onSnapshot={vi.fn().mockResolvedValue("rev-1")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit video details" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed" } });
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    await waitFor(() => expect(screen.getByText(/Review the latest details/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Renamed");
  });

  it("cannot be closed while a write is in flight", async () => {
    let release: (() => void) | null = null;
    const onSave = vi.fn(() => new Promise<EditSaveOutcome>((resolve) => { release = () => resolve("saved"); }));
    await renderUi(
      <YouTubeVideoEditCard
        video={video}
        fetchedAt="2026-11-20T10:00:00.000Z"
        canEdit
        disabledReason=""
        accountId="acc-1"
        onSave={onSave}
        onSnapshot={vi.fn().mockResolvedValue("rev-1")}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Edit video details" });
    fireEvent.click(toggle);
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    await waitFor(() => expect(toggle).toBeDisabled());
    release?.();
    await waitFor(() => expect(toggle).not.toBeDisabled());
  });
});
