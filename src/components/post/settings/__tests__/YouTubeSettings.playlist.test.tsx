import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { YouTubeSettings, type YouTubeSettingsState } from "../YouTubeSettings";
import type { YouTubeAccountCapabilities } from "@/features/youtube-management/domain/types";

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
  capabilities: null as YouTubeAccountCapabilities["capabilities"] | null,
  capabilitiesLoading: false,
  capabilitiesUnavailable: false,
  loading: false,
  loadingMore: false,
  creating: false,
  unavailable: false,
  hasMore: false,
  loadMore: vi.fn(),
  retry: vi.fn(),
  createPlaylist: vi.fn(),
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
  playlistCatalog.capabilities = {
    browse: { state: "available" },
    upload: { state: "available" },
    comments: { state: "available" },
    manage_playlists: { state: "available" },
  };
  playlistCatalog.capabilitiesLoading = false;
  playlistCatalog.capabilitiesUnavailable = false;
  playlistCatalog.loading = false;
  playlistCatalog.loadingMore = false;
  playlistCatalog.creating = false;
  playlistCatalog.unavailable = false;
  playlistCatalog.hasMore = false;
  playlistCatalog.loadMore.mockClear();
  playlistCatalog.retry.mockClear();
  playlistCatalog.createPlaylist.mockReset();
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

  it("clears the chosen playlist when switching from channel A to channel B across an empty selection", () => {
    const onSettingsChange = vi.fn();
    function SwitchHarness({ accounts }: { accounts: TestAccount[] }) {
      const [settings, setSettings] = useState<YouTubeSettingsState>({
        ...BASE_SETTINGS,
        playlist: "PL123",
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
          selectedAccounts={accounts}
        />
      );
    }

    const { rerender } = render(<SwitchHarness accounts={[nativeAccount("account-1", "UC_1")]} />);
    expect(onSettingsChange).not.toHaveBeenCalled();

    rerender(<SwitchHarness accounts={[]} />);
    expect(onSettingsChange).not.toHaveBeenCalled();

    rerender(<SwitchHarness accounts={[nativeAccount("account-2", "UC_2")]} />);
    expect(onSettingsChange).toHaveBeenCalledWith({ playlist: "" });
  });

  it("hides '+ New playlist' when a Composio-managed account or multiple distinct native channels are selected", () => {
    renderSettings({}, [
      {
        id: "account-1",
        platform_username: "managed",
        avatar_url: null,
        auth_provider: "composio",
        platform_user_id: "UC_1",
      },
    ]);
    expect(screen.queryByTestId("youtube-new-playlist-button")).toBeNull();
    cleanup();

    renderSettings({}, [
      nativeAccount("account-1", "UC_1"),
      nativeAccount("account-2", "UC_2"),
    ]);
    expect(screen.queryByTestId("youtube-new-playlist-button")).toBeNull();
  });

  it.each([
    {
      scenario: "manage_playlists is absent on an older backend response",
      capabilities: {
        browse: { state: "available" },
        upload: { state: "available" },
        comments: { state: "available" },
      } as YouTubeAccountCapabilities["capabilities"],
      expectedReason:
        "Reconnect this channel and allow Postora to manage your YouTube account (force-ssl) to create playlists.",
    },
    {
      scenario: "manage_playlists is unknown",
      capabilities: {
        browse: { state: "available" },
        upload: { state: "available" },
        comments: { state: "available" },
        manage_playlists: { state: "unknown" },
      } as YouTubeAccountCapabilities["capabilities"],
      expectedReason:
        "Reconnect this channel and allow Postora to manage your YouTube account (force-ssl) to create playlists.",
    },
    {
      scenario: "manage_playlists is missing_scope (upload only without force-ssl)",
      capabilities: {
        browse: { state: "available" },
        upload: { state: "available" },
        comments: { state: "unavailable", reason: "missing_scope" },
        manage_playlists: { state: "unavailable", reason: "missing_scope" },
      } as YouTubeAccountCapabilities["capabilities"],
      expectedReason:
        "Reconnect this channel and allow Postora to manage your YouTube account (force-ssl) to create playlists.",
    },
    {
      scenario: "manage_playlists is reconnect_required",
      capabilities: {
        browse: { state: "unavailable", reason: "reconnect_required" },
        upload: { state: "unavailable", reason: "reconnect_required" },
        comments: { state: "unavailable", reason: "reconnect_required" },
        manage_playlists: { state: "unavailable", reason: "reconnect_required" },
      } as YouTubeAccountCapabilities["capabilities"],
      expectedReason: "This channel needs to be reconnected before playlists can be created.",
    },
  ])("disables '+ New playlist' with its reason when $scenario", ({ capabilities, expectedReason }) => {
    playlistCatalog.capabilities = capabilities;
    renderSettings({}, [nativeAccount("account-1", "UC_1")]);

    const newBtn = screen.getByTestId("youtube-new-playlist-button");
    expect(newBtn).toBeDisabled();
    expect(screen.getByTestId("youtube-playlist-create-disabled-note")).toHaveTextContent(expectedReason);
  });

  it("opens the dialog with no default privacy selected, validates title and description limits, and creates + selects the new playlist", async () => {
    playlistCatalog.createPlaylist.mockResolvedValueOnce({
      outcome: "created",
      playlist: {
        id: "PL_CREATED_99",
        title: "Course Videos",
        privacy_status: "unlisted",
        thumbnail_url: null,
      },
    });

    const { onSettingsChange } = renderSettings({}, [nativeAccount("account-1", "UC_1")]);

    const newBtn = screen.getByTestId("youtube-new-playlist-button");
    expect(newBtn).not.toBeDisabled();
    fireEvent.click(newBtn);

    const dialog = screen.getByTestId("youtube-new-playlist-dialog");
    const titleInput = within(dialog).getByLabelText("Playlist title");
    const descInput = within(dialog).getByLabelText("Description (optional)");
    const privacySelect = within(dialog).getByLabelText("Playlist privacy") as HTMLSelectElement;
    const submitBtn = within(dialog).getByTestId("youtube-new-playlist-submit");

    // No default privacy selected initially; submit disabled
    expect(privacySelect.value).toBe("");
    expect(submitBtn).toBeDisabled();

    // Title alone without privacy keeps submit disabled
    fireEvent.change(titleInput, { target: { value: "Course Videos" } });
    expect(submitBtn).toBeDisabled();

    // Select privacy -> submit enabled
    fireEvent.change(privacySelect, { target: { value: "unlisted" } });
    expect(submitBtn).not.toBeDisabled();

    // Rejects `<` or `>` in title without calling createPlaylist
    fireEvent.change(titleInput, { target: { value: "Bad <title>" } });
    fireEvent.click(submitBtn);
    expect(within(dialog).getByTestId("youtube-new-playlist-error")).toHaveTextContent(
      "Enter a playlist title (1–150 characters, single line, without < or >).",
    );
    expect(playlistCatalog.createPlaylist).not.toHaveBeenCalled();

    // Rejects > 5000 UTF-8 bytes in description (2600 Arabic letters = 5200 UTF-8 bytes)
    fireEvent.change(titleInput, { target: { value: "Course Videos" } });
    fireEvent.change(descInput, { target: { value: "ش".repeat(2600) } });
    fireEvent.click(submitBtn);
    expect(within(dialog).getByTestId("youtube-new-playlist-error")).toHaveTextContent(
      "Playlist description must be at most 5,000 UTF-8 bytes and cannot contain < or >.",
    );
    expect(playlistCatalog.createPlaylist).not.toHaveBeenCalled();

    // Valid submission creates playlist, closes dialog, and selects new playlist ID
    fireEvent.change(descInput, { target: { value: "All episodes" } });
    fireEvent.click(submitBtn);

    await waitFor(() =>
      expect(playlistCatalog.createPlaylist).toHaveBeenCalledWith({
        title: "Course Videos",
        description: "All episodes",
        privacyStatus: "unlisted",
      }),
    );
    await waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith({ playlist: "PL_CREATED_99" }));
    expect(screen.queryByTestId("youtube-new-playlist-dialog")).toBeNull();
  });

  it("closes the dialog, shows the check-the-list notice, selects nothing, and makes only one create call on outcome_unknown", async () => {
    playlistCatalog.createPlaylist.mockResolvedValueOnce({
      outcome: "outcome_unknown",
    });

    const { onSettingsChange } = renderSettings({}, [nativeAccount("account-1", "UC_1")]);

    fireEvent.click(screen.getByTestId("youtube-new-playlist-button"));
    const dialog = screen.getByTestId("youtube-new-playlist-dialog");
    fireEvent.change(within(dialog).getByLabelText("Playlist title"), {
      target: { value: "Uncertain Playlist" },
    });
    fireEvent.change(within(dialog).getByLabelText("Playlist privacy"), {
      target: { value: "private" },
    });
    fireEvent.click(within(dialog).getByTestId("youtube-new-playlist-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("youtube-playlist-outcome-unknown")).toHaveTextContent(
        "YouTube may have created the playlist. Check the list before trying again.",
      ),
    );
    expect(screen.queryByTestId("youtube-new-playlist-dialog")).toBeNull();
    expect(playlistCatalog.createPlaylist).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("displays the rate-limited message with wait time when createPlaylist returns rate_limited", async () => {
    playlistCatalog.createPlaylist.mockResolvedValueOnce({
      outcome: "rate_limited",
      retryAfterSeconds: 1800,
    });

    renderSettings({}, [nativeAccount("account-1", "UC_1")]);

    fireEvent.click(screen.getByTestId("youtube-new-playlist-button"));
    const dialog = screen.getByTestId("youtube-new-playlist-dialog");
    fireEvent.change(within(dialog).getByLabelText("Playlist title"), {
      target: { value: "Sixth Playlist" },
    });
    fireEvent.change(within(dialog).getByLabelText("Playlist privacy"), {
      target: { value: "private" },
    });
    fireEvent.click(within(dialog).getByTestId("youtube-new-playlist-submit"));

    await waitFor(() =>
      expect(within(dialog).getByTestId("youtube-new-playlist-error")).toHaveTextContent(
        "Playlist creation is rate-limited (up to 5 new playlists per 24 hours). Try again in 30 minutes.",
      ),
    );
  });

  it("does not select the old channel's playlist on the new channel when switching channels while createPlaylist is pending", async () => {
    let resolveCreate!: (value: unknown) => void;
    playlistCatalog.createPlaylist.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveCreate = res;
        }),
    );

    const onSettingsChange = vi.fn();
    function SwitchWhileCreatingHarness({ accounts }: { accounts: TestAccount[] }) {
      const [settings, setSettings] = useState<YouTubeSettingsState>(BASE_SETTINGS);
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
          selectedAccounts={accounts}
        />
      );
    }

    const { rerender } = render(
      <SwitchWhileCreatingHarness accounts={[nativeAccount("account-1", "UC_1")]} />,
    );

    fireEvent.click(screen.getByTestId("youtube-new-playlist-button"));
    const dialog = screen.getByTestId("youtube-new-playlist-dialog");
    fireEvent.change(within(dialog).getByLabelText("Playlist title"), {
      target: { value: "Channel 1 Playlist" },
    });
    fireEvent.change(within(dialog).getByLabelText("Playlist privacy"), {
      target: { value: "private" },
    });
    fireEvent.click(within(dialog).getByTestId("youtube-new-playlist-submit"));
    expect(playlistCatalog.createPlaylist).toHaveBeenCalledTimes(1);

    // Switch to channel 2 while createPlaylist is still pending
    rerender(<SwitchWhileCreatingHarness accounts={[nativeAccount("account-2", "UC_2")]} />);
    expect(screen.queryByTestId("youtube-new-playlist-dialog")).toBeNull();

    resolveCreate({
      outcome: "created",
      playlist: {
        id: "PL_FROM_CHANNEL_1",
        title: "Channel 1 Playlist",
        privacy_status: "private",
        thumbnail_url: null,
      },
    });

    await waitFor(() => expect(playlistCatalog.createPlaylist).toHaveBeenCalledTimes(1));
    expect(onSettingsChange).not.toHaveBeenCalledWith({ playlist: "PL_FROM_CHANNEL_1" });
  });

  it("does not call onSettingsChange when the component unmounts while createPlaylist is pending", async () => {
    let resolveCreate!: (value: unknown) => void;
    playlistCatalog.createPlaylist.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveCreate = res;
        }),
    );

    const { onSettingsChange } = renderSettings({}, [nativeAccount("account-1", "UC_1")]);
    fireEvent.click(screen.getByTestId("youtube-new-playlist-button"));
    const dialog = screen.getByTestId("youtube-new-playlist-dialog");
    fireEvent.change(within(dialog).getByLabelText("Playlist title"), {
      target: { value: "Unmount Playlist" },
    });
    fireEvent.change(within(dialog).getByLabelText("Playlist privacy"), {
      target: { value: "private" },
    });
    fireEvent.click(within(dialog).getByTestId("youtube-new-playlist-submit"));

    cleanup();

    resolveCreate({
      outcome: "created",
      playlist: {
        id: "PL_AFTER_UNMOUNT",
        title: "Unmount Playlist",
        privacy_status: "private",
        thumbnail_url: null,
      },
    });
    await Promise.resolve();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });
});
