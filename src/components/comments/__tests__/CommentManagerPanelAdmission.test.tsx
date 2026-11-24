import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

// The REAL admission hook runs here (the sibling test file replaces it): what is under test is what the
// owner sees in the inbox when the very first settings read fails.
const NATIVE = {
  id: "yt-native", platform: "youtube", platform_username: "Native Channel", platform_user_id: "UC-native",
  avatar_url: null, is_active: true, auth_provider: "native",
  account_metadata: { granted_scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"] },
};
vi.mock("@/hooks/useSocialAccounts", () => ({ useSocialAccounts: () => ({ data: [NATIVE] }) }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "11111111-1111-4111-8111-111111111111" } } }),
}));
const useComments = vi.fn((_opts: unknown) => ({ data: [], isLoading: false, error: null, refetch: vi.fn(), isFetching: false }));
vi.mock("@/hooks/useCommentInbox", () => {
  const idleMutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useComments: (opts: unknown) => useComments(opts),
    useReplyComment: idleMutation,
    useHideComment: idleMutation,
    useDeleteComment: idleMutation,
  };
});
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import { CommentManagerPanel } from "../CommentManagerPanel";
import { defaultYouTubeCommentsGateway } from "@/features/youtube-comments";
import { YouTubeCommentsError } from "@/features/youtube-comments/domain/errors";

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CommentManagerPanel platform="youtube" />
    </QueryClientProvider>,
  );
}

describe("CommentManagerPanel when the first settings read fails", () => {
  beforeEach(() => {
    localStorage.clear();
    useComments.mockClear();
  });

  it("shows a retryable error state at the panel, never the baseline inbox, and starts no baseline read", async () => {
    const capabilities = vi.spyOn(defaultYouTubeCommentsGateway, "capabilities")
      .mockRejectedValueOnce(new YouTubeCommentsError("upstream"));
    renderPanel();
    const state = await screen.findByTestId("yt-stage4-admission-unavailable");
    expect(state).toHaveTextContent("Postora could not read its settings");
    expect(useComments).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));

    // Retrying asks the server again; a definite "not allowed" answer then lands on the baseline inbox.
    capabilities.mockResolvedValueOnce({
      account_id: "yt-native",
      capabilities: {
        read: { allowed: false, reason: "capability_off" }, held: { allowed: false, reason: "capability_off" },
        write: { allowed: false, reason: "capability_off" }, ban: { allowed: false, reason: "capability_off" },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("yt-stage4-admission-unavailable")).not.toBeInTheDocument());
    expect(useComments).toHaveBeenLastCalledWith(expect.objectContaining({ socialAccountId: "yt-native", enabled: true }));
    expect(capabilities).toHaveBeenCalledTimes(2);
    capabilities.mockRestore();
  });

  it("keeps the baseline inbox for a failure that is not a settings read (an old backend)", async () => {
    const capabilities = vi.spyOn(defaultYouTubeCommentsGateway, "capabilities")
      .mockRejectedValueOnce(new YouTubeCommentsError("not_found", "Unknown action"));
    renderPanel();
    await waitFor(() => expect(useComments).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true })));
    expect(screen.queryByTestId("yt-stage4-admission-unavailable")).not.toBeInTheDocument();
    capabilities.mockRestore();
  });
});
