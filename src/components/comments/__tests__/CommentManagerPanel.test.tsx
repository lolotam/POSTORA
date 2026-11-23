import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const OLD_NATIVE = { id: "yt-old", platform: "youtube", platform_username: "Old Channel", platform_user_id: "UC-old", avatar_url: null, is_active: true, auth_provider: "native", account_metadata: {} };
const COMPOSIO = { id: "yt-cx", platform: "youtube", platform_username: "Composio Channel", platform_user_id: "UC-cx", avatar_url: null, is_active: true, auth_provider: "composio", account_metadata: {} };
// The panel picks the first account, so each test states which rows exist.
let accounts: Array<typeof OLD_NATIVE> = [];
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: accounts }),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "11111111-1111-4111-8111-111111111111" } } }),
}));
// The Stage 4 admission is "legacy" unless a test flips it: the baseline
// inbox and the other platforms must stay exactly as they were.
let stage4Admission: "loading" | "admitted" | "legacy" = "legacy";
vi.mock("@/features/youtube-comments/application/useYouTubeStage4Admission", () => ({
  useYouTubeStage4Admission: () => stage4Admission,
}));
const useComments = vi.fn((_opts: unknown) => ({ data: [], isLoading: false, error: null, refetch: vi.fn(), isFetching: false }));
// The comment list under the panel binds the mutation hooks from the same module, so they are
// stubbed too — a factory that omits them fails before any render, and the real ones would
// demand a QueryClient this test has no reason to set up.
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

describe("CommentManagerPanel for YouTube", () => {
  beforeEach(() => {
    stage4Admission = "legacy";
  });
  // The four native channels in production connected before force-ssl was requested. Loading
  // them would 403; the banner names the fix and the query is not even started.
  it("shows the reconnect banner for a channel without the comments scope and does not query", () => {
    accounts = [OLD_NATIVE, COMPOSIO];
    render(<CommentManagerPanel platform="youtube" />);
    expect(screen.getByText(/Reconnect this channel on Profiles to enable comments/)).toBeInTheDocument();
    expect(useComments).toHaveBeenLastCalledWith(
      expect.objectContaining({ platform: "youtube", socialAccountId: "yt-old", enabled: false }),
    );
  });

  // While Stage 4 admission is still being decided the panel shows a spinner; a
  // legacy provider read then would spend quota (and can drop a stored grant)
  // for a channel that is about to be admitted.
  it("starts no legacy query for a native channel while its admission is loading", () => {
    accounts = [{ ...OLD_NATIVE, account_metadata: { granted_scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"] } }];
    stage4Admission = "loading";
    render(<CommentManagerPanel platform="youtube" />);
    expect(useComments).toHaveBeenLastCalledWith(expect.objectContaining({ socialAccountId: "yt-old", enabled: false }));
    stage4Admission = "legacy";
    render(<CommentManagerPanel platform="youtube" />);
    expect(useComments).toHaveBeenLastCalledWith(expect.objectContaining({ socialAccountId: "yt-old", enabled: true }));
  });

  // Composio's Google app already holds the comments scope, so a Composio channel needs no
  // reconnect: the query runs, and the row says which provider it came through.
  it("queries a Composio channel straight away and labels it", () => {
    accounts = [COMPOSIO];
    render(<CommentManagerPanel platform="youtube" />);
    expect(screen.queryByText(/Reconnect this channel/)).not.toBeInTheDocument();
    expect(screen.getByText("Composio")).toBeInTheDocument();
    expect(useComments).toHaveBeenLastCalledWith(
      expect.objectContaining({ platform: "youtube", socialAccountId: "yt-cx", enabled: true }),
    );
  });

  // A pending receipt is read by exactly ONE surface. While the admission answer is still
  // loading, the legacy recovery surface must not read (and clear) it: the admitted screen
  // would then find nothing left to show, and the owner would never see the outcome.
  describe("pending receipt recovery", () => {
    const USER_ID = "11111111-1111-4111-8111-111111111111";
    const KEY = `postora:yt-stage4:ops:${USER_ID}`;
    const confirmed = {
      operation_id: "op-pending", action: "create_thread", state: "confirmed", reason: null, provider_class: null,
      moderation_status: null, ban_requested: false, result_thread_id: null, result_comment_id: null,
      binding_generation: 1, channel_id: "UC-cx", observation: null, observed_text: null,
    } as const;

    beforeEach(() => {
      localStorage.clear();
      localStorage.setItem(KEY, JSON.stringify([{
        operationId: "op-pending", accountId: "yt-cx", videoId: "vid-1", action: "create_thread",
        targetCommentId: "", createdAt: Date.now(),
      }]));
    });

    it("does not read or clear the pending identity while the admission is still loading", async () => {
      accounts = [COMPOSIO];
      stage4Admission = "loading";
      const status = vi.spyOn(defaultYouTubeCommentsGateway, "operationStatus").mockResolvedValue(confirmed as never);
      render(<CommentManagerPanel platform="youtube" />);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(status).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toHaveLength(1);
      status.mockRestore();
    });

    it("reads it once the answer is final and the channel is not admitted", async () => {
      accounts = [COMPOSIO];
      stage4Admission = "legacy";
      const status = vi.spyOn(defaultYouTubeCommentsGateway, "operationStatus").mockResolvedValue(confirmed as never);
      render(<CommentManagerPanel platform="youtube" />);
      expect(await screen.findByTestId("yt-stage4-recovered-standalone")).toHaveTextContent(/accepted by YouTube/);
      expect(status).toHaveBeenCalledTimes(1);
      status.mockRestore();
    });
  });
});
