import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import Stripe from "https://esm.sh/stripe@18.5.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CHECK-SUBSCRIPTION] ${step}${detailsStr}`);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

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

    // Signing-keys compatible JWT validation using getClaims
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const { data: claimsData, error: claimsError } = await supabaseClient.auth.getClaims(token);

    if (claimsError || !claimsData?.claims) {
      logStep("JWT validation failed", { error: claimsError?.message });
      return new Response(JSON.stringify({ error: "Unauthorized: invalid token" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    const userId = claimsData.claims.sub as string;
    const userEmail = claimsData.claims.email as string;

    if (!userEmail) {
      logStep("User email not found in claims", { userId });
      return new Response(JSON.stringify({ error: "Unauthorized: user email not available" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    logStep("User authenticated", { userId, email: userEmail });

    if (!STRIPE_SECRET_KEY) {
      logStep("Stripe not configured, returning stripe_unavailable");
      return new Response(
        JSON.stringify({ subscribed: null, stripe_unavailable: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2025-08-27.basil",
    });

    const customers = await stripe.customers.list({ email: userEmail, limit: 1 });

    if (customers.data.length === 0) {
      logStep("No customer found, returning unsubscribed");
      return new Response(JSON.stringify({ subscribed: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const customerId = customers.data[0].id;
    logStep("Found Stripe customer", { customerId });

    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });

    const hasActiveSub = subscriptions.data.length > 0;
    let productId = null;
    let priceId = null;
    let subscriptionEnd = null;
    let cancelAtPeriodEnd = false;

    if (hasActiveSub) {
      const subscription = subscriptions.data[0];
      
      // Safely handle the date conversion
      try {
        const endTimestamp = subscription.current_period_end;
        if (endTimestamp && typeof endTimestamp === 'number') {
          subscriptionEnd = new Date(endTimestamp * 1000).toISOString();
        }
      } catch (dateError) {
        logStep("Date conversion error", { error: String(dateError) });
      }
      
      cancelAtPeriodEnd = subscription.cancel_at_period_end || false;
      priceId = subscription.items.data[0]?.price?.id;
      productId = subscription.items.data[0]?.price?.product;
      
      logStep("Active subscription found", { 
        subscriptionId: subscription.id, 
        endDate: subscriptionEnd,
        cancelAtPeriodEnd,
        productId,
        priceId,
      });
    } else {
      logStep("No active subscription found");
    }

    return new Response(JSON.stringify({
      subscribed: hasActiveSub,
      product_id: productId,
      price_id: priceId,
      subscription_end: subscriptionEnd,
      cancel_at_period_end: cancelAtPeriodEnd,
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
