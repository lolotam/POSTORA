import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestYouTubeConnection,
  YouTubeConnectMethodDialog,
} from "../YouTubeConnectMethodDialog";

describe("YouTubeConnectMethodDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv("VITE_COMPOSIO_YOUTUBE_ENABLED", "true");
  });

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
    render(
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

  it("initiates the YouTube connector and navigates to its redirect", async () => {
    localStorage.setItem("postora.youtubeConnectMethod", "composio");
    const initiate = vi
      .fn()
      .mockResolvedValue({ redirect_url: "https://provider.invalid/connect" });
    const navigate = vi.fn();
    render(
      <YouTubeConnectMethodDialog
        open
        onOpenChange={() => {}}
        workspaceId="workspace-1"
        socialProfileId="profile-1"
        onNativeConnect={() => {}}
        initiateConnectionFn={initiate}
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
    expect(navigate).toHaveBeenCalledWith("https://provider.invalid/connect");
    expect(localStorage.getItem("postora.youtubeConnectMethod")).toBe(
      "composio",
    );
  });
});
