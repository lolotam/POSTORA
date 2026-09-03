import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestYouTubeConnection,
  YouTubeConnectMethodDialog,
} from "../YouTubeConnectMethodDialog";

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const openTab = vi.fn();

describe("YouTubeConnectMethodDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv("VITE_COMPOSIO_YOUTUBE_ENABLED", "true");
    openTab.mockReset().mockReturnValue(null);
    vi.stubGlobal("open", openTab);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts native immediately when the Composio feature is off", () => {
    const native = vi.fn();
    const showDialog = vi.fn();
    render(
      <button
        onClick={() => requestYouTubeConnection(false, native, showDialog)}
      >
        Connect
      </button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(native).toHaveBeenCalledOnce();
    expect(showDialog).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Choose how to connect YouTube"),
    ).not.toBeInTheDocument();
  });

  it("shows both methods, remembers only the default, and continues natively", () => {
    localStorage.setItem("postora.youtubeConnectMethod", "native");
    const native = vi.fn();
    wrap(
      <YouTubeConnectMethodDialog
        open
        onOpenChange={() => {}}
        workspaceId="workspace-1"
        socialProfileId="profile-1"
        onNativeConnect={native}
      />,
    );
    expect(
      screen.getByRole("radio", { name: /Direct Google OAuth/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: /Composio Managed/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/youtube_made_for_kids/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(native).toHaveBeenCalledOnce();
  });

  it("opens Composio in a fresh tab, polls with the profile, and closes once the channel is connected", async () => {
    localStorage.setItem("postora.youtubeConnectMethod", "composio");
    const tab = { location: { href: "" }, close: vi.fn() };
    openTab.mockReturnValue(tab);
    const initiate = vi.fn().mockResolvedValue({
      connection_id: "conn-7",
      redirect_url: "https://provider.invalid/connect",
    });
    const finalize = vi.fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue({ status: "active" });
    const onOpenChange = vi.fn();
    const onConnected = vi.fn();
    const navigate = vi.fn();
    wrap(
      <YouTubeConnectMethodDialog
        open
        onOpenChange={onOpenChange}
        workspaceId="workspace-1"
        socialProfileId="profile-1"
        onNativeConnect={() => {}}
        onConnected={onConnected}
        initiateConnectionFn={initiate}
        finalizeConnectionFn={finalize}
        navigate={navigate}
      />,
    );
    expect(
      screen.getByRole("radio", { name: /Composio Managed/ }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(initiate).toHaveBeenCalledWith({
        connector_type: "youtube",
        workspace_id: "workspace-1",
        social_profile_id: "profile-1",
      }),
    );
    await waitFor(() => expect(tab.location.href).toBe("https://provider.invalid/connect"));
    expect(navigate).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(/waiting for authorisation/i);
    await waitFor(() => expect(finalize).toHaveBeenCalledWith("conn-7", "profile-1"));
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(localStorage.getItem("postora.youtubeConnectMethod")).toBe("composio");
  });

  it("navigates this tab instead when the popup is blocked", async () => {
    localStorage.setItem("postora.youtubeConnectMethod", "composio");
    const initiate = vi.fn().mockResolvedValue({
      connection_id: "conn-7",
      redirect_url: "https://provider.invalid/connect",
    });
    const navigate = vi.fn();
    wrap(
      <YouTubeConnectMethodDialog
        open
        onOpenChange={() => {}}
        workspaceId="workspace-1"
        socialProfileId="profile-1"
        onNativeConnect={() => {}}
        initiateConnectionFn={initiate}
        finalizeConnectionFn={vi.fn().mockResolvedValue({ status: "pending" })}
        navigate={navigate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://provider.invalid/connect"));
  });

  it("names the failure when Composio's account cannot be adopted", async () => {
    localStorage.setItem("postora.youtubeConnectMethod", "composio");
    const initiate = vi.fn().mockResolvedValue({
      connection_id: "conn-7",
      redirect_url: "https://provider.invalid/connect",
    });
    wrap(
      <YouTubeConnectMethodDialog
        open
        onOpenChange={() => {}}
        workspaceId="workspace-1"
        socialProfileId={null}
        onNativeConnect={() => {}}
        initiateConnectionFn={initiate}
        finalizeConnectionFn={vi.fn().mockResolvedValue({ status: "failed", failure_code: "channel_already_native" })}
        navigate={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("channel_already_native");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});
