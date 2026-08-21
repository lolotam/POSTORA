import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { resolveWhatsAppCloudCredentials } from "../_shared/whatsappCloudCredentials.ts";

const GRAPH_API = "https://graph.facebook.com/v21.0";

const UpdateSchema = z.object({
  about: z.string().max(139).optional(),
  address: z.string().max(256).optional(),
  description: z.string().max(512).optional(),
  email: z.string().email().max(128).optional().or(z.literal("")),
  websites: z.array(z.string().url()).max(2).optional(),
  vertical: z.string().max(128).optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    // Service-role client for reading the user's WhatsApp social_account
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // The business profile lives on Meta's Cloud API, so only Cloud-API-backed accounts can
    // answer for it. Direct QR accounts run a self-hosted session with no Meta identity: their
    // access_token is empty and platform_user_id holds a phone number rather than a Cloud API
    // phone_number_id, so including them here sends Meta a number it cannot resolve.
    const { data: waAccounts } = await supabaseAdmin
      .from("social_accounts")
      .select("access_token, platform_user_id, account_metadata")
      .eq("user_id", user.id)
      .eq("platform", "whatsapp")
      .eq("is_active", true)
      .order("connected_at", { ascending: false });

    const resolution = resolveWhatsAppCloudCredentials(waAccounts || []);

    if (resolution.status !== "ok") {
      // Distinguishes "connected, but through a mode Meta holds no profile for" from "nothing
      // connected", so the page can explain the mode instead of reporting a generic failure.
      return new Response(
        JSON.stringify(
          resolution.status === "requires_cloud_api"
            ? {
              error: resolution.reason === "qr_only"
                ? "WhatsApp Business profiles are only available for Meta Cloud API numbers. This number is connected with Direct QR."
                : "This WhatsApp number is missing the Cloud API credentials needed to read its business profile. Reconnect it from Setup.",
              code: "PROFILE_REQUIRES_CLOUD_API",
            }
            : { error: "No connected WhatsApp Business account", code: "NO_WHATSAPP_ACCOUNT" },
        ),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { accessToken, phoneNumberId } = resolution.credentials;

    if (req.method === "GET") {
      const res = await fetch(
        `${GRAPH_API}/${phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await res.json();
      if (!res.ok) {
        console.error("Meta GET error:", JSON.stringify(data));
        return new Response(JSON.stringify({ error: "Failed to fetch profile", details: data }), {
          status: res.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const profile = data.data?.[0] || {};
      return new Response(JSON.stringify(profile), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const parsed = UpdateSchema.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const updateData: Record<string, unknown> = { messaging_product: "whatsapp" };
      for (const [key, value] of Object.entries(parsed.data)) {
        if (value !== undefined) updateData[key] = value;
      }

      const res = await fetch(
        `${GRAPH_API}/${phoneNumberId}/whatsapp_business_profile`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updateData),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        console.error("Meta POST error:", JSON.stringify(data));
        return new Response(JSON.stringify({ error: "Failed to update profile", details: data }), {
          status: res.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("whatsapp-profile error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
