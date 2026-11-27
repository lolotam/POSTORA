import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { YouTubeCapabilityState, YouTubeCaptionTrack, YouTubeCaptionUploadOutcome } from "../../domain/types";
import { YouTubeCaptionsSection } from "../YouTubeCaptionsSection";

const TRACK: YouTubeCaptionTrack = {
  id: "track-1",
  language: "en",
  name: "English",
  track_kind: "standard",
  is_draft: false,
  status: "published",
  last_updated: null,
};

const SRT_CONTENT = "1\n00:00:00,000 --> 00:00:01,000\nHello\n";

async function renderSection(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function section(props: {
  capability?: YouTubeCapabilityState | null;
  onListCaptions?: (videoId: string) => Promise<YouTubeCaptionTrack[]>;
  onUploadCaption?: (params: {
    videoId: string;
    language: string;
    name: string;
    format: "srt" | "vtt";
    content: string;
  }) => Promise<{ outcome: YouTubeCaptionUploadOutcome; track: YouTubeCaptionTrack | null }>;
}) {
  return (
    <YouTubeCaptionsSection
      capability={props.capability ?? { state: "available" }}
      videoId="video-1"
      onListCaptions={props.onListCaptions}
      onUploadCaption={props.onUploadCaption}
    />
  );
}

function captionFile(name: string, content: string): File {
  return new File([content], name, { type: "text/plain" });
}

describe("YouTubeCaptionsSection — listing the tracks", () => {
  it("spends no caption list before the creator asks for one", async () => {
    const onListCaptions = vi.fn(async () => [TRACK]);
    await renderSection(section({ onListCaptions }));

    expect(onListCaptions).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Show caption tracks" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("lists the tracks of the video when the creator asks for them", async () => {
    const onListCaptions = vi.fn(async () => [TRACK]);
    await renderSection(section({ onListCaptions }));

    await userEvent.click(screen.getByRole("button", { name: "Show caption tracks" }));

    expect(onListCaptions).toHaveBeenCalledTimes(1);
    expect(onListCaptions).toHaveBeenCalledWith("video-1");
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("cell", { name: "en" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "English" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "standard" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "published" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "No" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh caption tracks" })).toBeInTheDocument();
  });

  it("says when the video has no caption track", async () => {
    const onListCaptions = vi.fn(async () => []);
    await renderSection(section({ onListCaptions }));

    await userEvent.click(screen.getByRole("button", { name: "Show caption tracks" }));

    expect(await screen.findByText("No caption tracks found for this video.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("offers a retry when the list cannot be read, and never shows an empty list", async () => {
    const onListCaptions = vi.fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce([TRACK]);
    await renderSection(section({ onListCaptions }));

    await userEvent.click(screen.getByRole("button", { name: "Show caption tracks" }));

    expect(await screen.findByText("Postora could not read the caption tracks of this video.")).toBeInTheDocument();
    expect(screen.queryByText("No caption tracks found for this video.")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry caption tracks" }));

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(onListCaptions).toHaveBeenCalledTimes(2);
  });
});

describe("YouTubeCaptionsSection — the capability gate", () => {
  it.each([
    ["reconnect_required", "This channel needs to be reconnected before captions management is available."],
    ["missing_scope", "Reconnect this channel and grant YouTube caption permissions (force-ssl) to manage captions."],
    ["provider_unsupported", "Captions management is not available for managed connections."],
  ])("explains a %s channel and reads no caption track", async (reason, message) => {
    const onListCaptions = vi.fn(async () => [TRACK]);
    await renderSection(section({
      capability: { state: "unavailable", reason: reason as "reconnect_required" },
      onListCaptions,
    }));

    expect(screen.getByRole("button", { name: "Show caption tracks" })).toBeDisabled();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(onListCaptions).not.toHaveBeenCalled();
  });

  it("explains an unknown capability and spends no call", async () => {
    const onListCaptions = vi.fn(async () => [TRACK]);
    await renderSection(section({ capability: { state: "unknown" }, onListCaptions }));

    expect(screen.getByRole("button", { name: "Show caption tracks" })).toBeDisabled();
    expect(screen.getByText("Captions management is currently unavailable for this channel.")).toBeInTheDocument();
    expect(onListCaptions).not.toHaveBeenCalled();
  });
});

describe("YouTubeCaptionsSection — uploading a track", () => {
  it("refuses a caption file over 512 KB in the browser, before any upload", async () => {
    const onUploadCaption = vi.fn(async () => ({ outcome: "uploaded" as const, track: TRACK }));
    await renderSection(section({ onUploadCaption }));

    // Arabic letters cost two UTF-8 bytes each: 375,000 characters are
    // 750,000 bytes, over the 512 KB ceiling the page enforces.
    const oversize = captionFile("captions.srt", "مرحبا".repeat(75_000));
    await userEvent.upload(screen.getByLabelText("Caption file (.srt or .vtt)"), oversize);

    expect(await screen.findByText("Caption file exceeds the 512 KB UTF-8 limit.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare caption upload" })).toBeDisabled();
    expect(onUploadCaption).not.toHaveBeenCalled();
  });

  it("refuses a caption file that is not valid UTF-8 before any upload", async () => {
    const onUploadCaption = vi.fn(async () => ({ outcome: "uploaded" as const, track: TRACK }));
    await renderSection(section({ onUploadCaption }));

    const malformed = captionFile("captions.srt", "1\n00:00:00,000 --> 00:00:01,000\n\uFFFD\n");
    await userEvent.upload(screen.getByLabelText("Caption file (.srt or .vtt)"), malformed);

    expect(
      await screen.findByText("Caption file is not valid UTF-8. Save the file as UTF-8 and try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare caption upload" })).toBeDisabled();
    expect(onUploadCaption).not.toHaveBeenCalled();
  });

  it("shows the file size and the 512 KB limit, and refuses a file that is not .srt or .vtt", async () => {
    await renderSection(section({}));

    await userEvent.upload(
      screen.getByLabelText("Caption file (.srt or .vtt)"),
      captionFile("captions.srt", SRT_CONTENT),
    );

    expect(await screen.findByText(/File size: 0.0 KB \(limit 512 KB \/ 524288 UTF-8 bytes\)/)).toBeInTheDocument();

    const notACaption = captionFile("notes.txt", SRT_CONTENT);
    fireEvent.change(screen.getByLabelText("Caption file (.srt or .vtt)"), { target: { files: [notACaption] } });
    expect(await screen.findByText("Choose an .srt or .vtt caption file.")).toBeInTheDocument();
  });

  it("asks for a confirmation before the upload and writes once", async () => {
    const onUploadCaption = vi.fn(async () => ({ outcome: "uploaded" as const, track: TRACK }));
    await renderSection(section({ onUploadCaption }));

    await userEvent.upload(
      screen.getByLabelText("Caption file (.srt or .vtt)"),
      captionFile("captions.srt", SRT_CONTENT),
    );
    await userEvent.selectOptions(screen.getByLabelText("Caption language"), "ar");
    await userEvent.type(screen.getByLabelText("Track name (optional)"), "العربية");

    await userEvent.click(screen.getByRole("button", { name: "Prepare caption upload" }));

    expect(screen.getByText("This uploads a new caption track to your YouTube video")).toBeInTheDocument();
    expect(onUploadCaption).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Confirm caption upload" }));

    await waitFor(() => expect(onUploadCaption).toHaveBeenCalledTimes(1));
    expect(onUploadCaption).toHaveBeenCalledWith({
      videoId: "video-1",
      language: "ar",
      name: "العربية",
      format: "srt",
      content: SRT_CONTENT,
    });
    expect(await screen.findByText("Caption track uploaded to YouTube.")).toHaveAttribute("role", "status");
    // The new track is shown without paying for a second caption list.
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("cell", { name: "English" })).toBeInTheDocument();
  });

  it("cancels the confirmation without writing anything", async () => {
    const onUploadCaption = vi.fn(async () => ({ outcome: "uploaded" as const, track: TRACK }));
    await renderSection(section({ onUploadCaption }));

    await userEvent.upload(
      screen.getByLabelText("Caption file (.srt or .vtt)"),
      captionFile("captions.vtt", "WEBVTT\n"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Prepare caption upload" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("This uploads a new caption track to your YouTube video")).not.toBeInTheDocument();
    expect(onUploadCaption).not.toHaveBeenCalled();
  });

  it("disables every control while the upload is in flight", async () => {
    let release: (() => void) | null = null;
    const onUploadCaption = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { outcome: "uploaded" as const, track: TRACK };
    });
    await renderSection(section({ onUploadCaption }));

    await userEvent.upload(
      screen.getByLabelText("Caption file (.srt or .vtt)"),
      captionFile("captions.srt", SRT_CONTENT),
    );
    await userEvent.click(screen.getByRole("button", { name: "Prepare caption upload" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm caption upload" }));

    await waitFor(() => expect(onUploadCaption).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Caption file (.srt or .vtt)")).toBeDisabled();
    expect(screen.getByLabelText("Caption language")).toBeDisabled();
    expect(screen.getByLabelText("Track name (optional)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirm caption upload" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    release?.();
    await screen.findByText("Caption track uploaded to YouTube.");
  });

  it.each([
    ["caption_conflict", "A caption track with this language and name already exists on YouTube."],
    ["caption_invalid", "This caption file is invalid. Check the SRT or VTT timestamps and ensure it is under 512 KB."],
    ["rate_limited", "Caption upload limit reached (2 uploads per 24 hours). Try again tomorrow."],
    ["quota_exceeded", "Caption upload limit reached (2 uploads per 24 hours). Try again tomorrow."],
    ["refused", "Caption track could not be uploaded. Nothing was changed on YouTube."],
    ["outcome_unknown", "YouTube may have added this caption track. Refresh the track list before trying again."],
  ])("states the %s outcome in words", async (outcome, message) => {
    const onUploadCaption = vi.fn(async () => ({ outcome: outcome as YouTubeCaptionUploadOutcome, track: null }));
    await renderSection(section({ onUploadCaption }));

    await userEvent.upload(
      screen.getByLabelText("Caption file (.srt or .vtt)"),
      captionFile("captions.srt", SRT_CONTENT),
    );
    await userEvent.click(screen.getByRole("button", { name: "Prepare caption upload" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm caption upload" }));

    const status = await screen.findByText(message);
    expect(status).toHaveAttribute("role", "status");
    expect(onUploadCaption).toHaveBeenCalledTimes(1);
  });

  it("tells the creator how many uploads are left in the day", async () => {
    await renderSection(section({}));
    expect(
      screen.getByText("Daily caption upload allowance: up to 2 uploads per 24 hours (512 KB max per file)."),
    ).toBeInTheDocument();
  });
});
