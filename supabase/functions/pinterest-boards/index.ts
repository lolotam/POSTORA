import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import {
  forbidden,
  invalidBody,
  providerUnavailable,
  unauthorized,
} from "../_shared/auth-responses.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Parse body safely. Empty/invalid JSON must NOT crash the function.
  let body: { user_id?: string } = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return invalidBody({ reason: "Malformed JSON body" }, "INVALID_JSON");
  }

  // Authenticate caller from the Authorization header. Derive user_id from
  // the verified JWT — body.user_id is only honored when it matches `sub`
  // (or the caller is the service role).
  let authedUserId: string;
  let isServiceRole = false;
  try {
    const result = await authenticateCaller(req, body.user_id ?? null);
    authedUserId = result.userId;
    isServiceRole = result.isServiceRole;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unauthorized";
    return unauthorized(msg);
  }

  // If the body asks for a different user, only service-role may impersonate.
  if (body.user_id && body.user_id !== authedUserId && !isServiceRole) {
    return forbidden("Cannot read another user's Pinterest accounts");
  }

  console.log("Fetching Pinterest boards for user:", authedUserId);

  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

  // Get the user's Pinterest account(s) - handle multiple accounts
  const { data: accounts, error: accountError } = await supabase
    .from("social_accounts")
    .select("access_token, platform_username")
    .eq("user_id", authedUserId)
    .eq("platform", "pinterest")
    .eq("is_active", true);

  if (accountError) {
    console.error("Database error:", accountError);
    return providerUnavailable("pinterest", "DB_ERROR");
  }

  if (!accounts || accounts.length === 0) {
    return new Response(
      JSON.stringify({
        boards: [],
        error: "No Pinterest account connected",
        code: "ACCOUNT_NOT_CONNECTED",
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // Use the first active account (or could aggregate from all)
  const account = accounts[0];

  // Fetch boards from Pinterest API
  let boardsResponse: Response;
  try {
    boardsResponse = await fetch("https://api.pinterest.com/v5/boards", {
      headers: { "Authorization": `Bearer ${account.access_token}` },
    });
  } catch (err) {
    console.error("Pinterest fetch error:", err);
    return providerUnavailable("pinterest", "PROVIDER_FETCH_ERROR");
  }

  // Read body as text first so we can safely handle empty/non-JSON responses
  // (the original code crashed with "Unexpected end of JSON input").
  const rawBody = await boardsResponse.text();
  console.log("Pinterest boards response:", boardsResponse.status);

  let boardsData: { items?: unknown[]; message?: string } = {};
  if (rawBody.trim().length > 0) {
    try {
      boardsData = JSON.parse(rawBody);
    } catch {
      console.error("Pinterest returned non-JSON response");
      return providerUnavailable("pinterest", "PROVIDER_EMPTY_RESPONSE");
    }
  } else if (!boardsResponse.ok) {
    return providerUnavailable("pinterest", "PROVIDER_EMPTY_RESPONSE");
  }

  if (!boardsResponse.ok) {
    if (boardsResponse.status === 401) {
      return new Response(
        JSON.stringify({
          error: "Pinterest token expired. Please reconnect your account.",
          code: "ACCOUNT_REAUTH_REQUIRED",
          boards: [],
        }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    return providerUnavailable("pinterest", "PROVIDER_ERROR");
  }

  const items = Array.isArray(boardsData.items) ? boardsData.items : [];
  const boards = items.map((board: any) => ({
    id: board.id,
    name: board.name,
    description: board.description,
    privacy: board.privacy,
    pin_count: board.pin_count,
    image_url: board.media?.image_cover_url || null,
  }));

  console.log(`Found ${boards.length} Pinterest boards`);

  return new Response(
    JSON.stringify({ boards, username: account.platform_username }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
