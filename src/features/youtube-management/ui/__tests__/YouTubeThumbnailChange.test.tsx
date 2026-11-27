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
  preview_url: "https://storage.test/media/user-1/cover.jpg",
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
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function renderChange(props: {
  capability?: YouTubeCapabilityState | null;
  candidates?: YouTubeThumbnailCandidate[];
  candidatesLoading?: boolean;
  candidatesError?: unknown;
  onSetThumbnail?: (mediaFileId: string) => Promise<YouTubeThumbnailOutcome>;
  currentThumbnailUrl?: string | null;
  onUploadImage?: (params: { blob: Blob; fileName: string; mimeType: "image/jpeg" | "image/png" }) => Promise<YouTubeThumbnailCandidate>;
  onGenerateAiImage?: (params: { prompt: string; referenceImage?: string }) => Promise<{ imageUrl: string }>;
  prepareAiImageBlob?: (imageUrl: string) => Promise<{ blob: Blob; mimeType: "image/jpeg" | "image/png" }>;
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
        currentThumbnailUrl={props.currentThumbnailUrl}
        onUploadImage={props.onUploadImage}
        onGenerateAiImage={props.onGenerateAiImage}
        prepareAiImageBlob={props.prepareAiImageBlob}
      />
    </I18nextProvider>,
  );
}

async function openPicker() {
  await userEvent.click(await screen.findByRole("button", { name: "Change thumbnail" }));
}

function jpegFile(name = "cover.jpg", bytes = 64): File {
  return new File([JPEG_HEAD, new Uint8Array(bytes)], name, { type: "image/jpeg" });
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

describe("YouTubeThumbnailChange — the small preview", () => {
  it("shows the thumbnail the video has today", async () => {
    await renderChange({ candidates: [JPEG], currentThumbnailUrl: "https://img.test/current.jpg" });

    expect(screen.getByRole("img", { name: "Thumbnail preview" })).toHaveAttribute("src", "https://img.test/current.jpg");
  });

  it("shows no image when the video has no thumbnail", async () => {
    await renderChange({ candidates: [JPEG] });

    expect(screen.queryByRole("img", { name: "Thumbnail preview" })).not.toBeInTheDocument();
  });

  it("shows the applied image and says YouTube may take a moment", async () => {
    const onSetThumbnail = vi.fn(async () => "applied" as const);
    await renderChange({ candidates: [JPEG], onSetThumbnail });

    await openPicker();
    await userEvent.click(screen.getByRole("radio", { name: "cover.jpg" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm thumbnail change" }));

    expect(await screen.findByText("YouTube may take a few minutes to show the new thumbnail")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Thumbnail preview" }))
      .toHaveAttribute("src", "https://storage.test/media/user-1/cover.jpg");
  });
});

describe("YouTubeThumbnailChange — the three tabs", () => {
  it("opens on the media library and offers the other two ways in", async () => {
    await renderChange({ candidates: [JPEG] });

    await openPicker();

    expect(screen.getByRole("tab", { name: "Media library" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Upload file" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Generate with AI" })).toBeInTheDocument();
  });

  it("stores an uploaded image and writes it once after the confirmation", async () => {
    const onUploadImage = vi.fn(async () => ({ ...JPEG, id: "media-uploaded" }));
    const onSetThumbnail = vi.fn(async () => "applied" as const);
    await renderChange({ candidates: [], onUploadImage, onSetThumbnail });

    await openPicker();
    await userEvent.click(screen.getByRole("tab", { name: "Upload file" }));
    await userEvent.upload(screen.getByLabelText("Choose a JPEG or PNG image"), jpegFile());

    expect(await screen.findByText("New thumbnail: cover.jpg")).toBeInTheDocument();
    expect(onSetThumbnail).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Confirm thumbnail change" }));

    expect(onSetThumbnail).toHaveBeenCalledTimes(1);
    expect(onSetThumbnail).toHaveBeenCalledWith("media-uploaded");
  });

  it("refuses an oversize file before it is stored", async () => {
    const onUploadImage = vi.fn(async () => JPEG);
    await renderChange({ candidates: [], onUploadImage });

    await openPicker();
    await userEvent.click(screen.getByRole("tab", { name: "Upload file" }));
    const oversize = new File([JPEG_HEAD, new Uint8Array(2 * 1024 * 1024 + 1)], "huge.jpg", { type: "image/jpeg" });
    await userEvent.upload(screen.getByLabelText("Choose a JPEG or PNG image"), oversize);

    expect(await screen.findByText("That image is larger than 2 MB. Choose a smaller one.")).toBeInTheDocument();
    expect(onUploadImage).not.toHaveBeenCalled();
  });

  it("refuses a file whose bytes are not the format it claims", async () => {
    const onUploadImage = vi.fn(async () => JPEG);
    await renderChange({ candidates: [], onUploadImage });

    await openPicker();
    await userEvent.click(screen.getByRole("tab", { name: "Upload file" }));
    const mislabelled = new File([PNG_HEAD, new Uint8Array(64)], "cover.jpg", { type: "image/jpeg" });
    await userEvent.upload(screen.getByLabelText("Choose a JPEG or PNG image"), mislabelled);

    expect(
      await screen.findByText("That file is not the format it says it is. Choose a JPEG or a PNG."),
    ).toBeInTheDocument();
    expect(onUploadImage).not.toHaveBeenCalled();
  });

  it("materialises a generated image and writes it once after the confirmation", async () => {
    const onGenerateAiImage = vi.fn(async () => ({ imageUrl: "https://images.test/thumb.jpg" }));
    const onUploadImage = vi.fn(async () => ({ ...JPEG, id: "media-generated" }));
    const onSetThumbnail = vi.fn(async () => "applied" as const);
    await renderChange({
      candidates: [],
      onGenerateAiImage,
      onUploadImage,
      onSetThumbnail,
      prepareAiImageBlob: async () => ({ blob: jpegFile("ai-thumbnail.jpg"), mimeType: "image/jpeg" }),
    });

    await openPicker();
    await userEvent.click(screen.getByRole("tab", { name: "Generate with AI" }));
    await userEvent.type(screen.getByLabelText("Describe the thumbnail"), "a calm studio desk");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    await userEvent.click(await screen.findByRole("button", { name: "Use this AI thumbnail" }));

    expect(onGenerateAiImage).toHaveBeenCalledWith({ prompt: "a calm studio desk", referenceImage: undefined });
    expect(onUploadImage).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("New thumbnail: cover.jpg")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Confirm thumbnail change" }));

    expect(onSetThumbnail).toHaveBeenCalledTimes(1);
    expect(onSetThumbnail).toHaveBeenCalledWith("media-generated");
  });

  it("stores nothing when the generated image cannot become a thumbnail", async () => {
    const onGenerateAiImage = vi.fn(async () => ({ imageUrl: "https://images.test/thumb.jpg" }));
    const onUploadImage = vi.fn(async () => JPEG);
    await renderChange({
      candidates: [],
      onGenerateAiImage,
      onUploadImage,
      prepareAiImageBlob: async () => {
        throw new Error("too big");
      },
    });

    await openPicker();
    await userEvent.click(screen.getByRole("tab", { name: "Generate with AI" }));
    await userEvent.type(screen.getByLabelText("Describe the thumbnail"), "a calm studio desk");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await userEvent.click(await screen.findByRole("button", { name: "Use this AI thumbnail" }));

    expect(await screen.findByText("This image could not be prepared as a thumbnail")).toBeInTheDocument();
    expect(onUploadImage).not.toHaveBeenCalled();
  });
});
