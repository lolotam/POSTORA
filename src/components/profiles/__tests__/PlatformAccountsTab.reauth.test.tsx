import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PlatformAccountsTab } from "../PlatformAccountsTab";
import type { SocialAccountWithProfile } from "@/hooks/useSocialProfiles";

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({
    flags: { tokenExpires: false, tokenLifetime: false },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/shared", () => ({
  useCopyToClipboard: () => ({ copy: vi.fn() }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

const account: SocialAccountWithProfile = {
  id: "fake-account-id",
  user_id: "fake-user-id",
  platform: "twitter",
  platform_user_id: "fake-platform-user-id",
  platform_username: "fake_user",
  avatar_url: null,
  is_active: true,
  connected_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  social_profile_id: "fake-profile-id",
  token_expires_at: "2099-01-01T00:00:00.000Z",
  account_metadata: null,
  ig_auth_type: null,
  needs_reauth: true,
  last_refresh_error: "Fake expired-token error",
};

const props = {
  platform: "twitter" as const,
  onConnect: vi.fn(),
  onDisconnect: vi.fn(),
  onReconnect: vi.fn(),
  isConnecting: false,
};

it("changes a re-auth account card from Action Required to Active", () => {
  const { rerender } = render(
    <PlatformAccountsTab {...props} accounts={[account]} />,
  );

  expect(screen.getByText("Action Required")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();

  rerender(
    <PlatformAccountsTab
      {...props}
      accounts={[{ ...account, needs_reauth: false }]}
    />,
  );

  expect(screen.getByText("Active")).toBeInTheDocument();
  expect(screen.queryByText("Action Required")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
});
