import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";

import { restrictedCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");

// Price ID to plan slug mapping
const PRICE_TO_PLAN: Record<string, string> = {
  "price_1SpPKL0hJJ11XlNONGaoHAI0": "pro",
  "price_1SpPL30hJJ11XlNO2wGUQHSn": "pro",
  "price_1SpPLX0hJJ11XlNOuaId2Dfy": "business",
  "price_1SpPLj0hJJ11XlNOqjV6RUAz": "business",
};

// Limits live on subscription_plans and resolve through effective_user_quotas().
// Writing concrete numbers here would convert every subscriber into a permanent
// override at their plan's values as of that moment, and later edits on
// /admin/plan-quotas would never reach a paying user.
const CLEARED_QUOTA_OVERRIDES = {
  max_profiles: null,
  max_social_accounts: null,
  max_posts_per_month: null,
  max_posts_per_day: null,
  max_media_uploads_per_day: null,
} as const;

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[BACKFILL-SUBSCRIPTION] ${step}${detailsStr}`);
};

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    if (!STRIPE_SECRET_KEY) {
      throw new Error("Stripe is not configured");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Verify admin role
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      throw new Error("Invalid user token");
    }

    // Check if user is admin
    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .single();

    if (!roleData || roleData.role !== "admin") {
      throw new Error("Admin access required");
    }

    logStep("Admin verified", { adminId: user.id });

    const { email } = await req.json();

    if (!email) {
      throw new Error("Email is required");
    }

    logStep("Looking up user", { email });

    // Find user by email
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, email, full_name")
      .eq("email", email)
      .single();

    if (profileError || !profile) {
      throw new Error(`User not found with email: ${email}`);
    }

    logStep("User found", { userId: profile.id });

    // Initialize Stripe
    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2025-08-27.basil",
    });

    // Find Stripe customer
    const customers = await stripe.customers.list({
      email: email,
      limit: 1,
    });

    if (customers.data.length === 0) {
      throw new Error(`No Stripe customer found for email: ${email}`);
    }

    const customerId = customers.data[0].id;
    logStep("Stripe customer found", { customerId });

    // Find active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      throw new Error(`No active Stripe subscription found for email: ${email}`);
    }

    const subscription = subscriptions.data[0];
    const priceId = subscription.items.data[0]?.price?.id;
    const planSlug = priceId ? PRICE_TO_PLAN[priceId] : null;

    if (!planSlug) {
      throw new Error(`Unknown price ID: ${priceId}. Cannot determine plan.`);
    }

    logStep("Active subscription found", { 
      subscriptionId: subscription.id, 
      priceId, 
      planSlug 
    });

    // Find the plan in database
    const { data: plan, error: planError } = await supabase
      .from("subscription_plans")
      .select("id, name, slug")
      .eq("slug", planSlug)
      .single();

    if (planError || !plan) {
      throw new Error(`Plan not found in database for slug: ${planSlug}`);
    }

    logStep("Plan found in database", { planId: plan.id, planName: plan.name });

    // Upsert subscription
    const { error: subError } = await supabase
      .from("user_subscriptions")
      .upsert({
        user_id: profile.id,
        plan_id: plan.id,
        status: "active",
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
        current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        cancel_at_period_end: subscription.cancel_at_period_end,
      }, {
        onConflict: "user_id",
      });

    if (subError) {
      logStep("Error upserting subscription", { error: subError });
      throw new Error("Failed to create subscription record");
    }

    logStep("Subscription upserted");

    // Upsert user role to subscriber (unless admin)
    const { data: existingRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", profile.id)
      .single();

    if (!existingRole || existingRole.role === "user") {
      await supabase
        .from("user_roles")
        .upsert({
          user_id: profile.id,
          role: "subscriber",
        }, {
          onConflict: "user_id",
        });
      logStep("User role updated to subscriber");
    } else {
      logStep("User role unchanged", { existingRole: existingRole.role });
    }

    // Clear overrides so the backfilled plan resolves through the arbiter
    const quotas = CLEARED_QUOTA_OVERRIDES;

    const { error: quotaUpsertError } = await supabase
      .from("user_quotas")
      .upsert({
        user_id: profile.id,
        ...quotas,
      }, {
        onConflict: "user_id",
      });

    if (quotaUpsertError) {
      logStep("Quota override clear failed", { userId: profile.id, error: quotaUpsertError });
    } else {
      logStep("User quota overrides cleared", { quotas });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Backfilled ${plan.name} subscription for ${email}`,
        subscription: {
          user_id: profile.id,
          plan: plan.name,
          stripe_subscription_id: subscription.id,
          period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logStep("ERROR", { message: errorMessage });
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { 
        status: 400, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
});
