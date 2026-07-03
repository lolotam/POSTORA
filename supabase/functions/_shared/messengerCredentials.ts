const GRAPH_API = "https://graph.facebook.com/v22.0";
const INSTAGRAM_GRAPH_API = "https://graph.instagram.com/v22.0";

export interface SocialAccountForMessaging {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string | null;
  ig_auth_type: string | null;
  account_metadata: Record<string, unknown> | null;
  access_token: string;
}

export function isDirectInstagramAccount(account: SocialAccountForMessaging): boolean {
  if (account.platform !== "instagram") return false;
  const meta = account.account_metadata || {};
  return account.ig_auth_type === "business_login"
    || meta.flow === "direct"
    || meta.source === "instagram_business_login"
    || meta.token_type === "long_lived";
}

/**
 * For a page-linked Instagram account, finds the linked Facebook Page's token.
 * Facebook accounts already carry their own page token directly.
 */
export async function getPageTokenForMessaging(
  adminClient: any,
  account: SocialAccountForMessaging,
): Promise<{ pageId: string; pageToken: string }> {
  if (account.platform === "facebook") {
    return { pageId: account.platform_user_id, pageToken: account.access_token };
  }

  const meta = account.account_metadata || {};
  const storedPageId = (meta.page_id || meta.facebook_page_id) as string | undefined;
  const storedPageToken = account.access_token || (meta.page_access_token as string | undefined);

  if (storedPageId && storedPageToken) {
    console.log(`[messenger-credentials] Using stored FB page ${storedPageId} for IG account ${account.platform_user_id}`);
    return { pageId: storedPageId, pageToken: storedPageToken };
  }

  const { data: fbAccounts } = await adminClient
    .from("social_accounts")
    .select("id, access_token, platform_user_id, platform_username, account_metadata")
    .eq("user_id", account.user_id)
    .eq("platform", "facebook")
    .eq("is_active", true);

  if (!fbAccounts || fbAccounts.length === 0) {
    throw new Error("NO_LINKED_PAGE: No Facebook Page found. Instagram DMs require a linked Facebook Page with pages_messaging permission.");
  }

  if (storedPageId) {
    const match = fbAccounts.find((fb: { platform_user_id: string }) => fb.platform_user_id === storedPageId);
    if (match) {
      console.log(`[messenger-credentials] Using stored page_id ${storedPageId} for IG account ${account.platform_user_id}`);
      return { pageId: match.platform_user_id, pageToken: match.access_token };
    }
  }

  const igUserId = account.platform_user_id;

  for (const fb of fbAccounts as Array<{ platform_user_id: string; access_token: string }>) {
    try {
      const checkUrl = `${GRAPH_API}/${fb.platform_user_id}?fields=instagram_business_account&access_token=${fb.access_token}`;
      const checkRes = await fetch(checkUrl);
      if (!checkRes.ok) {
        await checkRes.text();
        continue;
      }
      const checkData = await checkRes.json();
      const linkedIgId = checkData.instagram_business_account?.id;
      if (linkedIgId === igUserId) {
        console.log(`[messenger-credentials] Found linked FB page ${fb.platform_user_id} for IG ${igUserId}`);
        await adminClient
          .from("social_accounts")
          .update({ account_metadata: { ...meta, facebook_page_id: fb.platform_user_id } })
          .eq("id", account.id);
        return { pageId: fb.platform_user_id, pageToken: fb.access_token };
      }
    } catch {
      continue;
    }
  }

  // When exactly one Facebook Page is connected, it's correct-by-construction even if the
  // linkage check above failed transiently.
  if (fbAccounts.length === 1) {
    console.warn(`[messenger-credentials] Linkage check failed for IG ${igUserId}, but only one FB page is connected (${fbAccounts[0].platform_user_id}) — using it`);
    return { pageId: fbAccounts[0].platform_user_id, pageToken: fbAccounts[0].access_token };
  }

  console.warn(`[messenger-credentials] Could not find linked FB page for IG account ${igUserId} among ${fbAccounts.length} connected pages`);
  throw new Error("NO_LINKED_PAGE_MATCH: Could not find the Facebook Page linked to this Instagram account. Please reconnect your Instagram account.");
}

/**
 * Resolves which Graph API host, page id, and token to send/delete through.
 * Direct-login Instagram accounts have no linked Facebook Page — they send via
 * graph.instagram.com with their own token, never through getPageTokenForMessaging().
 */
export async function getSendCredentials(
  adminClient: any,
  account: SocialAccountForMessaging,
): Promise<{ graphBase: string; pageId: string; pageToken: string }> {
  if (isDirectInstagramAccount(account)) {
    return { graphBase: INSTAGRAM_GRAPH_API, pageId: account.platform_user_id, pageToken: account.access_token };
  }
  const { pageId, pageToken } = await getPageTokenForMessaging(adminClient, account);
  return { graphBase: GRAPH_API, pageId, pageToken };
}
