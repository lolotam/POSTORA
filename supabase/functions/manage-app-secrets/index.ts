import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const PROJECT_REF = Deno.env.get("SUPABASE_PROJECT_REF") ?? "self-hosted";
const MANAGEMENT_API = Deno.env.get("SUPABASE_MANAGEMENT_API") ?? "https://api.supabase.com";

// Platform secret mappings
const PLATFORM_SECRETS: Record<
  string,
  { clientId: string; clientSecret: string }
> = {
  facebook: {
    clientId: "FACEBOOK_APP_ID",
    clientSecret: "FACEBOOK_APP_SECRET",
  },
  instagram: {
    clientId: "INSTAGRAM_APP_ID",
    clientSecret: "INSTAGRAM_APP_SECRET",
  },
  threads: { clientId: "THREADS_APP_ID", clientSecret: "THREADS_APP_SECRET" },
  tiktok: {
    clientId: "TIKTOK_CLIENT_KEY",
    clientSecret: "TIKTOK_CLIENT_SECRET",
  },
  twitter: {
    clientId: "TWITTER_CLIENT_ID",
    clientSecret: "TWITTER_CLIENT_SECRET",
  },
  linkedin: {
    clientId: "LINKEDIN_CLIENT_ID",
    clientSecret: "LINKEDIN_CLIENT_SECRET",
  },
  pinterest: {
    clientId: "PINTEREST_CLIENT_ID",
    clientSecret: "PINTEREST_CLIENT_SECRET",
  },
  google: {
    clientId: "GOOGLE_CLIENT_ID",
    clientSecret: "GOOGLE_CLIENT_SECRET",
  },
};

function maskSecret(value: string): string {
  if (!value || value.length < 8) return "••••••••";
  return value.slice(0, 4) + "••••••" + value.slice(-4);
}

async function verifyAdmin(authHeader: string): Promise<string> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");

  const { data: roleData } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();

  if (!roleData) throw new Error("Admin access required");
  return user.id;
}

async function listSecrets(): Promise<Record<string, { clientId: string | null; clientSecret: string | null }>> {
  const mgmtToken = Deno.env.get("SB_MANAGEMENT_TOKEN");
  if (!mgmtToken) throw new Error("Management token not configured");

  const res = await fetch(
    `${MANAGEMENT_API}/v1/projects/${PROJECT_REF}/secrets`,
    { headers: { Authorization: `Bearer ${mgmtToken}` } }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Management API error: ${res.status} ${text}`);
  }

  const secrets: Array<{ name: string; value: string }> = await res.json();
  const secretMap = new Map(secrets.map((s) => [s.name, s.value]));

  const result: Record<string, { clientId: string | null; clientSecret: string | null }> = {};

  for (const [platform, mapping] of Object.entries(PLATFORM_SECRETS)) {
    const idVal = secretMap.get(mapping.clientId);
    const secretVal = secretMap.get(mapping.clientSecret);
    result[platform] = {
      clientId: idVal ? maskSecret(idVal) : null,
      clientSecret: secretVal ? maskSecret(secretVal) : null,
    };
  }

  return result;
}

async function updateSecrets(
  updates: Array<{ name: string; value: string }>
): Promise<void> {
  const mgmtToken = Deno.env.get("SB_MANAGEMENT_TOKEN");
  if (!mgmtToken) throw new Error("Management token not configured");

  // Validate only known secret names
  const allValidNames = new Set(
    Object.values(PLATFORM_SECRETS).flatMap((m) => [m.clientId, m.clientSecret])
  );
  for (const u of updates) {
    if (!allValidNames.has(u.name)) {
      throw new Error(`Invalid secret name: ${u.name}`);
    }
  }

  const res = await fetch(
    `${MANAGEMENT_API}/v1/projects/${PROJECT_REF}/secrets`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mgmtToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updates),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update secrets: ${res.status} ${text}`);
  }
  await res.text(); // consume body
}

async function testPlatform(
  platform: string
): Promise<{ success: boolean; message: string }> {
  // Read current secrets from env (edge function has access)
  const mapping = PLATFORM_SECRETS[platform];
  if (!mapping) return { success: false, message: "Unknown platform" };

  const clientId = Deno.env.get(mapping.clientId);
  const clientSecret = Deno.env.get(mapping.clientSecret);

  if (!clientId || !clientSecret) {
    return { success: false, message: "Credentials not configured" };
  }

  try {
    switch (platform) {
      case "facebook":
      case "instagram":
      case "threads": {
        // Threads has its own OAuth host (graph.threads.net). Test there specifically
        // so admins can verify the live THREADS_APP_ID, not just generic Meta validity.
        if (platform === "threads") {
          const idPrefix = clientId.slice(0, 6);
          try {
            const res = await fetch(
              `https://graph.threads.net/oauth/access_token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`
            );
            const data = await res.json();
            console.log(JSON.stringify({
              event: "manage_app_secrets_threads_test",
              app_id_prefix: idPrefix,
              http_status: res.status,
              ok: !!data.access_token,
              error_code: data.error?.code,
              error_message: data.error?.message,
            }));
            if (data.access_token) {
              return { success: true, message: `Threads app token obtained (app_id_prefix: ${idPrefix})` };
            }
            const msg = data.error?.message || data.error_message || "Threads validation failed";
            // Meta error code 4476002 / "No app ID was sent" → app id is wrong / not a Threads app
            if (data.error?.code === 4476002 || /no app id/i.test(msg)) {
              return { success: false, message: `Stale or invalid THREADS_APP_ID (prefix: ${idPrefix}). Update the secret to the Threads use-case App ID.` };
            }
            return { success: false, message: `${msg} (app_id_prefix: ${idPrefix})` };
          } catch (err) {
            return { success: false, message: `Threads test failed: ${(err as Error).message} (app_id_prefix: ${idPrefix})` };
          }
        }
        // Use Meta's debug_token or app token endpoint
        const res = await fetch(
          `https://graph.facebook.com/oauth/access_token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`
        );
        const data = await res.json();
        if (data.access_token) {
          return { success: true, message: "App token obtained successfully" };
        }
        return {
          success: false,
          message: data.error?.message || "Failed to get app token",
        };
      }
      case "tiktok": {
        const res = await fetch(
          "https://open.tiktokapis.com/v2/oauth/token/",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_key: clientId,
              client_secret: clientSecret,
              grant_type: "client_credentials",
            }),
          }
        );
        const data = await res.json();
        if (data.access_token || data.data?.access_token) {
          return { success: true, message: "TikTok credentials valid" };
        }
        return {
          success: false,
          message: data.error_description || data.message || "Validation failed",
        };
      }
      case "linkedin": {
        // LinkedIn doesn't have a simple client_credentials test — just check format
        if (clientId.length > 5 && clientSecret.length > 5) {
          return { success: true, message: "Credentials format valid (cannot test without user token)" };
        }
        return { success: false, message: "Credentials appear invalid" };
      }
      case "twitter": {
        // Twitter OAuth 2.0 client credentials (Bearer token)
        const credentials = btoa(`${clientId}:${clientSecret}`);
        const res = await fetch("https://api.twitter.com/oauth2/token", {
          method: "POST",
          headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
        });
        const data = await res.json();
        if (data.access_token || data.token_type) {
          return { success: true, message: "Twitter credentials valid" };
        }
        return { success: false, message: data.errors?.[0]?.message || "Validation failed" };
      }
      case "pinterest": {
        // Pinterest doesn't support simple client_credentials — format check
        if (clientId.length > 5 && clientSecret.length > 5) {
          return { success: true, message: "Credentials format valid" };
        }
        return { success: false, message: "Credentials appear invalid" };
      }
      case "google": {
        // Google tokeninfo check
        if (clientId.includes(".apps.googleusercontent.com") && clientSecret.length > 5) {
          return { success: true, message: "Google credentials format valid" };
        }
        return { success: false, message: "Client ID should end with .apps.googleusercontent.com" };
      }
      default:
        return { success: false, message: "No test available for this platform" };
    }
  } catch (err) {
    return { success: false, message: `Test failed: ${err.message}` };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization");

    await verifyAdmin(authHeader);

    const { action, platform, updates } = await req.json();

    switch (action) {
      case "list": {
        const result = await listSecrets();
        return new Response(JSON.stringify({ success: true, data: result }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "update": {
        if (!updates || !Array.isArray(updates) || updates.length === 0) {
          throw new Error("No updates provided");
        }
        await updateSecrets(updates);
        return new Response(
          JSON.stringify({ success: true, message: "Secrets updated" }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      case "test": {
        if (!platform) throw new Error("Platform required for test");
        const result = await testPlatform(platform);
        return new Response(JSON.stringify({ success: true, data: result }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (err) {
    console.error("manage-app-secrets error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      {
        status: err.message.includes("Unauthorized") || err.message.includes("Admin") ? 403 : 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
