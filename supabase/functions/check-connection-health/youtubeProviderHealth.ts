export interface YouTubeHealthResult {
  success: boolean;
  message: string;
  tokenStatus?: "valid" | "expired";
  daysUntilExpiry?: number;
}

export interface YouTubeHealthAccount {
  auth_provider?: "native" | "composio";
  connection_id?: string | null;
  workspace_id?: string | null;
}

export async function checkYouTubeProviderHealth(
  account: YouTubeHealthAccount,
  deps: {
    testNative: () => Promise<YouTubeHealthResult>;
    loadConnectionStatus: (
      connectionId: string,
      workspaceId: string,
    ) => Promise<string | null>;
  },
): Promise<YouTubeHealthResult> {
  if (account.auth_provider !== "composio") return await deps.testNative();
  if (!account.connection_id || !account.workspace_id) {
    return {
      success: false,
      message: "Composio YouTube connection requires reconnection",
      tokenStatus: "expired",
    };
  }
  const status = await deps.loadConnectionStatus(
    account.connection_id,
    account.workspace_id,
  );
  const active = status === "active";
  return {
    success: active,
    message: active
      ? "Composio YouTube connection is working"
      : "Composio YouTube connection requires reconnection",
    tokenStatus: active ? "valid" : "expired",
  };
}
