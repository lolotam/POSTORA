import type { ReactNode } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { usePostForm } from "../usePostForm";

const fixture = vi.hoisted(() => ({
  mediaError: null as { message: string } | null,
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
      eq: () => ({ single: async () => ({ data: {
        caption: "Saved caption", media_file_ids: ["second", "first"],
        metadata: { selected_account_ids: ["account"] },
      }, error: null }) }),
    } : {
      in: async () => ({ data: fixture.mediaError ? null : [
        { id: "first", file_type: "image", file_path: "https://images.example/first.png" },
        { id: "second", file_type: "image", file_path: "https://images.example/second.png" },
      ], error: fixture.mediaError }),
    } }),
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={["/post?edit=saved-post"]}>{children}</MemoryRouter>;
}
beforeEach(() => {
  sessionStorage.clear();
  fixture.mediaError = null;
  fixture.toast.mockClear();
});

describe("saved post media", () => {
  it("restores publishing order and a new post clears the old edit target and content", async () => {
    const { result } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(result.current.files).toHaveLength(2));
    expect(result.current.files.map(file => file.storagePath)).toEqual(["second", "first"]);
    expect(result.current.caption).toBe("Saved caption");
    act(() => result.current.startNewPost());
    await waitFor(() => expect(result.current.editPostId).toBeNull());
    expect(result.current.files).toEqual([]);
    expect(result.current.caption).toBe("");
    expect(result.current.selectedAccountIds).toEqual([]);
    expect(result.current.scheduleEnabled).toBe(false);
  });

  it("reports a failed media read instead of treating it as a successful empty edit", async () => {
    fixture.mediaError = { message: "database unavailable" };
    const { result } = renderHook(() => usePostForm(), { wrapper });
    await waitFor(() => expect(fixture.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Error", variant: "destructive" })));
    expect(result.current.isLoadingEditPost).toBe(false);
    expect(fixture.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Post loaded" }));
  });
});
