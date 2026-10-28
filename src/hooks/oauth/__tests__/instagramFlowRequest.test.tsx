import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// The platform OAuth hooks are stubbed: this suite is about which flow-choice
// request useProfileOAuth raises, not about any provider's network calls.
const handleInstagramConnect = vi.fn();

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/oauth", () => ({
  useFacebookOAuth: () => ({
    pageSelectionData: null,
    selectingPage: null,
    handleFacebookConnect: vi.fn(),
    handleSelectPage: vi.fn(),
    handleSelectStandaloneInstagram: vi.fn(),
    clearPageSelection: vi.fn(),
    loadPendingFacebookSelection: vi.fn(),
  }),
  useInstagramOAuth: () => ({
    handleInstagramBusinessLogin: vi.fn(),
    handleInstagramBusinessCallback: vi.fn(),
    handleInstagramConnect,
    igSelectionData: null,
    selectingIg: null,
    connectedIgIds: [],
    loadPendingInstagramSelection: vi.fn(),
    handleSelectIgAccount: vi.fn(),
    clearIgSelection: vi.fn(),
  }),
  useTikTokOAuth: () => ({ handleTikTokConnect: vi.fn(), handleTikTokCallback: vi.fn() }),
  useYouTubeOAuth: () => ({ handleYouTubeConnect: vi.fn(), handleYouTubeCallback: vi.fn() }),
  usePinterestOAuth: () => ({ handlePinterestConnect: vi.fn() }),
  useLinkedInOAuth: () => ({ handleLinkedInConnect: vi.fn(), handleLinkedInCallback: vi.fn() }),
  useTwitterOAuth: () => ({ handleTwitterConnect: vi.fn(), handleTwitterCallback: vi.fn() }),
  useThreadsOAuth: () => ({ handleThreadsConnect: vi.fn(), handleThreadsCallback: vi.fn() }),
  useBlueskyOAuth: () => ({
    blueskyDialogData: null,
    handleBlueskyOAuthConnect: vi.fn(),
    handleBlueskyOAuthCallback: vi.fn(),
    handleBlueskyConnect: vi.fn(),
    clearBlueskyDialog: vi.fn(),
  }),
  useRedditOAuth: () => ({ handleRedditConnect: vi.fn(), handleRedditCallback: vi.fn() }),
  useOAuthRedirectHandler: () => ({
    instagramConfirmUsername: null,
    dismissInstagramConfirm: vi.fn(),
  }),
}));

import { useProfileOAuth } from "@/hooks/useProfileOAuth";

describe("Instagram flow-choice request", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reconnecting Instagram raises the flow-choice request with the target account", async () => {
    // Regression: this used to return early with only a toast, so the red
    // Reconnect button appeared to do nothing and no dialog ever opened.
    //
    // The explicit intent travels with the request. The backend captures it
    // before the provider is contacted, so the reconnect must still name the
    // owned account it targets once the user picks a login method.
    const { result } = renderHook(() => useProfileOAuth());

    await act(async () => {
      await result.current.handleReconnectPlatform("profile-1", "instagram", "account-9");
    });

    expect(result.current.instagramFlowRequest).toEqual({
      profileId: "profile-1",
      options: { mode: "reconnect", socialAccountId: "account-9" },
    });
    expect(handleInstagramConnect).not.toHaveBeenCalled();
  });

  it("connecting Instagram raises the same request without a target", async () => {
    const { result } = renderHook(() => useProfileOAuth());

    await act(async () => {
      await result.current.handleConnectPlatform("profile-2", "instagram");
    });

    expect(result.current.instagramFlowRequest).toEqual({
      profileId: "profile-2",
      options: {},
    });
  });

  it("choosing a flow starts that connect with the preserved options", async () => {
    const { result } = renderHook(() => useProfileOAuth());

    await act(async () => {
      await result.current.handleReconnectPlatform("profile-1", "instagram", "account-9");
    });
    await act(async () => {
      await result.current.selectInstagramFlow("direct");
    });

    expect(handleInstagramConnect).toHaveBeenCalledWith("profile-1", "direct", {
      mode: "reconnect",
      socialAccountId: "account-9",
    });
    expect(result.current.instagramFlowRequest).toBeNull();
  });

  it("dismissing the dialog clears the request without connecting", async () => {
    const { result } = renderHook(() => useProfileOAuth());

    await act(async () => {
      await result.current.handleConnectPlatform("profile-2", "instagram");
    });
    act(() => result.current.clearInstagramFlowRequest());

    expect(result.current.instagramFlowRequest).toBeNull();
    expect(handleInstagramConnect).not.toHaveBeenCalled();
  });

  it("leaves the connecting spinner cleared while the dialog is open", async () => {
    // The dialog is a user decision point, not an in-flight connection: leaving
    // connectingPlatform set would disable the very buttons in the dialog.
    const { result } = renderHook(() => useProfileOAuth());

    await act(async () => {
      await result.current.handleReconnectPlatform("profile-1", "instagram", "account-9");
    });

    expect(result.current.connectingPlatform).toBeNull();
  });
});
