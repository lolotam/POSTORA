import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { usePostForm } from "../usePostForm";

const fixture = vi.hoisted(() => ({
  mediaError: null as { message: string } | null,
  mediaIds: ["second", "first"] as string[],
  mediaRows: [
    { id: "first", file_type: "image", file_path: "https://images.example/first.png" },
    { id: "second", file_type: "image", file_path: "https://images.example/second.png" },
  ] as Array<Record<string, unknown>>,
  caption: "Saved caption" as string | null,
  scheduledAt: null as string | null,
  postReads: 0,
  postMetadata: { selected_account_ids: ["account"] } as Record<string, unknown>,
  toast: vi.fn(),
  invoke: vi.fn(),
  profile: null as { preferred_timezone: string } | null,
  accounts: [{ id: "account", platform: "instagram", platform_username: "test" }],
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "owner" }, profile: fixture.profile }) }));
vi.mock("@/hooks/useSocialAccounts", () => ({ useSocialAccounts: () => ({ data: fixture.accounts, isLoading: false }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: fixture.toast }) }));
vi.mock("@/features/media-upload", () => ({ useMediaUploadLimits: () => ({}), uploadLargeMedia: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: fixture.invoke },
    from: (table: string) => ({ select: () => table === "posts" ? {
      eq: () => ({ single: async () => {
        fixture.postReads++;
        return { data: {
          caption: fixture.caption, media_file_ids: fixture.mediaIds, scheduled_at: fixture.scheduledAt,
          metadata: fixture.postMetadata,
        }, error: null };
      } }),
    } : {
      in: async () => ({ data: fixture.mediaError ? null : fixture.mediaRows, error: fixture.mediaError }),
    } }),
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={["/post?edit=saved-post"]}>{children}</MemoryRouter>;
}
beforeEach(() => {
  sessionStorage.clear();
  fixture.mediaError = null;
  fixture.mediaIds = ["second", "first"];
  fixture.mediaRows = [
    { id: "first", file_type: "image", file_path: "https://images.example/first.png" },
    { id: "second", file_type: "image", file_path: "https://images.example/second.png" },
  ];
  fixture.caption = "Saved caption";
  fixture.scheduledAt = null;
  fixture.postReads = 0;
  fixture.profile = null;
  fixture.postMetadata = { selected_account_ids: ["account"] };
  fixture.accounts = [{ id: "account", platform: "instagram", platform_username: "test" }];
  fixture.toast.mockClear();
  fixture.invoke.mockReset();
});

describe("saved post media", () => {
  it("defers a late profile timezone during submission and applies it when the form becomes editable again", () => {
    const plainWrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={["/post"]}>{children}</MemoryRouter>;
    const { result, rerender } = renderHook(() => usePostForm(), { wrapper: plainWrapper });
    act(() => result.current.setCaption("Keep after failed submission"));
    act(() => result.current.setIsPosting(true));
    fixture.profile = { preferred_timezone: "Asia/Kuwait" };
    rerender();
    expect(result.current.scheduleTimezone).toBe("");
    act(() => result.current.setIsPosting(false));
    expect(result.current.scheduleTimezone).toBe("Asia/Kuwait");
    expect(JSON.parse(sessionStorage.getItem("postora_post_draft")!).caption).toBe("Keep after failed submission");
  });

  it.each(["new revision", "new composer"])("preserves an identical newer draft from a %s and clears only its captured version", (replacement) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 16));
    const plainWrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={["/post"]}>{children}</MemoryRouter>;
    try {
      const first = renderHook(() => usePostForm(), { wrapper: plainWrapper });
      act(() => first.result.current.setCaption("Identical caption"));
      const clearFirst = first.result.current.captureDraftCleanup();
      let latest = first;
      if (replacement === "new composer") {
        first.unmount();
        latest = renderHook(() => usePostForm(), { wrapper: plainWrapper });
      } else {
        act(() => first.result.current.setCaption("Temporary edit"));
        act(() => first.result.current.setCaption("Identical caption"));
      }
      expect(latest.result.current.caption).toBe("Identical caption");
      clearFirst();
      expect(JSON.parse(sessionStorage.getItem("postora_post_draft")!).caption).toBe("Identical caption");
      const clearLatest = latest.result.current.captureDraftCleanup();
      latest.unmount();
      clearLatest();
      expect(sessionStorage.getItem("postora_post_draft")).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("restores publishing order from the canonical saved sequence", async () => {
    const { result } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(result.current.files).toHaveLength(2));
    expect(result.current.files.map(file => file.storagePath)).toEqual(["second", "first"]);
    expect(result.current.caption).toBe("Saved caption");
  });

  it("reports a failed media read instead of treating it as a successful empty edit", async () => {
    fixture.mediaError = { message: "database unavailable" };
    const { result } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(fixture.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Error", variant: "destructive" })));
    expect(result.current.isLoadingEditPost).toBe(false);
    expect(fixture.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Post loaded" }));
  });

  it("keeps repeated stored IDs as independent ordered occurrences", async () => {
    fixture.mediaIds = ["first", "second", "first"];
    fixture.mediaRows = [fixture.mediaRows[1], { id: "unrelated" }, fixture.mediaRows[0]];
    const { result } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(result.current.editStatus).toBe("ready"));
    expect(result.current.files.map((file) => file.storagePath)).toEqual(fixture.mediaIds);
    expect(new Set(result.current.files.map((file) => file.id)).size).toBe(3);
  });

  it("blocks an incomplete edit instead of silently deleting missing attachments", async () => {
    fixture.mediaRows = [fixture.mediaRows[0]];
    const { result } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(result.current.editStatus).toBe("error"));
    expect(result.current.editLoadError).toMatch(/1 media item.*missing/i);
    expect(result.current.files).toEqual([]);
    expect(result.current.caption).toBe("");
    expect(result.current.validatePost()).toBe(false);
  });

  it("treats legitimately empty media and caption as a complete edit snapshot", async () => {
    fixture.mediaIds = [];
    fixture.caption = null;
    const { result } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(result.current.editStatus).toBe("ready"));
    expect(result.current.files).toEqual([]);
    expect(result.current.caption).toBe("");
    expect(result.current.scheduleEnabled).toBe(false);
  });

  it("stays editable and hydrates after a StrictMode effect replay", async () => {
    const { result } = renderHook(() => usePostForm(), {
      wrapper: ({ children }) => <StrictMode><MemoryRouter initialEntries={["/post?edit=saved-post"]}>{children}</MemoryRouter></StrictMode>,
    });
    await waitFor(() => expect(result.current.editStatus).toBe("ready"));
    expect(result.current.files.map((file) => file.storagePath)).toEqual(["second", "first"]);
    act(() => result.current.setCaption("StrictMode edit"));
    expect(result.current.caption).toBe("StrictMode edit");
    act(() => result.current.setFiles((current) => current.slice(0, 1)));
    expect(result.current.files).toHaveLength(1);
  });

  it.each([
    [{ schedule_timezone: "Asia/Kuwait", timezone: "UTC" }, "Asia/Kuwait"],
    [{ timezone: "Africa/Cairo" }, "Africa/Cairo"],
  ])("restores the saved timezone with canonical-first fallback: %j", async (timezoneMetadata, expectedTimezone) => {
    fixture.postMetadata = { selected_account_ids: ["account"], ...timezoneMetadata };
    const { result } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(result.current.editStatus).toBe("ready"));
    expect(result.current.scheduleTimezone).toBe(expectedTimezone);
  });

  it("derives platforms when accounts arrive after hydration without reloading the edit", async () => {
    fixture.accounts = [];
    const { result, rerender } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(result.current.editStatus).toBe("ready"));
    expect(result.current.selectedAccountIds).toEqual(["account"]);
    expect(result.current.selectedPlatforms).toEqual([]);
    act(() => result.current.setCaption("Keep user edit"));
    fixture.accounts = [{ id: "account", platform: "instagram", platform_username: "test" }];
    rerender();
    await waitFor(() => expect(result.current.selectedPlatforms).toEqual(["instagram"]));
    expect(result.current.caption).toBe("Keep user edit");
    expect(fixture.postReads).toBe(1);
  });

  it("does not reload an edit over user changes when the account list refreshes", async () => {
    const { result, rerender } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(result.current.editStatus).toBe("ready"));
    act(() => result.current.setCaption("User edit"));
    fixture.accounts = [...fixture.accounts, { id: "other", platform: "facebook", platform_username: "other" }];
    rerender();
    expect(result.current.caption).toBe("User edit");
    expect(fixture.postReads).toBe(1);
  });

  it("retains user edits when profile preferences and notification callbacks refresh", async () => {
    fixture.profile = { preferred_timezone: "Asia/Kuwait" };
    const { result, rerender } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(result.current.editStatus).toBe("ready"));
    act(() => result.current.setCaption("Keep my edited caption"));
    fixture.profile = { preferred_timezone: "Africa/Cairo" };
    fixture.toast = vi.fn();
    rerender();
    expect(result.current.caption).toBe("Keep my edited caption");
    expect(result.current.scheduleTimezone).toBe("Asia/Kuwait");
    expect(fixture.postReads).toBe(1);
    expect(fixture.toast).not.toHaveBeenCalled();
  });

  it("does not restore an asset without a persisted media ID as uploaded", async () => {
    sessionStorage.setItem("postora_post_draft", JSON.stringify({
      caption: "Incomplete", selectedAccountIds: [], scheduledAt: null, scheduleEnabled: false,
      scheduleTimezone: "UTC", uploadMethod: "local", savedAt: Date.now(),
      fileMetadata: [{ id: "pending", previewUrl: "blob:pending", fileType: "image" }],
    }));
    const { result } = renderHook(() => usePostForm(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={["/post"]}>{children}</MemoryRouter>,
    });
    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0].uploaded).toBe(false);
    expect(result.current.files[0].storagePath).toBeUndefined();
    expect(result.current.validatePost()).toBe(false);
  });

  it("keeps an interrupted replacement incomplete across a draft reload despite its old saved ID", () => {
    sessionStorage.setItem("postora_post_draft", JSON.stringify({
      caption: "Keep caption", selectedAccountIds: ["account"], savedAt: Date.now(),
      fileMetadata: [{ id: "replacement", previewUrl: "blob:replacement", fileType: "image",
        storagePath: "old-original", cloudinaryUrl: "https://images.example/original.png", uploaded: false }],
    }));
    const { result, unmount } = renderHook(() => usePostForm(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={["/post"]}>{children}</MemoryRouter>,
    });
    expect(result.current.files[0].uploaded).toBe(false);
    expect(result.current.files[0].storagePath).toBeUndefined();
    expect(result.current.validatePost()).toBe(false);
    const persisted = JSON.parse(sessionStorage.getItem("postora_post_draft")!);
    expect(persisted.fileMetadata[0].uploaded).toBe(false);
    unmount();
    const restored = renderHook(() => usePostForm(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={["/post"]}>{children}</MemoryRouter>,
    });
    expect(restored.result.current.files[0].uploaded).toBe(false);
    expect(restored.result.current.caption).toBe("Keep caption");
  });

  it("retains a failed local upload until the user explicitly removes it", async () => {
    fixture.invoke.mockResolvedValue({ data: null, error: { message: "upload unavailable" } });
    const { result } = renderHook(() => usePostForm(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={["/post"]}>{children}</MemoryRouter>,
    });
    const failed = { id: "failed", file: new File(["image"], "failed.png", { type: "image/png" }),
      previewUrl: "https://images.example/failed.png", fileType: "image" as const, uploaded: false, uploadProgress: 0 };
    act(() => {
      result.current.setSelectedAccountIds(["account"]);
      result.current.setFiles([
        { ...failed, id: "good", uploaded: true, storagePath: "saved-good" }, failed,
      ]);
    });
    await act(async () => { await result.current.uploadFileToStorage(failed); });
    expect(result.current.files.map(file => file.id)).toEqual(["good", "failed"]);
    expect(result.current.files[1].uploadError).toBe("upload unavailable");
    expect(result.current.validatePost()).toBe(false);
    await act(async () => { await result.current.removeFile("failed"); });
    expect(result.current.files.map(file => file.storagePath)).toEqual(["saved-good"]);
    expect(result.current.validatePost()).toBe(true);
  });
});
