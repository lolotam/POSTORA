import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { YouTubeCapabilityState } from "../../domain/types";
import type { YouTubeThumbnailCandidate, YouTubeThumbnailOutcome } from "../../domain/thumbnail";
import { YouTubeThumbnailChange } from "../YouTubeThumbnailChange";

const JPEG: YouTubeThumbnailCandidate = {
  id: "media-jpeg",
  file_name: "cover.jpg",
  mime_type: "image/jpeg",
  file_type: "image",
  file_size: 120_000,
};
const PNG: YouTubeThumbnailCandidate = {
  id: "media-png",
  file_name: "logo.png",
  mime_type: "image/png",
  file_type: "image",
  file_size: 80_000,
};
const WEBP: YouTubeThumbnailCandidate = {
  id: "media-webp",
  file_name: "sticker.webp",
  mime_type: "image/webp",
  file_type: "image",
  file_size: 40_000,
};
const VIDEO: YouTubeThumbnailCandidate = {
  id: "media-video",
  file_name: "clip.mp4",
  mime_type: "video/mp4",
  file_type: "video",
  file_size: 900_000,
};

const AVAILABLE: YouTubeCapabilityState = { state: "available" };

async function renderChange(props: {
  capability?: YouTubeCapabilityState | null;
  candidates?: YouTubeThumbnailCandidate[];
  candidatesLoading?: boolean;
  candidatesError?: unknown;
  onSetThumbnail?: (mediaFileId: string) => Promise<YouTubeThumbnailOutcome>;
}) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  // The write seam is always present in production, so the picker opens.
  const onSetThumbnail = props.onSetThumbnail ?? (async () => "applied" as const);
  return render(
    <I18nextProvider i18n={i18n}>
      <YouTubeThumbnailChange
        capability={props.capability ?? AVAILABLE}
        candidates={props.candidates ?? []}
        candidatesLoading={props.candidatesLoading ?? false}
        candidatesError={props.candidatesError ?? null}
        onSetThumbnail={onSetThumbnail}
      />
    </I18nextProvider>,
  );
}

async function openPicker() {
  await userEvent.click(await screen.findByRole("button", { name: "Change thumbnail" }));
}

describe("YouTubeThumbnailChange", () => {
  it.each([
    [
      "a channel that must be reconnected",
      { state: "unavailable", reason: "reconnect_required" } as YouTubeCapabilityState,
      "This channel needs to be reconnected before changing thumbnails is available.",
    ],
    [
      "a channel whose upload scope was never granted",
      { state: "unavailable", reason: "missing_scope" } as YouTubeCapabilityState,
      "Reconnect this channel and grant YouTube upload permissions to change thumbnails.",
    ],
    [
      "a managed connection",
      { state: "unavailable", reason: "provider_unsupported" } as YouTubeCapabilityState,
      "Changing thumbnails is not available for managed connections.",
    ],
    [
      "an unknown capability",
      { state: "unknown" } as YouTubeCapabilityState,
      "Changing thumbnails is currently unavailable for this channel.",
    ],
  ])("disables the control and explains %s", async (_scenario, capability, expected) => {
    await renderChange({ capability });

    expect(screen.getByRole("button", { name: "Change thumbnail" })).toBeDisabled();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("offers only JPEG and PNG images and names the files it left out", async () => {
    await renderChange({ candidates: [JPEG, PNG, WEBP, VIDEO] });

    await openPicker();

    const offered = screen.getAllByRole("radio");
    expect(offered.map((option) => option.getAttribute("aria-label"))).toEqual(["cover.jpg", "logo.png"]);
    expect(screen.queryByRole("radio", { name: "sticker.webp" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "clip.mp4" })).not.toBeInTheDocument();
    expect(
      screen.getByText("Some images in your library were excluded because YouTube accepts JPEG and PNG only."),
    ).toBeInTheDocument();
  });

  it("says the library has no usable image instead of offering nothing silently", async () => {
    await renderChange({ candidates: [WEBP, VIDEO] });

    await openPicker();

    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(
      screen.getByText("Your media library has no JPEG or PNG image to use as a thumbnail."),
    ).toBeInTheDocument();
  });

  it("asks for confirmation before it writes anything", async () => {
    const onSetThumbnail = vi.fn(async () => "applied" as const);
    await renderChange({ candidates: [JPEG, PNG], onSetThumbnail });

    await openPicker();
    await userEvent.click(screen.getByRole("radio", { name: "cover.jpg" }));

    expect(screen.getByText("This replaces the thumbnail viewers see on YouTube")).toBeInTheDocument();
    expect(screen.getByText("New thumbnail: cover.jpg")).toBeInTheDocument();
    expect(onSetThumbnail).not.toHaveBeenCalled();
  });

  it("cancels the confirmation without writing anything", async () => {
    const onSetThumbnail = vi.fn(async () => "applied" as const);
    await renderChange({ candidates: [JPEG], onSetThumbnail });

    await openPicker();
    await userEvent.click(screen.getByRole("radio", { name: "cover.jpg" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSetThumbnail).not.toHaveBeenCalled();
    expect(screen.queryByText("This replaces the thumbnail viewers see on YouTube")).not.toBeInTheDocument();
  });

  it("writes once after the confirmation and reports the applied outcome", async () => {
    const onSetThumbnail = vi.fn(async () => "applied" as const);
    await renderChange({ candidates: [JPEG, PNG], onSetThumbnail });

    await openPicker();
    await userEvent.click(screen.getByRole("radio", { name: "logo.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm thumbnail change" }));

    expect(onSetThumbnail).toHaveBeenCalledTimes(1);
    expect(onSetThumbnail).toHaveBeenCalledWith("media-png");
    expect(await screen.findByRole("status")).toHaveTextContent("Thumbnail updated on YouTube.");
  });

  it.each([
    ["thumbnail_not_allowed", "This YouTube channel is not eligible to set custom thumbnails."],
    ["media_not_usable", "This image cannot be used. Choose a JPEG or PNG image under 2 MB from your library."],
    ["rate_limited", "Thumbnail write limit reached. Try again later."],
    ["quota_exceeded", "Thumbnail write limit reached. Try again later."],
    ["refused", "Thumbnail could not be updated. Nothing was changed on YouTube."],
    ["outcome_unknown", "YouTube may have applied it. Refresh to check."],
  ] as Array<[YouTubeThumbnailOutcome, string]>)("reports the %s outcome", async (outcome, expected) => {
    const onSetThumbnail = vi.fn(async () => outcome);
    await renderChange({ candidates: [JPEG], onSetThumbnail });

    await openPicker();
    await userEvent.click(screen.getByRole("radio", { name: "cover.jpg" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm thumbnail change" }));

    expect(await screen.findByRole("status")).toHaveTextContent(expected);
  });

  it("keeps the picker open after a refusal so another image can be chosen", async () => {
    const onSetThumbnail = vi.fn(async () => "media_not_usable" as const);
    await renderChange({ candidates: [JPEG, PNG], onSetThumbnail });

    await openPicker();
    await userEvent.click(screen.getByRole("radio", { name: "cover.jpg" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm thumbnail change" }));

    expect(await screen.findByRole("status")).toHaveTextContent("This image cannot be used.");
    expect(screen.getByRole("radio", { name: "logo.png" })).toBeInTheDocument();
  });

  it("explains that the media library could not be read", async () => {
    await renderChange({ candidates: [], candidatesError: new Error("read failed") });

    await openPicker();

    expect(
      screen.getByText("Postora could not read your media library. Nothing was changed."),
    ).toBeInTheDocument();
  });
});
