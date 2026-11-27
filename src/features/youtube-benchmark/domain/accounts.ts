export interface YouTubeBenchmarkAccountSource {
  id: string;
  platform: string;
  platform_username: string | null;
  avatar_url: string | null;
  auth_provider?: string | null;
}

export interface YouTubeBenchmarkAccountOption {
  id: string;
  title: string;
  avatarUrl: string | null;
}

/**
 * The connected channels the benchmark can borrow a credential from.
 *
 * Only a NATIVE YouTube connection can: the benchmark reads with the
 * `youtube.readonly` grant the creator made, and a managed (Composio)
 * connection holds no such grant. Composio rows are therefore dropped here
 * rather than offered and then refused.
 */
export function toYouTubeBenchmarkAccountOptions(
  accounts: readonly YouTubeBenchmarkAccountSource[],
): YouTubeBenchmarkAccountOption[] {
  return accounts
    .filter((account) => account.platform === "youtube" && account.auth_provider !== "composio")
    .map((account) => ({
      id: account.id,
      title: account.platform_username ?? "YouTube",
      avatarUrl: account.avatar_url,
    }));
}
