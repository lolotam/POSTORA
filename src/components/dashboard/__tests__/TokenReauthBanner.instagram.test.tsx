import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi, beforeEach } from "vitest";
import { TokenReauthBanner } from "../TokenReauthBanner";

// The banner is the dashboard entry point for reconnecting. Instagram is the only
// platform whose reconnect needs a login-method choice before any redirect, and that
// dialog used to live only on the Profiles page — so clicking Reconnect here did
// nothing visible. These tests assert the dialog actually mounts from this surface.

const account = {
  id: "ig-account-1",
  platform: "instagram",
  platform_username: "postora.cloud",
  needs_reauth: true,
  last_refresh_error: null,
  social_profile_id: "profile-1",
};

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ data: [account], error: null }),
          }),
        }),
      }),
    }),
  },
}));

const handleInstagramConnect = vi.fn();

vi.mock("@/hooks/useProfileOAuth", async () => {
  const { useState } = await import("react");
  return {
    useProfileOAuth: () => {
      const [instagramFlowRequest, setRequest] = useState<{ profileId: string } | null>(null);
      return {
        connectingPlatform: null,
        instagramFlowRequest,
        // Mirrors the real hook: an Instagram reconnect raises a flow request
        // instead of starting a redirect.
        handleReconnectPlatform: (profileId: string, platform: string) => {
          if (platform === "instagram") setRequest({ profileId });
          return Promise.resolve();
        },
        selectInstagramFlow: (flow: string) => {
          setRequest(null);
          handleInstagramConnect(flow);
          return Promise.resolve();
        },
        clearInstagramFlowRequest: () => setRequest(null),
      };
    },
  };
});

const renderBanner = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TokenReauthBanner />
    </QueryClientProvider>,
  );

// fireEvent, not userEvent: userEvent.setup() tries to redefine navigator.clipboard,
// which throws in this project's jsdom environment.
beforeEach(() => vi.clearAllMocks());

it("clicking Reconnect on an Instagram account opens the login-method dialog", async () => {
  renderBanner();

  fireEvent.click(await screen.findByRole("button", { name: /reconnect/i }));

  expect(await screen.findByText(/Connect Instagram Directly/i)).toBeInTheDocument();
});

it("choosing a method starts that connect flow", async () => {
  renderBanner();

  fireEvent.click(await screen.findByRole("button", { name: /reconnect/i }));
  fireEvent.click(await screen.findByText(/Connect Instagram Directly/i));

  expect(handleInstagramConnect).toHaveBeenCalledWith("direct");
});
