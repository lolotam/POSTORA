import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("Starting expiry reminder check...");

    if (!RESEND_API_KEY) {
      console.warn("RESEND_API_KEY not configured, skipping email sending");
      return new Response(
        JSON.stringify({ message: "Email sending not configured" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resend = new Resend(RESEND_API_KEY);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Check admin-level toggle for user expiry reminders
    const { data: settingRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "user_email_expiry_reminders")
      .maybeSingle();

    if (settingRow) {
      const parsed = typeof settingRow.value === "string" ? JSON.parse(settingRow.value) : settingRow.value;
      if (parsed === false) {
        console.log("Expiry reminder emails disabled by admin, skipping");
        return new Response(
          JSON.stringify({ message: "Expiry reminders disabled by admin", sent: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Calculate date range: 7 days from now (with 24 hour buffer)
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const eightDaysFromNow = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);

    console.log(`Checking subscriptions expiring between ${sevenDaysFromNow.toISOString()} and ${eightDaysFromNow.toISOString()}`);

    // Find active subscriptions that will expire in ~7 days
    const { data: expiringSubscriptions, error: subError } = await supabase
      .from("user_subscriptions")
      .select(`
        id,
        user_id,
        status,
        current_period_end,
        cancel_at_period_end,
        plan_id,
        subscription_plans (
          name
        )
      `)
      .eq("status", "active")
      .gte("current_period_end", sevenDaysFromNow.toISOString())
      .lt("current_period_end", eightDaysFromNow.toISOString());

    if (subError) {
      console.error("Error fetching subscriptions:", subError);
      throw subError;
    }

    console.log(`Found ${expiringSubscriptions?.length || 0} subscriptions expiring in 7 days`);

    if (!expiringSubscriptions || expiringSubscriptions.length === 0) {
      return new Response(
        JSON.stringify({ message: "No subscriptions expiring soon", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let emailsSent = 0;
    const errors: string[] = [];

    for (const subscription of expiringSubscriptions) {
      try {
        // Fetch user profile
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("email, full_name, email_notifications_enabled")
          .eq("id", subscription.user_id)
          .single();

        if (profileError || !profile?.email) {
          console.error(`Could not find profile for user ${subscription.user_id}:`, profileError);
          continue;
        }

        // Skip if user has not explicitly enabled email notifications
        if (profile.email_notifications_enabled !== true) {
          console.log(`Skipping reminder for user ${subscription.user_id} - email notifications disabled`);
          continue;
        }

        const userName = profile.full_name || "there";
        // Handle both array and single object response from Supabase join
        const subscriptionPlans = subscription.subscription_plans as { name: string } | { name: string }[] | null;
        const planName = Array.isArray(subscriptionPlans) 
          ? subscriptionPlans[0]?.name 
          : subscriptionPlans?.name || "your plan";
        const expiryDate = new Date(subscription.current_period_end!).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });

        // Different email content based on whether subscription is set to cancel
        let subject: string;
        let htmlContent: string;

        if (subscription.cancel_at_period_end) {
          subject = `Your ${planName} subscription ends in 7 days`;
          htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h1 style="color: #333;">Your Subscription is Ending Soon</h1>
              <p>Hi ${userName},</p>
              <p>Your <strong>${planName}</strong> subscription is set to end on <strong>${expiryDate}</strong>.</p>
              <p>After this date, you'll lose access to premium features including:</p>
              <ul>
                <li>Unlimited posts</li>
                <li>All social platforms</li>
                <li>AI-powered content generation</li>
                <li>Analytics and insights</li>
              </ul>
              <p>Changed your mind? You can reactivate your subscription anytime before it ends.</p>
              <a href="${SUPABASE_URL.replace('.supabase.co', '.lovable.app')}/settings" 
                 style="display: inline-block; background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 16px 0;">
                Reactivate Subscription
              </a>
              <p style="color: #666; font-size: 14px;">
                If you have any questions, just reply to this email.
              </p>
              <p>Best regards,<br>The SocialSync Team</p>
            </div>
          `;
        } else {
          subject = `Your ${planName} subscription renews in 7 days`;
          htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h1 style="color: #333;">Subscription Renewal Reminder</h1>
              <p>Hi ${userName},</p>
              <p>Just a friendly reminder that your <strong>${planName}</strong> subscription will automatically renew on <strong>${expiryDate}</strong>.</p>
              <p>No action needed - your premium features will continue without interruption.</p>
              <p>Need to update your payment method or manage your subscription?</p>
              <a href="${SUPABASE_URL.replace('.supabase.co', '.lovable.app')}/settings" 
                 style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 16px 0;">
                Manage Subscription
              </a>
              <p style="color: #666; font-size: 14px;">
                Thank you for being a valued subscriber!
              </p>
              <p>Best regards,<br>The SocialSync Team</p>
            </div>
          `;
        }

        // Send the email
        const { error: emailError } = await resend.emails.send({
          from: "Postora <support@postora.cloud>",
          to: [profile.email],
          subject,
          html: htmlContent,
        });

        if (emailError) {
          console.error(`Failed to send email to ${profile.email}:`, emailError);
          errors.push(`${profile.email}: ${emailError.message}`);
        } else {
          console.log(`Sent reminder email to ${profile.email}`);
          emailsSent++;
        }
      } catch (err) {
        console.error(`Error processing subscription ${subscription.id}:`, err);
        errors.push(`Subscription ${subscription.id}: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }

    console.log(`Finished sending ${emailsSent} reminder emails`);

    return new Response(
      JSON.stringify({
        message: `Sent ${emailsSent} reminder emails`,
        sent: emailsSent,
        total: expiringSubscriptions.length,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in send-expiry-reminders:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
