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
// The production gateway runs on a mocked transport, so the test sees what the browser really receives
// for each kind of failure: no body at all, a body naming the settings, a body naming something else.
const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } } }));
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

/** A non-2xx answer as supabase-js delivers it: the handler's own body sits in the Response of `context`. */
function httpError(reason: string, status = 503) {
  return {
    data: null,
    error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
      context: new Response(JSON.stringify({ ok: false, reason }), { status }),
    }),
  };
}

const NOT_ALLOWED = {
  account_id: "yt-native",
  capabilities: {
    read: { allowed: false, reason: "capability_off" }, held: { allowed: false, reason: "capability_off" },
    write: { allowed: false, reason: "capability_off" }, ban: { allowed: false, reason: "capability_off" },
  },
};

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
    invoke.mockReset();
  });

  it("T2.1a shows the baseline inbox when the very first read fails on the network with no body at all", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("Failed to send a request to the Edge Function") });
    renderPanel();
    await waitFor(() => expect(useComments).toHaveBeenLastCalledWith(expect.objectContaining({ socialAccountId: "yt-native", enabled: true })));
    expect(screen.queryByTestId("yt-stage4-admission-unavailable")).not.toBeInTheDocument();
  });

  it("T2.1b shows the retry card only for a 503 that names the settings, and retrying asks again", async () => {
    invoke.mockResolvedValueOnce(httpError("settings_unavailable"));
    renderPanel();
    await screen.findByTestId("yt-stage4-admission-unavailable");
    expect(useComments).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));

    invoke.mockResolvedValueOnce({ data: { ok: true, data: NOT_ALLOWED }, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("yt-stage4-admission-unavailable")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("T2.1c reads a 503 upstream (an old backend, or a failed lookup) as the baseline inbox", async () => {
    invoke.mockResolvedValue(httpError("upstream"));
    renderPanel();
    await waitFor(() => expect(useComments).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true })));
    expect(screen.queryByTestId("yt-stage4-admission-unavailable")).not.toBeInTheDocument();
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
