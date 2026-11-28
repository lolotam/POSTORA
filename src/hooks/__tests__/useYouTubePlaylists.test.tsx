import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useYouTubePlaylists } from "../useYouTubePlaylists";
import { YouTubeResourceError } from "@/features/youtube-management/domain/errors";
import type {
  YouTubeAccountCapabilities,
  YouTubePlaylistListItem,
} from "@/features/youtube-management/domain/types";

// The hook's only outward dependency is the resources gateway, which is the
// seam to the provider read. Everything below it is the hook's own logic:
// the cursor, the deduplication and the retry rules.
const { listPlaylistsMock, getCapabilitiesMock, createPlaylistMock } = vi.hoisted(() => ({
  listPlaylistsMock: vi.fn(),
  getCapabilitiesMock: vi.fn(),
  createPlaylistMock: vi.fn(),
}));

vi.mock("@/features/youtube-management/infrastructure/supabaseYouTubeResourcesGateway", () => ({
  SupabaseYouTubeResourcesGateway: class {
    listPlaylists = listPlaylistsMock;
    getCapabilities = getCapabilitiesMock;
    createPlaylist = createPlaylistMock;
  },
}));

function playlist(id: string): YouTubePlaylistListItem {
  return { id, title: `Playlist ${id}`, privacy_status: "private", thumbnail_url: null };
}

function page(items: YouTubePlaylistListItem[], nextPageToken: string | null) {
  return {
    schema_version: 1 as const,
    request_id: "req-1",
    freshness: { fetched_at: "2026-11-27T10:00:00.000Z", source: "provider" as const },
    data: { items, next_page_token: nextPageToken },
  };
}

function capabilitiesEnvelope(capabilities: YouTubeAccountCapabilities["capabilities"]) {
  return {
    schema_version: 1 as const,
    request_id: "req-cap-1",
    freshness: { fetched_at: "2026-11-27T10:00:00.000Z", source: "provider" as const },
    data: {
      account_id: "acc-1",
      provider: "native" as const,
      granted_scopes: [],
      capabilities,
      quota: {
        read_per_minute: 30,
        browse_per_minute: 10,
        detail_per_minute: 20,
      },
    },
  };
}

function deferred() {
  let resolve!: (value: ReturnType<typeof page>) => void;
  const promise = new Promise<ReturnType<typeof page>>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  listPlaylistsMock.mockReset();
  getCapabilitiesMock.mockReset();
  createPlaylistMock.mockReset();
  getCapabilitiesMock.mockRejectedValue(new Error("unconfigured"));
});

describe("useYouTubePlaylists", () => {
  it("reads the playlists of the account's channel", async () => {
    listPlaylistsMock.mockResolvedValue(page([playlist("PL1")], null));

    const { result } = renderHook(() => useYouTubePlaylists("acc-1"));

    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL1"]));
    expect(listPlaylistsMock).toHaveBeenCalledWith({ accountId: "acc-1" });
    expect(result.current.hasMore).toBe(false);
    expect(result.current.unavailable).toBe(false);
  });

  it("never reads playlists without an account", async () => {
    const { result } = renderHook(() => useYouTubePlaylists(null));

    expect(listPlaylistsMock).not.toHaveBeenCalled();
    expect(result.current.playlists).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.unavailable).toBe(false);
  });

  it("asks for the next page with the cursor of the last page", async () => {
    listPlaylistsMock.mockImplementation(({ pageToken }: { pageToken?: string | null }) =>
      Promise.resolve(pageToken ? page([playlist("PL2")], null) : page([playlist("PL1")], "PAGE2")));

    const { result } = renderHook(() => useYouTubePlaylists("acc-1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => { result.current.loadMore(); });

    expect(listPlaylistsMock).toHaveBeenLastCalledWith({ accountId: "acc-1", pageToken: "PAGE2" });
    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL1", "PL2"]));
    expect(result.current.hasMore).toBe(false);
  });

  it("lists an item that arrives twice only once", async () => {
    listPlaylistsMock.mockImplementation(({ pageToken }: { pageToken?: string | null }) =>
      Promise.resolve(pageToken ? page([playlist("PL1")], null) : page([playlist("PL1")], "PAGE2")));

    const { result } = renderHook(() => useYouTubePlaylists("acc-1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => { result.current.loadMore(); });

    await waitFor(() => expect(result.current.playlists).toHaveLength(1));
  });

  it("keeps the loaded playlists when the next page cannot be read", async () => {
    listPlaylistsMock.mockImplementation(({ pageToken }: { pageToken?: string | null }) =>
      pageToken ? Promise.reject(new Error("provider refused")) : Promise.resolve(page([playlist("PL1")], "PAGE2")));

    const { result } = renderHook(() => useYouTubePlaylists("acc-1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => { result.current.loadMore(); });

    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL1"]);
  });

  it("retries the failed page instead of reading the list again", async () => {
    listPlaylistsMock.mockImplementation(({ pageToken }: { pageToken?: string | null }) =>
      pageToken ? Promise.reject(new Error("provider refused")) : Promise.resolve(page([playlist("PL1")], "PAGE2")));

    const { result } = renderHook(() => useYouTubePlaylists("acc-1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.unavailable).toBe(true));

    listPlaylistsMock.mockResolvedValue(page([playlist("PL2")], null));
    await act(async () => { result.current.retry(); });

    expect(listPlaylistsMock).toHaveBeenLastCalledWith({ accountId: "acc-1", pageToken: "PAGE2" });
    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL1", "PL2"]));
    expect(result.current.unavailable).toBe(false);
  });

  it("reads the list again when it never arrived", async () => {
    listPlaylistsMock.mockRejectedValue(new Error("provider refused"));

    const { result } = renderHook(() => useYouTubePlaylists("acc-1"));
    await waitFor(() => expect(result.current.unavailable).toBe(true));

    listPlaylistsMock.mockResolvedValue(page([playlist("PL1")], null));
    await act(async () => { result.current.retry(); });

    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL1"]));
    expect(listPlaylistsMock).toHaveBeenLastCalledWith({ accountId: "acc-1" });
  });

  it("drops the playlists of the previous account when the account changes", async () => {
    listPlaylistsMock.mockImplementation(({ accountId }: { accountId: string }) =>
      Promise.resolve(page([playlist(accountId === "acc-1" ? "PL1" : "PL9")], null)));

    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string | null }) => useYouTubePlaylists(accountId),
      { initialProps: { accountId: "acc-1" as string | null } },
    );
    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL1"]));

    rerender({ accountId: "acc-2" });

    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL9"]));
  });

  it("does not let a late page of the previous account fill the new account's list", async () => {
    const latePage = deferred();
    listPlaylistsMock.mockImplementation(({ accountId, pageToken }: { accountId: string; pageToken?: string | null }) => {
      if (accountId !== "acc-1") return Promise.resolve(page([playlist("PL9")], null));
      if (pageToken) return latePage.promise;
      return Promise.resolve(page([playlist("PL1")], "PAGE2"));
    });

    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string | null }) => useYouTubePlaylists(accountId),
      { initialProps: { accountId: "acc-1" as string | null } },
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    await act(async () => { result.current.loadMore(); });

    rerender({ accountId: "acc-2" });
    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL9"]));

    await act(async () => { latePage.resolve(page([playlist("PL2")], null)); });

    expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL9"]);
  });

  it("populates capabilities when getCapabilities resolves and resets to null when getCapabilities rejects", async () => {
    const sampleCapabilities: YouTubeAccountCapabilities["capabilities"] = {
      browse: { state: "available" },
      upload: { state: "available" },
      comments: { state: "available" },
      edit_metadata: { state: "available" },
      manage_thumbnail: { state: "available" },
      manage_captions: { state: "unavailable", reason: "missing_scope" },
    };
    listPlaylistsMock.mockResolvedValue(page([playlist("PL1")], null));
    getCapabilitiesMock.mockResolvedValueOnce(capabilitiesEnvelope(sampleCapabilities));

    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string | null }) => useYouTubePlaylists(accountId),
      { initialProps: { accountId: "acc-1" as string | null } },
    );

    await waitFor(() => expect(result.current.capabilities).toEqual(sampleCapabilities));
    expect(result.current.capabilitiesLoading).toBe(false);
    expect(result.current.capabilitiesUnavailable).toBe(false);
    expect(getCapabilitiesMock).toHaveBeenCalledWith("acc-1");

    getCapabilitiesMock.mockRejectedValueOnce(new Error("provider error"));
    rerender({ accountId: "acc-2" });

    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL1"]));
    await waitFor(() => expect(result.current.capabilitiesUnavailable).toBe(true));
    expect(result.current.capabilities).toBeNull();
    expect(result.current.capabilitiesLoading).toBe(false);

    getCapabilitiesMock.mockResolvedValueOnce(capabilitiesEnvelope(sampleCapabilities));
    await act(async () => { result.current.retry(); });
    await waitFor(() => expect(result.current.capabilities).toEqual(sampleCapabilities));
    expect(result.current.capabilitiesUnavailable).toBe(false);

    rerender({ accountId: null });
    expect(result.current.capabilities).toBeNull();
    expect(result.current.capabilitiesLoading).toBe(false);
    expect(result.current.capabilitiesUnavailable).toBe(false);
  });

  it("creates a playlist, refetches the playlist list, and returns the created playlist", async () => {
    const createdPlaylist = playlist("PL_NEW_12345");
    listPlaylistsMock
      .mockResolvedValueOnce(page([playlist("PL1")], null))
      .mockResolvedValueOnce(page([createdPlaylist, playlist("PL1")], null));
    createPlaylistMock.mockResolvedValueOnce({
      schema_version: 1 as const,
      request_id: "req-create-1",
      freshness: { fetched_at: "2026-11-27T10:00:00.000Z", source: "provider" as const },
      data: { playlist: createdPlaylist },
    });

    const { result } = renderHook(() => useYouTubePlaylists("acc-1"));
    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL1"]));

    let outcome: Awaited<ReturnType<typeof result.current.createPlaylist>> | undefined;
    await act(async () => {
      outcome = await result.current.createPlaylist({
        title: "Playlist PL_NEW_12345",
        description: "Created inline",
        privacyStatus: "private",
      });
    });

    expect(createPlaylistMock).toHaveBeenCalledWith({
      accountId: "acc-1",
      title: "Playlist PL_NEW_12345",
      description: "Created inline",
      privacyStatus: "private",
    });
    expect(outcome).toEqual({ outcome: "created", playlist: createdPlaylist });
    expect(listPlaylistsMock).toHaveBeenCalledTimes(2);
    expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL_NEW_12345", "PL1"]);
    expect(result.current.creating).toBe(false);
  });

  it("refetches the playlist list and returns outcome_unknown when createPlaylist loses the provider answer", async () => {
    listPlaylistsMock
      .mockResolvedValueOnce(page([playlist("PL1")], null))
      .mockResolvedValueOnce(page([playlist("PL_MAYBE"), playlist("PL1")], null));
    createPlaylistMock.mockRejectedValueOnce(new YouTubeResourceError("outcome_unknown"));

    const { result } = renderHook(() => useYouTubePlaylists("acc-1"));
    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL1"]));

    let outcome: Awaited<ReturnType<typeof result.current.createPlaylist>> | undefined;
    await act(async () => {
      outcome = await result.current.createPlaylist({
        title: "Playlist PL_MAYBE",
        privacyStatus: "unlisted",
      });
    });

    expect(outcome).toEqual({ outcome: "outcome_unknown" });
    expect(createPlaylistMock).toHaveBeenCalledTimes(1);
    expect(listPlaylistsMock).toHaveBeenCalledTimes(2);
    expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL_MAYBE", "PL1"]);
  });

  it("returns rate_limited with retryAfterSeconds without refetching when the daily cap is reached", async () => {
    listPlaylistsMock.mockResolvedValueOnce(page([playlist("PL1")], null));
    createPlaylistMock.mockRejectedValueOnce(new YouTubeResourceError("rate_limited", 1800));

    const { result } = renderHook(() => useYouTubePlaylists("acc-1"));
    await waitFor(() => expect(result.current.playlists.map((entry) => entry.id)).toEqual(["PL1"]));

    let outcome: Awaited<ReturnType<typeof result.current.createPlaylist>> | undefined;
    await act(async () => {
      outcome = await result.current.createPlaylist({
        title: "Sixth playlist",
        privacyStatus: "public",
      });
    });

    expect(outcome).toEqual({ outcome: "rate_limited", retryAfterSeconds: 1800 });
    expect(listPlaylistsMock).toHaveBeenCalledTimes(1);
  });
});
