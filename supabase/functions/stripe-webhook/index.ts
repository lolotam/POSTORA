import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";

import {
  mapStripeSubscriptionStatus,
  type PermittedSubscriptionStatus,
} from "./subscriptionStatus.ts";
import { shouldClearQuotaOverrides } from "./overrideClearing.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");

// Price ID to plan slug mapping - Updated for new Stripe account
const PRICE_TO_PLAN: Record<string, string> = {
  // Pro plan prices
  "price_1SpPKL0hJJ11XlNONGaoHAI0": "pro",  // $19.99/month
  "price_1SpPL30hJJ11XlNO2wGUQHSn": "pro",  // $199.99/year
  // Business plan prices
  "price_1SpPLX0hJJ11XlNOuaId2Dfy": "business",  // $49.99/month
  "price_1SpPLj0hJJ11XlNOqjV6RUAz": "business",  // $499.99/year
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
  console.log(`[STRIPE-WEBHOOK] ${step}${detailsStr}`);
};

// Helper to log webhook events to system_logs
// deno-lint-ignore no-explicit-any
async function logWebhookEvent(
  supabase: any,
  level: "info" | "warn" | "error",
  eventType: string,
  message: string,
  metadata?: Record<string, unknown>,
  userId?: string
): Promise<void> {
  try {
    // Enrich metadata with user context if userId is available
    let enrichedMetadata = metadata || {};
    if (userId) {
      try {
        const { data: profile } = await supabase
          .from("profiles")
          .select("email, full_name")
          .eq("id", userId)
          .maybeSingle();
        if (profile) {
          enrichedMetadata = {
            ...enrichedMetadata,
            user: { email: profile.email, full_name: profile.full_name },
          };
        }
      } catch { /* skip enrichment on error */ }
    }

    await supabase.from("system_logs").insert({
      level,
      source: "stripe-webhook",
      category: "payment",
      message: `[${eventType}] ${message}`,
      user_id: userId || null,
      metadata: enrichedMetadata,
    });
  } catch (error) {
    console.error("Failed to log webhook event:", error);
  }
}

// Helper to send admin alert for critical failures
async function sendWebhookFailureAlert(
  eventType: string,
  errorMessage: string,
  eventId?: string
): Promise<void> {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/send-subscription-email`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          type: "webhook_failure",
          email: "admin@postora.cloud", // Admin email for alerts
          data: {
            event_type: eventType,
            error_message: errorMessage,
            event_id: eventId,
            timestamp: new Date().toISOString(),
          },
        }),
      }
    );

    if (!response.ok) {
      console.error("Failed to send webhook failure alert");
    }
  } catch (error) {
    console.error("Error sending webhook failure alert:", error);
  }
}

// Helper to send subscription emails
async function sendSubscriptionEmail(
  type: string,
  userId: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/send-subscription-email`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ type, user_id: userId, data }),
      }
    );
    
    if (!response.ok) {
      const error = await response.text();
      console.error("Failed to send email:", error);
    } else {
      logStep(`Sent ${type} email to user ${userId}`);
    }
  } catch (error) {
    console.error("Error sending email:", error);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200 });
  }

  let currentEventId: string | undefined;
  try {
    logStep("Webhook received");

    if (!STRIPE_WEBHOOK_SECRET) {
      console.error("Stripe webhook signing secret is not configured");
      return new Response(JSON.stringify({ error: "Webhook is not configured" }), { status: 500 });
    }

    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      return new Response(JSON.stringify({ error: "Missing signature" }), { status: 400 });
    }

    if (!STRIPE_SECRET_KEY) {
      throw new Error("Stripe is not configured");
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2025-08-27.basil",
    });

    const body = await req.text();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET);
      logStep("Signature verified");
    } catch {
      logStep("Webhook signature verification failed");
      return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Idempotency: insert a dedupe row keyed by event.id BEFORE running any
    // side effects. If Stripe retries the same event, the PK conflict means
    // we've already processed (or attempted) it — return 200 immediately so
    // Stripe stops retrying, and skip re-running handlers.
    currentEventId = event.id;
    const { error: dedupeErr } = await supabase
      .from("stripe_webhook_events")
      .insert({ event_id: event.id, event_type: event.type, status: "received" });

    if (dedupeErr) {
      const code = (dedupeErr as { code?: string }).code;
      if (code === "23505") {
        // Already seen. If a prior attempt succeeded, skip. If it failed,
        // allow Stripe's retry to re-run the handler.
        const { data: prior } = await supabase
          .from("stripe_webhook_events")
          .select("status")
          .eq("event_id", event.id)
          .maybeSingle();
        if (prior?.status === "processed") {
          logStep("Duplicate event already processed, skipping", { eventId: event.id });
          return new Response(JSON.stringify({ received: true, duplicate: true }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        logStep("Retrying previously failed event", { eventId: event.id, priorStatus: prior?.status });
      } else {
        logStep("Dedupe insert failed (non-conflict)", { error: dedupeErr });
      }
    }

    // Track resolved user_id across event handling for final logging
    let resolvedUserId: string | undefined;

    // Log all webhook events to system_logs for monitoring
    await logWebhookEvent(supabase, "info", event.type, `Received webhook event`, { eventId: event.id });

    logStep("Processing event", { type: event.type });

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        
        const userId = session.metadata?.user_id;
        const planId = session.metadata?.plan_id;
        const planSlug = session.metadata?.plan_slug;
        const planName = session.metadata?.plan_name;
        const couponId = session.metadata?.coupon_id;
        const referralCode = session.metadata?.referral_code;
        
        if (!userId || !planId) {
          logStep("Missing user_id or plan_id in session metadata");
          break;
        }

        resolvedUserId = userId;
        logStep("Checkout completed", { userId, planId, planSlug });

        // Create or update the subscription
        const { error: subError } = await supabase
          .from("user_subscriptions")
          .upsert({
            user_id: userId,
            plan_id: planId,
            status: "active",
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
            coupon_id: couponId || null,
            current_period_start: new Date().toISOString(),
            current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          }, {
            onConflict: "user_id",
          });

        if (subError) {
          logStep("Error creating subscription", { error: subError });
        }

        // Update user role to subscriber
        const { data: existingRole, error: roleLookupError } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userId)
          .maybeSingle();

        if (roleLookupError) {
          logStep("Role lookup failed", { userId, error: roleLookupError });
        }

        if (!existingRole || existingRole.role === "user") {
          const { error: roleUpsertError } = await supabase
            .from("user_roles")
            .upsert({
              user_id: userId,
              role: "subscriber",
            }, {
              onConflict: "user_id",
            });

          if (roleUpsertError) {
            logStep("Role update to subscriber failed", { userId, error: roleUpsertError });
          }
        }

        // New subscription = clear any overrides so the plan resolves through
        // the arbiter — but only if the subscription upsert above actually
        // landed. On a failed write plan_id never moved, and the existing
        // override is what still describes the customer's entitlements.
        // Checkout is the create path: previousPlanId is null because the
        // upsert itself establishes the plan.
        const clearCheckoutOverrides = shouldClearQuotaOverrides({
          previousPlanId: null,
          resolvedPlanId: planId,
          subscriptionWriteFailed: Boolean(subError),
        });

        if (!clearCheckoutOverrides) {
          logStep(
            "Skipping quota override clear: subscription write failed, stale override kept as the customer's safety net",
            { userId, planId, subscriptionError: subError },
          );
        } else {
          const quotas = CLEARED_QUOTA_OVERRIDES;

          // First try to update, if no rows affected, insert new record
          const { data: existingQuota, error: quotaLookupError } = await supabase
            .from("user_quotas")
            .select("id")
            .eq("user_id", userId)
            .maybeSingle();

          if (quotaLookupError) {
            logStep("Quota lookup failed", { userId, error: quotaLookupError });
          }

          if (existingQuota) {
            const { error: quotaUpdateError } = await supabase
              .from("user_quotas")
              .update(quotas)
              .eq("user_id", userId);

            if (quotaUpdateError) {
              logStep("Quota override clear failed", { userId, error: quotaUpdateError });
            }
          } else {
            const { error: quotaInsertError } = await supabase
              .from("user_quotas")
              .insert({
                user_id: userId,
                ...quotas,
              });

            if (quotaInsertError) {
              logStep("Quota row insert failed", { userId, error: quotaInsertError });
            }
          }

          logStep(`Subscription created for user ${userId} on plan ${planSlug}`, { quotas });
        }

        // Process referral if present
        if (referralCode) {
          logStep("Processing referral", { referralCode });
          
          const { data: referrer } = await supabase
            .from("profiles")
            .select("id")
            .eq("referral_code", referralCode)
            .single();

          if (referrer && referrer.id !== userId) {
            const { error: refError } = await supabase
              .from("referrals")
              .insert({
                referrer_id: referrer.id,
                referred_user_id: userId,
                referral_code: referralCode,
                status: "completed",
                reward_amount: 10.00,
                completed_at: new Date().toISOString(),
              });

            if (refError) {
              logStep("Error creating referral", { error: refError });
            } else {
              logStep(`Referral completed: ${referrer.id} referred ${userId}`);
              
              await supabase
                .from("profiles")
                .update({ referred_by: referrer.id })
                .eq("id", userId);
            }
          }
        }

        // Send welcome email
        await sendSubscriptionEmail("subscription_created", userId, { plan_name: planName });
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        
        const { data: userSub, error: userSubError } = await supabase
          .from("user_subscriptions")
          .select("user_id, plan_id")
          .eq("stripe_subscription_id", subscription.id)
          .maybeSingle();

        if (userSubError) {
          logStep("Subscription lookup failed", { subscriptionId: subscription.id, error: userSubError });
        }

        if (userSub) {
          resolvedUserId = userSub.user_id;
          // Get the price ID from the subscription to determine plan
          const priceId = subscription.items?.data?.[0]?.price?.id;
          const newPlanSlug = priceId ? PRICE_TO_PLAN[priceId] : null;

          logStep("Subscription updated", { 
            subscriptionId: subscription.id, 
            status: subscription.status,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            newPlanSlug,
          });

          // Resolve the event's plan slug to a subscription_plans.id. This
          // block must run on every plan-bearing event: without writing
          // plan_id, an upgrading customer silently inherits their OLD plan,
          // because the arbiter resolves entitlements from
          // user_subscriptions.plan_id.
          let newPlanId: string | null = null;
          if (newPlanSlug) {
            const { data: planRow, error: planError } = await supabase
              .from("subscription_plans")
              .select("id")
              .eq("slug", newPlanSlug)
              .maybeSingle();

            if (planError) {
              logStep("Plan lookup by slug failed", { newPlanSlug, error: planError });
            } else {
              newPlanId = planRow?.id ?? null;
              if (!newPlanId) {
                logStep("No subscription_plans row for slug", { newPlanSlug });
              }
            }
          }

          // plan_id moves only on a REAL plan change, decided by comparing
          // against the stored row (Round-1 amendment A3). The override
          // clear below reuses this via shouldClearQuotaOverrides(), which
          // additionally refuses to clear when this update write fails.
          const changedPlanId =
            newPlanId !== null && newPlanId !== userSub.plan_id
              ? newPlanId
              : null;

          const subscriptionUpdate: {
            status: PermittedSubscriptionStatus;
            current_period_start: string;
            current_period_end: string;
            cancel_at_period_end: boolean;
            plan_id?: string;
          } = {
            status: mapStripeSubscriptionStatus(subscription.status),
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            cancel_at_period_end: subscription.cancel_at_period_end,
          };
          if (changedPlanId) {
            subscriptionUpdate.plan_id = changedPlanId;
          }

          const { error: subUpdateError } = await supabase
            .from("user_subscriptions")
            .update(subscriptionUpdate)
            .eq("stripe_subscription_id", subscription.id);

          if (subUpdateError) {
            logStep("Subscription update failed", { subscriptionId: subscription.id, error: subUpdateError });
          }

          // Clear overrides only when the plan really changed AND the
          // subscription update above landed. On a failed write plan_id
          // never moved, so the stale override stays as the customer's
          // safety net. This event also fires for ordinary renewals and
          // payment-method changes; clearing there would erase deliberate
          // admin overrides (spec R4a).
          const clearUpdateOverrides = shouldClearQuotaOverrides({
            previousPlanId: userSub.plan_id,
            resolvedPlanId: newPlanId,
            subscriptionWriteFailed: Boolean(subUpdateError),
          });

          if (clearUpdateOverrides) {
            const quotas = CLEARED_QUOTA_OVERRIDES;

            const { data: existingQuota, error: quotaLookupError } = await supabase
              .from("user_quotas")
              .select("id")
              .eq("user_id", userSub.user_id)
              .maybeSingle();

            if (quotaLookupError) {
              logStep("Quota lookup failed", { userId: userSub.user_id, error: quotaLookupError });
            }

            if (existingQuota) {
              const { error: quotaUpdateError } = await supabase
                .from("user_quotas")
                .update(quotas)
                .eq("user_id", userSub.user_id);

              if (quotaUpdateError) {
                logStep("Quota override clear failed", { userId: userSub.user_id, error: quotaUpdateError });
              }
            } else {
              const { error: quotaInsertError } = await supabase
                .from("user_quotas")
                .insert({
                  user_id: userSub.user_id,
                  ...quotas,
                });

              if (quotaInsertError) {
                logStep("Quota row insert failed", { userId: userSub.user_id, error: quotaInsertError });
              }
            }
            logStep(`Plan changed to ${newPlanSlug} for user ${userSub.user_id}, overrides cleared`);
          } else if (changedPlanId && subUpdateError) {
            logStep(
              "Skipping quota override clear: subscription write failed, stale override kept as the customer's safety net",
              { userId: userSub.user_id, plannedPlanId: changedPlanId, subscriptionError: subUpdateError },
            );
          }

          // Send cancellation email if user cancelled
          if (subscription.cancel_at_period_end) {
            const endDate = new Date(subscription.current_period_end * 1000).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            });
            await sendSubscriptionEmail("subscription_cancelled", userSub.user_id, { end_date: endDate });
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        
        const { data: userSub, error: userSubError } = await supabase
          .from("user_subscriptions")
          .select("user_id")
          .eq("stripe_subscription_id", subscription.id)
          .maybeSingle();

        if (userSubError) {
          logStep("Subscription lookup failed", { subscriptionId: subscription.id, error: userSubError });
        }

        if (userSub) {
          resolvedUserId = userSub.user_id;
          logStep("Subscription deleted", { userId: userSub.user_id });

          // "cancelled" with two Ls — user_subscriptions_status_check
          // rejects Stripe's one-L "canceled".
          const { error: subUpdateError } = await supabase
            .from("user_subscriptions")
            .update({ status: "cancelled" })
            .eq("stripe_subscription_id", subscription.id);

          if (subUpdateError) {
            logStep("Subscription cancellation write failed", { subscriptionId: subscription.id, error: subUpdateError });
          }

          const { error: roleUpdateError } = await supabase
            .from("user_roles")
            .update({ role: "user" })
            .eq("user_id", userSub.user_id);

          if (roleUpdateError) {
            logStep("Role downgrade to user failed", { userId: userSub.user_id, error: roleUpdateError });
          }

          // Cancellation clears overrides; the arbiter then resolves the
          // non-active subscription to the free plan.
          const quotas = CLEARED_QUOTA_OVERRIDES;

          const { data: existingQuota, error: quotaLookupError } = await supabase
            .from("user_quotas")
            .select("id")
            .eq("user_id", userSub.user_id)
            .maybeSingle();

          if (quotaLookupError) {
            logStep("Quota lookup failed", { userId: userSub.user_id, error: quotaLookupError });
          }

          if (existingQuota) {
            const { error: quotaUpdateError } = await supabase
              .from("user_quotas")
              .update(quotas)
              .eq("user_id", userSub.user_id);

            if (quotaUpdateError) {
              logStep("Quota override clear failed", { userId: userSub.user_id, error: quotaUpdateError });
            }
          } else {
            const { error: quotaInsertError } = await supabase
              .from("user_quotas")
              .insert({
                user_id: userSub.user_id,
                ...quotas,
              });

            if (quotaInsertError) {
              logStep("Quota row insert failed", { userId: userSub.user_id, error: quotaInsertError });
            }
          }

          logStep(`Subscription cancelled for user ${userSub.user_id}, quota overrides cleared`);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        
        if (invoice.subscription) {
          const { data: userSub } = await supabase
            .from("user_subscriptions")
            .select("user_id")
            .eq("stripe_subscription_id", invoice.subscription as string)
            .single();

          if (userSub) {
            resolvedUserId = userSub.user_id;
            logStep("Payment failed", { userId: userSub.user_id, invoiceId: invoice.id });

            await supabase
              .from("user_subscriptions")
              .update({ status: "past_due" })
              .eq("stripe_subscription_id", invoice.subscription as string);

            await sendSubscriptionEmail("payment_failed", userSub.user_id, {});
          }
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        logStep("Payment succeeded", { invoiceId: invoice.id });
        break;
      }

      default:
        logStep(`Unhandled event type: ${event.type}`);
        await logWebhookEvent(supabase, "warn", event.type, `Unhandled event type`, undefined, resolvedUserId);
    }

    // Log successful processing
    await logWebhookEvent(supabase, "info", event.type, `Successfully processed`, { eventId: event.id }, resolvedUserId);

    // Mark dedupe row processed.
    await supabase
      .from("stripe_webhook_events")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("event_id", event.id);

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logStep("ERROR", { message: errorMessage });
    
    // Log error to database and send admin alert
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await logWebhookEvent(supabase, "error", "webhook_error", errorMessage);

      // Mark dedupe row failed so Stripe's retry can re-run the handler.
      if (currentEventId) {
        await supabase
          .from("stripe_webhook_events")
          .update({ status: "failed", error: errorMessage.slice(0, 1000) })
          .eq("event_id", currentEventId);
      }

      // Send admin alert for critical failures
      await sendWebhookFailureAlert("webhook_error", errorMessage);
    } catch (logError) {
      console.error("Failed to log error:", logError);
    }
    
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500 }
    );
  }
});
