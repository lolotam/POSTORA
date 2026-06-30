import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/lib/oauthRedirects", () => ({
  buildReturnUrl: (p: string) => `https://postora.cloud/profiles?platform=${p}`,
  OAUTH_CALLBACKS: { tiktok: "https://postora.cloud/tiktok-callback" },
}));

import { supabase } from "@/integrations/supabase/client";
import { usePinterestOAuth } from "@/hooks/oauth/usePinterestOAuth";

describe("OAuth reconnect mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom: prevent navigation
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: { href: string } }).location = { href: "" };
  });

  it("Pinterest authorize body includes mode=reconnect + social_account_id", async () => {
    (supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { url: "https://pinterest.example/auth" },
      error: null,
    });

    const { handlePinterestConnect } = usePinterestOAuth();
    await handlePinterestConnect("profile-9", {
      mode: "reconnect",
      socialAccountId: "acct-42",
    });

    const call = (supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("pinterest-oauth");
    expect(call[1].body).toMatchObject({
      action: "authorize",
      social_profile_id: "profile-9",
      mode: "reconnect",
      social_account_id: "acct-42",
    });
  });

  it("Pinterest authorize body omits reconnect fields by default", async () => {
    (supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { url: "https://pinterest.example/auth" },
      error: null,
    });

    const { handlePinterestConnect } = usePinterestOAuth();
    await handlePinterestConnect("profile-9");

    const call = (supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].body.mode).toBeUndefined();
    expect(call[1].body.social_account_id).toBeUndefined();
  });
});
