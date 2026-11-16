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
  accounts: [{ id: "account", platform: "instagram", platform_username: "test" }],
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "owner" }, profile: null }) }));
vi.mock("@/hooks/useSocialAccounts", () => ({ useSocialAccounts: () => ({ data: fixture.accounts, isLoading: false }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: fixture.toast }) }));
vi.mock("@/features/media-upload", () => ({ useMediaUploadLimits: () => ({}), uploadLargeMedia: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
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
  fixture.postMetadata = { selected_account_ids: ["account"] };
  fixture.accounts = [{ id: "account", platform: "instagram", platform_username: "test" }];
  fixture.toast.mockClear();
});

describe("saved post media", () => {
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
});
