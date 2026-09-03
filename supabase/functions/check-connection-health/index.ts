import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  handleCorsOptions,
  jsonResponse,
  errorResponse,
  badRequestResponse,
  unauthorizedResponse,
} from "../_shared/cors.ts";
import { checkYouTubeProviderHealth } from "./youtubeProviderHealth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

interface HealthCheckResult {
  success: boolean;
  message: string;
  tokenStatus?: "valid" | "expired";
  daysUntilExpiry?: number;
}

async function connectorConnectionStatus(
  supabase: any,
  connectionId: string,
  workspaceId: string,
): Promise<string | null> {
  const { data, error } = await supabase.from("connector_connections")
    .select("status")
    .eq("id", connectionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error("Connection lookup failed");
  return data?.status ?? null;
}

async function testTikTokConnection(accessToken: string): Promise<HealthCheckResult> {
  try {
    const response = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.ok) {
      return { success: true, message: "TikTok connection is working" };
    } else {
      const data = await response.json();
      return { success: false, message: data.error?.message || "TikTok API returned an error" };
    }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Failed to connect to TikTok" };
  }
}

async function testFacebookConnection(accessToken: string): Promise<HealthCheckResult> {
  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${accessToken}`);

    if (response.ok) {
      return { success: true, message: "Facebook connection is working" };
    } else {
      const data = await response.json();
      return { success: false, message: data.error?.message || "Facebook API returned an error" };
    }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Failed to connect to Facebook" };
  }
}

async function testInstagramConnection(accessToken: string): Promise<HealthCheckResult> {
  // Instagram via Facebook page - uses the same token as Facebook
  return testFacebookConnection(accessToken);
}

async function testInstagramBusinessLoginConnection(accessToken: string): Promise<HealthCheckResult> {
  try {
    const response = await fetch(
      `https://graph.instagram.com/me?fields=id,username&access_token=${accessToken}`
    );

    if (response.ok) {
      return { success: true, message: "Instagram (Direct) connection is working" };
    } else {
      const data = await response.json();
      return { success: false, message: data.error?.message || "Instagram API returned an error" };
    }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Failed to connect to Instagram" };
  }
}

async function testPinterestConnection(accessToken: string): Promise<HealthCheckResult> {
  try {
    const response = await fetch("https://api.pinterest.com/v5/user_account", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.ok) {
      return { success: true, message: "Pinterest connection is working" };
    } else {
      const data = await response.json();
      return { success: false, message: data.message || "Pinterest API returned an error" };
    }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Failed to connect to Pinterest" };
  }
}

async function testYouTubeConnection(accessToken: string): Promise<HealthCheckResult> {
  try {
    const response = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.ok) {
      return { success: true, message: "YouTube connection is working" };
    } else {
      const data = await response.json();
      return { success: false, message: data.error?.message || "YouTube API returned an error" };
    }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Failed to connect to YouTube" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsOptions();
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const authorizationHeader = req.headers.get("Authorization");
    const bearerMatch = authorizationHeader?.match(/^Bearer\s+(\S+)$/i);

    if (!bearerMatch) {
      return unauthorizedResponse();
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase credentials not configured");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user: callerUser }, error: authError } = await supabase.auth.getUser(bearerMatch[1]);

    if (authError || !callerUser) {
      return unauthorizedResponse();
    }

    let requestBody: unknown;
    try {
      requestBody = await req.json();
    } catch {
      return badRequestResponse("account_id is required");
    }

    if (typeof requestBody !== "object" || requestBody === null) {
      return badRequestResponse("account_id is required");
    }

    const { account_id, action } = requestBody as Record<string, unknown>;
    if (typeof account_id !== "string" || account_id.trim() === "") {
      return badRequestResponse("account_id is required");
    }

    // Get the account
    const { data: account, error: fetchError } = await supabase
      .from("social_accounts")
      .select("id, user_id, platform, access_token, token_expires_at, account_metadata, auth_provider, connection_id, workspace_id")
      .eq("id", account_id)
      .maybeSingle();

    if (fetchError) {
      throw new Error("Account lookup failed");
    }

    if (!account || account.user_id !== callerUser.id) {
      return errorResponse("Forbidden", 403);
    }

    // Test the connection
    if (action === "test") {
      let result: HealthCheckResult;

      switch (account.platform) {
        case "tiktok":
          result = await testTikTokConnection(account.access_token);
          break;
        case "facebook":
          result = await testFacebookConnection(account.access_token);
          break;
        case "instagram": {
          const igMeta = account.account_metadata as Record<string, unknown> | null;
          if (igMeta?.account_type === "business_login") {
            result = await testInstagramBusinessLoginConnection(account.access_token);
          } else {
            result = await testInstagramConnection(account.access_token);
          }
          break;
        }
        case "pinterest":
          result = await testPinterestConnection(account.access_token);
          break;
        case "youtube":
          result = await checkYouTubeProviderHealth(account, {
            testNative: () => testYouTubeConnection(account.access_token),
            loadConnectionStatus: (connectionId, workspaceId) =>
              connectorConnectionStatus(supabase, connectionId, workspaceId),
          });
          break;
        default:
          result = { success: false, message: `Testing not supported for ${account.platform}` };
      }

      return jsonResponse(result);
    }

    // Get health status
    if (action === "status") {
      if (account.platform === "youtube" && account.auth_provider === "composio") {
        return jsonResponse(await checkYouTubeProviderHealth(account, {
          testNative: () => testYouTubeConnection(account.access_token),
          loadConnectionStatus: (connectionId, workspaceId) =>
            connectorConnectionStatus(supabase, connectionId, workspaceId),
        }));
      }
      let tokenStatus: "valid" | "expired" = "valid";
      let daysUntilExpiry: number | undefined;

      if (account.token_expires_at) {
        const now = new Date();
        const expiry = new Date(account.token_expires_at);
        const diffMs = expiry.getTime() - now.getTime();
        daysUntilExpiry = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (daysUntilExpiry < 0) {
          tokenStatus = "expired";
        }
      }

      return jsonResponse({
        success: true,
        tokenStatus,
        daysUntilExpiry,
        message: tokenStatus === "expired"
          ? "Token has expired"
          : "Token is valid",
      });
    }

    return badRequestResponse("Invalid action");

  } catch (error: unknown) {
    console.error("Connection health check error:", error);
    return errorResponse("Internal error");
  }
});
