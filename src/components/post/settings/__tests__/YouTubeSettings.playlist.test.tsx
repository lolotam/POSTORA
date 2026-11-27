import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { YouTubeSettings, type YouTubeSettingsState } from "../YouTubeSettings";

// The component reads its copy from the postsettings namespace; the mock keeps
// the English defaults so the assertions can read the sentences a creator
// actually sees.
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

// The playlist catalog is a read of the provider, not a decision of this
// component. The suite drives it so the selector's own behaviour — the
// options, the cursor, the retry — is what is under test.
const playlistCatalog = vi.hoisted(() => ({
  playlists: [] as Array<{
    id: string;
    title: string;
    privacy_status: string | null;
    thumbnail_url: string | null;
  }>,
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

vi.mock("../YouTubeAISuggestions", () => ({ YouTubeAISuggestions: () => null }));
vi.mock("../../MediaLibraryPicker", () => ({ MediaLibraryPicker: () => null }));
vi.mock("../../StockMediaPicker", () => ({ StockMediaPicker: () => null }));
vi.mock("@/components/ai/ResolvedModelCards", () => ({ ResolvedModelCards: () => null }));

beforeEach(() => {
  playlistCatalog.playlists = [];
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
};

interface TestAccount {
  id: string;
  platform_username: string | null;
  avatar_url: null;
  auth_provider?: "native" | "composio";
  /** The YouTube channel behind the account. */
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

/**
 * Renders the settings the way the post form does: the parent owns the state
 * and writes every change back, so the component sees its own output.
 */
function renderSettings(
  overrides: Partial<YouTubeSettingsState> = {},
  selectedAccounts: TestAccount[] = [],
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
        hasVideo={false}
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

function playlistSelect() {
  return screen.getByRole("combobox", { name: "Playlist" });
}

function openPlaylistSelect() {
  fireEvent.pointerDown(playlistSelect(), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  return screen.getByRole("listbox");
}

const MULTI_CHANNEL_NOTE =
  "Playlists belong to a single channel. Select one YouTube channel to add this video to a playlist.";

describe("YouTubeSettings playlist selector", () => {
  it("lists the playlists of the one native channel and records the chosen one", () => {
    playlistCatalog.playlists = [
      { id: "PL123", title: "Launch videos", privacy_status: "private", thumbnail_url: null },
    ];
    const { onSettingsChange } = renderSettings({}, [nativeAccount("account-1", "UC_1")]);

    const listbox = openPlaylistSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "Launch videos (private)" }));

    expect(onSettingsChange).toHaveBeenCalledWith({ playlist: "PL123" });
  });

  it("records no playlist when the creator clears the choice", () => {
    playlistCatalog.playlists = [
      { id: "PL123", title: "Launch videos", privacy_status: "private", thumbnail_url: null },
    ];
    const { onSettingsChange } = renderSettings({ playlist: "PL123" }, [nativeAccount("account-1", "UC_1")]);

    const listbox = openPlaylistSelect();
    fireEvent.click(within(listbox).getByRole("option", { name: "No playlist" }));

    expect(onSettingsChange).toHaveBeenCalledWith({ playlist: "" });
  });

  it("keeps a stored playlist visible before the list arrives", () => {
    playlistCatalog.playlists = [];
    renderSettings({ playlist: "PL123" }, [nativeAccount("account-1", "UC_1")]);

    const listbox = openPlaylistSelect();
    expect(within(listbox).getByRole("option", { name: "PL123" })).toBeInTheDocument();
  });

  it("loads the next page of playlists on demand", () => {
    playlistCatalog.hasMore = true;
    renderSettings({}, [nativeAccount("account-1", "UC_1")]);

    fireEvent.click(screen.getByRole("button", { name: "Load more playlists" }));

    expect(playlistCatalog.loadMore).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when the playlists could not be read", () => {
    playlistCatalog.unavailable = true;
    renderSettings({}, [nativeAccount("account-1", "UC_1")]);

    expect(screen.getByText("Could not load playlists.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry playlists" }));

    expect(playlistCatalog.retry).toHaveBeenCalledTimes(1);
  });

  it("says that the playlists are still arriving", () => {
    playlistCatalog.loading = true;
    renderSettings({}, [nativeAccount("account-1", "UC_1")]);

    expect(screen.getByText("Loading playlists…")).toBeInTheDocument();
  });

  it("disables the selector and clears the choice for two distinct native channels", () => {
    const { onSettingsChange } = renderSettings({ playlist: "PL123" }, [
      nativeAccount("account-1", "UC_1"),
      nativeAccount("account-2", "UC_2"),
    ]);

    expect(playlistSelect()).toBeDisabled();
    expect(screen.getByTestId("youtube-playlist-multi-channel-note")).toHaveTextContent(MULTI_CHANNEL_NOTE);
    expect(onSettingsChange).toHaveBeenCalledWith({ playlist: "" });
  });

  it("keeps the selector usable when the same channel is selected twice", () => {
    renderSettings({}, [
      nativeAccount("account-1", "UC_1"),
      nativeAccount("account-2", "UC_1"),
    ]);

    expect(playlistSelect()).not.toBeDisabled();
    expect(screen.queryByTestId("youtube-playlist-multi-channel-note")).toBeNull();
  });

  it("keeps the selector usable for the native channel next to a managed one", () => {
    renderSettings({}, [
      nativeAccount("account-1", "UC_1"),
      {
        id: "account-2",
        platform_username: "managed",
        avatar_url: null,
        auth_provider: "composio",
        platform_user_id: "UC_2",
      },
    ]);

    expect(playlistSelect()).not.toBeDisabled();
    expect(screen.queryByTestId("youtube-playlist-multi-channel-note")).toBeNull();
  });

  it("disables the selector when only a managed channel is selected", () => {
    renderSettings({}, [
      {
        id: "account-1",
        platform_username: "managed",
        avatar_url: null,
        auth_provider: "composio",
        platform_user_id: "UC_1",
      },
    ]);

    expect(playlistSelect()).toBeDisabled();
  });
});
