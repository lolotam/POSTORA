import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { YouTubeSettings, type YouTubeSettingsState } from "../YouTubeSettings";
import type { YouTubeAccountCapabilities } from "@/features/youtube-management/domain/types";

const translate = vi.hoisted(() => (
  key: string,
  fallback?: string | Record<string, unknown>,
  options?: Record<string, unknown>,
) => {
  const template = typeof fallback === "string" ? fallback : key;
  const vars = typeof fallback === "string" ? options : fallback;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate, i18n: { language: "en" } }),
}));
vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: { aiThumbnails: false } }),
}));
vi.mock("@/hooks/useResolvedImageModels", () => ({
  useResolvedImageModels: () => ({ tiers: [], isLoading: false }),
}));
vi.mock("@/hooks/useYouTubeCategories", () => ({
  useYouTubeCategories: () => ({
    categories: [],
    loading: false,
    unavailable: false,
    region: "US",
    retry: vi.fn(),
  }),
}));

const playlistCatalog = vi.hoisted(() => ({
  playlists: [] as Array<{
    id: string;
    title: string;
    privacy_status: string | null;
    thumbnail_url: string | null;
  }>,
  capabilities: null as YouTubeAccountCapabilities["capabilities"] | null,
  loading: false,
  loadingMore: false,
  unavailable: false,
  hasMore: false,
  loadMore: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("@/hooks/useYouTubePlaylists", () => ({
  useYouTubePlaylists: () => ({ ...playlistCatalog }),
}));

const GENERATED_VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nGenerated from audio\n";
const GENERATED_SRT = "1\n00:00:00,000 --> 00:00:02,000\nGenerated from audio\n";

vi.mock("../YouTubeAISuggestions", () => ({
  YouTubeAISuggestions: (props: {
    type: string;
    onAudioSubtitlesReady?: (subtitles: { srt: string; vtt: string } | null) => void;
  }) => {
    if (props.type !== "chapters") return null;
    return (
      <button
        type="button"
        onClick={() => props.onAudioSubtitlesReady?.({ srt: GENERATED_SRT, vtt: GENERATED_VTT })}
      >
        Simulate audio subtitles ready
      </button>
    );
  },
}));
vi.mock("../../MediaLibraryPicker", () => ({ MediaLibraryPicker: () => null }));
vi.mock("../../StockMediaPicker", () => ({ StockMediaPicker: () => null }));
vi.mock("@/components/ai/ResolvedModelCards", () => ({ ResolvedModelCards: () => null }));

beforeEach(() => {
  playlistCatalog.playlists = [];
  playlistCatalog.capabilities = {
    browse: { state: "available" },
    upload: { state: "available" },
    comments: { state: "available" },
    edit_metadata: { state: "available" },
    manage_thumbnail: { state: "available" },
    manage_captions: { state: "available" },
  };
  playlistCatalog.loading = false;
  playlistCatalog.loadingMore = false;
  playlistCatalog.unavailable = false;
  playlistCatalog.hasMore = false;
  playlistCatalog.loadMore.mockClear();
  playlistCatalog.retry.mockClear();
});

afterEach(cleanup);

const BASE_SETTINGS: YouTubeSettingsState = {
  videoType: "video",
  title: "A video",
  description: "A description",
  visibility: "public",
  tags: "",
  category: "22",
  madeForKids: false,
  allowEmbedding: true,
  publicStatsViewable: true,
  containsSyntheticMedia: false,
  hasPaidPromotion: false,
  notifySubscribers: true,
  commentsEnabled: true,
  commentModeration: "none",
  whoCanComment: "anyone",
  commentSortBy: "top",
  showLikeCount: true,
  shortsRemixing: "none",
  recordingDate: "",
  videoLocation: "",
  license: "youtube",
  videoLanguage: "",
  audioLanguage: "",
  captionCertification: "none",
  titleDescLanguage: "",
  thumbnailMode: "auto",
  thumbnailUrl: "",
  thumbnailMediaId: null,
  thumbnailFile: null,
  playlist: "",
  allowedCountries: "",
  blockedCountries: "",
  firstComment: "",
  enableFirstComment: false,
  captionTrack: null,
};

interface TestAccount {
  id: string;
  platform_username: string | null;
  avatar_url: null;
  auth_provider?: "native" | "composio";
  platform_user_id?: string | null;
}

function nativeAccount(id: string, channelId: string): TestAccount {
  return {
    id,
    platform_username: channelId,
    avatar_url: null,
    auth_provider: "native",
    platform_user_id: channelId,
  };
}

function renderSettings(
  overrides: Partial<YouTubeSettingsState> = {},
  selectedAccounts: TestAccount[] = [nativeAccount("account-1", "UC_1")],
) {
  const onSettingsChange = vi.fn();

  function Harness() {
    const [settings, setSettings] = useState<YouTubeSettingsState>({
      ...BASE_SETTINGS,
      ...overrides,
    });
    return (
      <YouTubeSettings
        settings={settings}
        onSettingsChange={(changes) => {
          onSettingsChange(changes);
          setSettings((current) => ({ ...current, ...changes }));
        }}
        hasVideo={true}
        videoSourceUrl="https://cdn.example.com/video.mp4"
        autoThumbnails={[]}
        selectedAutoThumbnail={null}
        onSelectAutoThumbnail={vi.fn()}
        onGenerateAutoThumbnails={vi.fn()}
        aiGeneratedThumbnails={[]}
        onGenerateAiThumbnail={vi.fn()}
        isGeneratingAiThumbnail={false}
        onDownloadThumbnail={vi.fn()}
        selectedAccounts={selectedAccounts}
      />
    );
  }

  render(<Harness />);
  return { onSettingsChange };
}

function makeSubtitleFile(content: string, fileName: string): File {
  const file = new File([content], fileName, { type: "text/plain" });
  if (typeof file.text !== "function") {
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve(content),
    });
  }
  return file;
}

describe("YouTubeSettings upload-time Subtitles / CC section", () => {
  it("validates a valid .vtt file in the browser, displays UTF-8 byte size against 512 KB, and emits captionTrack", async () => {
    const { onSettingsChange } = renderSettings();
    const validVtt = "WEBVTT\n\n00:00.000 --> 00:02.500\nHello world\n";
    const file = makeSubtitleFile(validVtt, "captions.vtt");

    const fileInput = screen.getByLabelText("Subtitle file (.srt or .vtt)");
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({
        captionTrack: {
          language: "en",
          name: "",
          format: "vtt",
          content: validVtt,
        },
      }),
    );

    expect(screen.getByTestId("youtube-caption-file-size")).toHaveTextContent(
      /512 KB.*44 UTF-8 bytes/,
    );

    fireEvent.change(screen.getByLabelText("Subtitle language"), { target: { value: "ar" } });
    fireEvent.change(screen.getByLabelText("Track name (optional)"), { target: { value: "Arabic CC" } });

    expect(onSettingsChange).toHaveBeenLastCalledWith({
      captionTrack: {
        language: "ar",
        name: "Arabic CC",
        format: "vtt",
        content: validVtt,
      },
    });
  });

  it("refuses an oversized multi-byte Arabic file (> 512 KB UTF-8) and a malformed subtitle file before storing", async () => {
    const { onSettingsChange } = renderSettings();
    const fileInput = screen.getByLabelText("Subtitle file (.srt or .vtt)");

    // 300,000 Arabic characters = 600,000 UTF-8 bytes (> 524,288 bytes)
    const oversizedArabic = `WEBVTT\n\n00:00.000 --> 00:02.000\n${"ش".repeat(300_000)}\n`;
    const bigFile = makeSubtitleFile(oversizedArabic, "arabic.vtt");
    fireEvent.change(fileInput, { target: { files: [bigFile] } });

    await waitFor(() =>
      expect(screen.getByTestId("youtube-caption-error")).toHaveTextContent(
        "Subtitle file exceeds the 512 KB UTF-8 limit.",
      ),
    );
    expect(onSettingsChange).toHaveBeenLastCalledWith({ captionTrack: null });

    // Malformed SRT timestamps
    const malformedSrt = "1\nnot-a-timestamp\nHello\n";
    const badFile = makeSubtitleFile(malformedSrt, "broken.srt");
    fireEvent.change(fileInput, { target: { files: [badFile] } });

    await waitFor(() =>
      expect(screen.getByTestId("youtube-caption-error")).toHaveTextContent(
        "This subtitle file is invalid. Check the SRT or VTT timestamps and ensure it is under 512 KB.",
      ),
    );
    expect(onSettingsChange).toHaveBeenLastCalledWith({ captionTrack: null });
  });

  it("populates the caption track from PR-16 audio subtitles when 'Use subtitles from the audio' is clicked", async () => {
    const { onSettingsChange } = renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Simulate audio subtitles ready" }));

    const useFromAudioBtn = await screen.findByRole("button", { name: "Use subtitles from the audio" });
    fireEvent.click(useFromAudioBtn);

    expect(onSettingsChange).toHaveBeenCalledWith({
      captionTrack: {
        language: "en",
        name: "",
        format: "vtt",
        content: GENERATED_VTT,
      },
    });
  });

  it("disables Subtitles / CC for Composio-managed accounts and when manage_captions capability is unavailable", async () => {
    // 1. Composio-managed account
    const { onSettingsChange: onComposioChange } = renderSettings(
      {
        captionTrack: {
          language: "en",
          name: "English",
          format: "vtt",
          content: GENERATED_VTT,
        },
      },
      [
        {
          id: "account-composio",
          platform_username: "managed",
          avatar_url: null,
          auth_provider: "composio",
          platform_user_id: "UC_MANAGED",
        },
      ],
    );

    expect(screen.getByLabelText("Subtitle file (.srt or .vtt)")).toBeDisabled();
    expect(screen.getByTestId("youtube-captions-composio-note")).toHaveTextContent(
      "Subtitles / CC upload is not available for managed accounts. Use a native channel.",
    );
    await waitFor(() => expect(onComposioChange).toHaveBeenCalledWith({ captionTrack: null }));
    cleanup();

    // 2. Native account lacking manage_captions (missing_scope)
    playlistCatalog.capabilities = {
      browse: { state: "available" },
      upload: { state: "available" },
      comments: { state: "available" },
      edit_metadata: { state: "available" },
      manage_thumbnail: { state: "available" },
      manage_captions: { state: "unavailable", reason: "missing_scope" },
    };

    const { onSettingsChange: onMissingScopeChange } = renderSettings(
      {
        captionTrack: {
          language: "en",
          name: "English",
          format: "vtt",
          content: GENERATED_VTT,
        },
      },
      [nativeAccount("account-1", "UC_1")],
    );

    expect(screen.getByLabelText("Subtitle file (.srt or .vtt)")).toBeDisabled();
    expect(screen.getByTestId("youtube-captions-capability-note")).toHaveTextContent(
      "Reconnect this channel with YouTube caption permissions (force-ssl) to attach subtitles.",
    );
    await waitFor(() => expect(onMissingScopeChange).toHaveBeenCalledWith({ captionTrack: null }));
  });

  it("displays 'Already submitted' for a rehydrated settled post without content and allows clearing or choosing a new file", async () => {
    const { onSettingsChange } = renderSettings({
      captionTrack: {
        language: "en",
        name: "English",
        format: "vtt",
        alreadySubmitted: true,
      },
    });

    expect(screen.getByTestId("youtube-caption-already-submitted")).toHaveTextContent(
      "Already submitted: en (VTT) — English",
    );

    const validSrt = "1\n00:00:00,000 --> 00:00:02,000\nReplacement track\n";
    const file = makeSubtitleFile(validSrt, "replacement.srt");
    fireEvent.change(screen.getByLabelText("Subtitle file (.srt or .vtt)"), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({
        captionTrack: {
          language: "en",
          name: "English",
          format: "srt",
          content: validSrt,
        },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear subtitles" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ captionTrack: null });
  });
});
