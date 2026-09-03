import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const OLD_NATIVE = { id: "yt-old", platform: "youtube", platform_username: "Old Channel", platform_user_id: "UC-old", avatar_url: null, is_active: true, auth_provider: "native", account_metadata: {} };
const COMPOSIO = { id: "yt-cx", platform: "youtube", platform_username: "Composio Channel", platform_user_id: "UC-cx", avatar_url: null, is_active: true, auth_provider: "composio", account_metadata: {} };
// The panel picks the first account, so each test states which rows exist.
let accounts: Array<typeof OLD_NATIVE> = [];
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: accounts }),
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

describe("CommentManagerPanel for YouTube", () => {
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
});
