import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageSelectionDialog } from "@/components/profiles/PageSelectionDialog";
import { useOAuthRedirectHandler } from "../useOAuthRedirectHandler";
import { useFacebookOAuth } from "../useFacebookOAuth";
import { useInstagramOAuth } from "../useInstagramOAuth";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: vi.fn(),
  linkAccountToProfile: vi.fn(),
  searchParams: new URLSearchParams(),
  setSearchParams: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: mocks.invoke } },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ refetchQueries: vi.fn() }),
}));

vi.mock("../oauthUtils", () => ({
  refetchSocialQueries: vi.fn(),
  linkAccountToProfile: mocks.linkAccountToProfile,
}));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [mocks.searchParams, mocks.setSearchParams],
}));

const redirectHandlers = {
  handleTikTokCallback: vi.fn(async () => undefined),
  handleYouTubeCallback: vi.fn(async () => undefined),
  handleLinkedInCallback: vi.fn(async () => undefined),
  handleTwitterCallback: vi.fn(async () => undefined),
  handleThreadsCallback: vi.fn(async () => undefined),
  handleRedditCallback: vi.fn(async () => undefined),
  handleInstagramBusinessCallback: vi.fn(async () => undefined),
  handleBlueskyOAuthCallback: vi.fn(async () => undefined),
};

function pendingPages(attemptId: string | null) {
  return {
    data: {
      success: true,
      pages: [
        { id: "page-1", name: "Shop", selection_key: "k1" },
        { id: "page-2", name: "Other", selection_key: "k2" },
      ],
      standalone_instagram: [],
      social_profile_id: "profile-1",
      target_platform: "facebook",
      attempt_id: attemptId,
      committed_selection_keys: [],
    },
    error: null,
  };
}

describe("protected page selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.searchParams = new URLSearchParams();
  });

  it("sends page_id on the legacy path", async () => {
    mocks.invoke.mockResolvedValueOnce(pendingPages(null));
    mocks.invoke.mockResolvedValueOnce({
      data: { success: true, page_name: "Shop", has_instagram: false },
      error: null,
    });
    const { result } = renderHook(() => useFacebookOAuth(vi.fn(), vi.fn()));
    await act(async () => {
      await result.current.loadPendingFacebookSelection("sel-1");
    });
    await act(async () => {
      await result.current.handleSelectPage("page-1");
    });
    const body = mocks.invoke.mock.calls[1][1].body;
    expect(body.page_id).toBe("page-1");
    expect(body.selection_id).toBe("sel-1");
    expect(body.selection_key).toBeUndefined();
    expect(body.attempt_id).toBeUndefined();
    expect(mocks.linkAccountToProfile).toHaveBeenCalledTimes(1);
    expect(result.current.pageSelectionData).toBeNull();
  });

  it("sends only the attempt id and selection key on the protected path", async () => {
    mocks.invoke.mockResolvedValueOnce(pendingPages("attempt-1"));
    mocks.invoke.mockResolvedValueOnce({
      data: { success: true, page_name: "Shop", has_instagram: false, subscription: { status: "asserted" } },
      error: null,
    });
    const { result } = renderHook(() => useFacebookOAuth(vi.fn(), vi.fn()));
    await act(async () => {
      await result.current.loadPendingFacebookSelection("sel-1");
    });
    await act(async () => {
      await result.current.handleSelectPage("page-1", "k1");
    });
    const body = mocks.invoke.mock.calls[1][1].body;
    expect(body).toMatchObject({
      action: "store_page",
      attempt_id: "attempt-1",
      selection_key: "k1",
    });
    expect(body.page_id).toBeUndefined();
    expect(body.selection_id).toBeUndefined();
    expect(mocks.linkAccountToProfile).not.toHaveBeenCalled();
    expect(result.current.pageSelectionData?.committedSelectionKeys).toEqual(["k1"]);
    expect(result.current.pageSelectionData?.pages).toHaveLength(2);
  });

  it("keeps the picker after a protected error and ignores a second click", async () => {
    mocks.invoke.mockResolvedValueOnce(pendingPages("attempt-1"));
    let release: (value: unknown) => void = () => undefined;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { result } = renderHook(() => useFacebookOAuth(vi.fn(), vi.fn()));
    await act(async () => {
      await result.current.loadPendingFacebookSelection("sel-1");
    });
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.handleSelectPage("page-1", "k1");
      second = result.current.handleSelectPage("page-2", "k2");
    });
    const storeCalls = mocks.invoke.mock.calls.filter((call) => call[1].body.action === "store_page");
    expect(storeCalls).toHaveLength(1);
    await act(async () => {
      release({ error: new Error("nope") });
      await first;
      await second;
    });
    expect(result.current.pageSelectionData?.pages).toHaveLength(2);
    expect(result.current.selectingPage).toBeNull();
    expect(mocks.linkAccountToProfile).not.toHaveBeenCalled();
  });

  it("warns when the subscription failed and still keeps the connection", async () => {
    mocks.invoke.mockResolvedValueOnce(pendingPages("attempt-1"));
    mocks.invoke.mockResolvedValueOnce({
      data: {
        success: true,
        page_name: "Shop",
        has_instagram: false,
        subscription: { status: "failed", warning: "provider said SECRET" },
      },
      error: null,
    });
    const { result } = renderHook(() => useFacebookOAuth(vi.fn(), vi.fn()));
    await act(async () => {
      await result.current.loadPendingFacebookSelection("sel-1");
    });
    await act(async () => {
      await result.current.handleSelectPage("page-1", "k1");
    });
    const toast = mocks.toast.mock.calls.at(-1)?.[0];
    expect(toast.title).toBe("Facebook Page connected!");
    expect(toast.description).toContain("webhook subscription could not be confirmed");
    expect(toast.description).not.toContain("SECRET");
  });

  it("omits the pending id from a protected Instagram selection", async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        success: true,
        social_profile_id: "profile-1",
        attempt_id: "attempt-1",
        committed_selection_keys: [],
        ig_accounts: [
          { ig_user_id: "ig-1", ig_username: "shop", ig_profile_picture_url: null, facebook_page_name: "Shop", selection_key: "ig-key" },
        ],
      },
      error: null,
    });
    mocks.invoke.mockResolvedValueOnce({
      data: { success: true, ig_username: "shop", subscription: { status: "skipped" } },
      error: null,
    });
    const { result } = renderHook(() => useInstagramOAuth(vi.fn(), vi.fn(), vi.fn()));
    await act(async () => {
      await result.current.loadPendingInstagramSelection("sel-1");
    });
    await act(async () => {
      await result.current.handleSelectIgAccount("ig-1", "ig-key");
    });
    const body = mocks.invoke.mock.calls[1][1].body;
    expect(body).toMatchObject({
      action: "store_ig_account",
      attempt_id: "attempt-1",
      selection_key: "ig-key",
    });
    expect(body.selection_id).toBeUndefined();
    expect(body.ig_user_id).toBeUndefined();
    expect(result.current.igSelectionData).toBeNull();
  });

  it("disables a page whose selection key is already committed", () => {
    render(
      <PageSelectionDialog
        open
        onOpenChange={vi.fn()}
        pages={[
          { id: "page-1", name: "Shop", selection_key: "k1" },
          { id: "page-2", name: "Other", selection_key: "k2" },
        ]}
        pageSearchQuery=""
        onPageSearchChange={vi.fn()}
        onSelectPage={vi.fn()}
        selectingPage={null}
        committedSelectionKeys={["k1"]}
      />,
    );
    expect(screen.getByRole("button", { name: /Shop/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Other/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Shop/ }));
  });

  it("adds the sanitized subscription warning and ignores any other warning", () => {
    mocks.searchParams.set("connected", "instagram");
    mocks.searchParams.set("username", "shop");
    mocks.searchParams.set("warning", "subscription_unconfirmed");
    renderHook(() => useOAuthRedirectHandler(redirectHandlers));
    const shown = mocks.toast.mock.calls.at(-1)?.[0];
    expect(shown.description).toContain("Connected account: @shop");
    expect(shown.description).toContain("webhook subscription could not be confirmed");

    sessionStorage.clear();
    mocks.toast.mockClear();
    mocks.searchParams = new URLSearchParams("connected=instagram&username=shop&warning=provider+said+SECRET");
    renderHook(() => useOAuthRedirectHandler(redirectHandlers));
    const plain = mocks.toast.mock.calls.at(-1)?.[0];
    expect(plain.description).toBe("Connected account: @shop");
    expect(plain.description).not.toContain("SECRET");
  });
});
