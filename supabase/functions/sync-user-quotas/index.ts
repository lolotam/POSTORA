import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { logStep, syncUserQuotas } from "./syncUserQuotas.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    if (!STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      logStep("Missing or invalid Authorization header");
      return new Response(JSON.stringify({ error: "Unauthorized: missing Authorization header" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      logStep("Missing bearer token");
      return new Response(JSON.stringify({ error: "Unauthorized: missing bearer token" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    // Signing-keys compatible JWT validation (do NOT use getUser/session)
    const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getClaims(token);

    if (claimsError || !claimsData?.claims) {
      logStep("JWT validation failed", { error: claimsError?.message });
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    const authenticatedUserId = claimsData.claims.sub as string;

    // Use service role client for admin operations
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-08-27.basil" });

    // Check if user is admin
    const { data: roleData } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", authenticatedUserId)
      .single();

    if (roleData?.role !== "admin") {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 403,
      });
    }

    logStep("Admin authenticated", { adminId: authenticatedUserId });

    const { target_user_id, sync_all } = await req.json();

    const results: { userId: string; planSlug: string; success: boolean; error?: string }[] = [];

    if (sync_all) {
      // Sync all users with active subscriptions
      logStep("Syncing all users");

      const { data: profiles, error: profilesError } = await supabaseAdmin
        .from("profiles")
        .select("id, email");

      if (profilesError) throw profilesError;

      for (const profile of profiles || []) {
        try {
          const planSlug = await syncUserQuotas(supabaseAdmin, stripe, profile.id, profile.email);
          results.push({ userId: profile.id, planSlug, success: true });
        } catch (err) {
          results.push({ 
            userId: profile.id, 
            planSlug: "free", 
            success: false, 
            error: err instanceof Error ? err.message : String(err) 
          });
        }
      }
    } else if (target_user_id) {
      // Sync single user
      logStep("Syncing single user", { targetUserId: target_user_id });

      const { data: profile, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("id, email")
        .eq("id", target_user_id)
        .single();

      if (profileError || !profile) {
        throw new Error("User not found");
      }

      const planSlug = await syncUserQuotas(supabaseAdmin, stripe, profile.id, profile.email);
      results.push({ userId: profile.id, planSlug, success: true });
    } else {
      throw new Error("Either target_user_id or sync_all must be provided");
    }

    logStep("Sync completed", { totalSynced: results.length, successful: results.filter(r => r.success).length });

    return new Response(JSON.stringify({ 
      success: true, 
      results,
      summary: {
        total: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
      }
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
