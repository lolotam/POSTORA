import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[STRIPE-MANAGE] ${step}${detailsStr}`);
};

type SupabaseClient = ReturnType<typeof createClient>;

const isAdmin = async (supabase: SupabaseClient, userId: string) => {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return !!data;
};

// The caller may only act on Stripe objects recorded against their own subscription.
// Admins manage other users' subscriptions from the admin dashboard.
const assertCallerMayManage = async (
  supabase: SupabaseClient,
  userId: string,
  target: { subscription_id?: string; customer_id?: string },
) => {
  if (await isAdmin(supabase, userId)) return;

  const ownedRows = supabase.from("user_subscriptions").select("id").eq("user_id", userId);
  const { data, error } = target.subscription_id
    ? await ownedRows.eq("stripe_subscription_id", target.subscription_id).maybeSingle()
    : await ownedRows.eq("stripe_customer_id", target.customer_id ?? "").maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Subscription not found");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    if (!STRIPE_SECRET_KEY) {
      throw new Error("Stripe is not configured. Please add STRIPE_SECRET_KEY to your secrets.");
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2025-08-27.basil",
    });

    // Get the authorization header to identify the user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Get user from the token
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      throw new Error("Invalid user token");
    }

    const { action, subscription_id, customer_id } = await req.json();

    await assertCallerMayManage(supabase, user.id, { subscription_id, customer_id });

    switch (action) {
      case "cancel": {
        if (!subscription_id) {
          throw new Error("subscription_id is required for cancel action");
        }

        // Cancel at period end (not immediately)
        const subscription = await stripe.subscriptions.update(subscription_id, {
          cancel_at_period_end: true,
        });

        // Update in database
        await supabase
          .from("user_subscriptions")
          .update({ cancel_at_period_end: true })
          .eq("stripe_subscription_id", subscription_id);

        return new Response(
          JSON.stringify({ 
            success: true, 
            message: "Subscription will be cancelled at period end",
            cancel_at: subscription.cancel_at,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "cancel_now": {
        if (!subscription_id) {
          throw new Error("subscription_id is required for cancel_now action");
        }

        // Admin downgrades revoke access at once, so billing stops at once too
        const existing = await stripe.subscriptions.retrieve(subscription_id);
        if (existing.status !== "canceled") {
          await stripe.subscriptions.cancel(subscription_id);
        }

        await supabase
          .from("user_subscriptions")
          .update({
            status: "cancelled",
            cancel_at_period_end: false,
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", subscription_id);

        return new Response(
          JSON.stringify({
            success: true,
            message:
              existing.status === "canceled"
                ? "Subscription was already cancelled in Stripe"
                : "Subscription cancelled immediately",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "resume": {
        if (!subscription_id) {
          throw new Error("subscription_id is required for resume action");
        }

        // Resume subscription (uncancel)
        await stripe.subscriptions.update(subscription_id, {
          cancel_at_period_end: false,
        });

        // Update in database
        await supabase
          .from("user_subscriptions")
          .update({ cancel_at_period_end: false })
          .eq("stripe_subscription_id", subscription_id);

        return new Response(
          JSON.stringify({ 
            success: true, 
            message: "Subscription resumed",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "portal": {
        if (!customer_id) {
          throw new Error("customer_id is required for portal action");
        }

        const origin = req.headers.get("origin") || "https://postora.cloud";

        // Create a billing portal session
        const session = await stripe.billingPortal.sessions.create({
          customer: customer_id,
          return_url: `${origin}/settings`,
        });

        return new Response(
          JSON.stringify({ url: session.url }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "invoices": {
        if (!customer_id) {
          throw new Error("customer_id is required for invoices action");
        }

        // Get invoices for the customer
        const invoices = await stripe.invoices.list({
          customer: customer_id,
          limit: 10,
        });

        const formattedInvoices = invoices.data.map((invoice: Stripe.Invoice) => ({
          id: invoice.id,
          number: invoice.number,
          amount_paid: invoice.amount_paid / 100,
          currency: invoice.currency,
          status: invoice.status,
          created: new Date(invoice.created * 1000).toISOString(),
          invoice_pdf: invoice.invoice_pdf,
          hosted_invoice_url: invoice.hosted_invoice_url,
        }));

        return new Response(
          JSON.stringify({ invoices: formattedInvoices }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    console.error("Stripe manage subscription error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
