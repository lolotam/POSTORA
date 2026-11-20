export interface YouTubeAccountSource {
  id: string;
  platform: string;
  platform_username: string | null;
  avatar_url: string | null;
  auth_provider?: string | null;
}

export interface YouTubeAccountOption {
  id: string;
  title: string;
  avatarUrl: string | null;
  provider: "native" | "composio";
}

// Keeps the connected-account rows the screen needs: YouTube only, with a
// neutral title when the channel has no username. Composio accounts stay in
// the picker (the capability screen explains why browsing is unsupported).
export function toYouTubeAccountOptions(accounts: readonly YouTubeAccountSource[]): YouTubeAccountOption[] {
  return accounts
    .filter((account) => account.platform === "youtube")
    .map((account) => ({
      id: account.id,
      title: account.platform_username ?? "YouTube",
      avatarUrl: account.avatar_url,
      provider: account.auth_provider === "composio" ? "composio" : "native",
    }));
}
