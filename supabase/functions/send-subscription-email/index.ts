import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

interface EmailPayload {
  type: "subscription_created" | "subscription_cancelled" | "subscription_upgraded" | "subscription_downgraded" | "payment_failed" | "subscription_expiring" | "credits_purchased" | "webhook_failure" | "post_failed";
  user_id?: string;
  email?: string; // For admin alerts
  data?: Record<string, unknown>;
}

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[SEND-SUBSCRIPTION-EMAIL] ${step}${detailsStr}`);
};

// Email template header
const getEmailHeader = () => `
  <div style="background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%); padding: 30px 20px; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 28px; font-family: Arial, sans-serif;">Postora</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 5px 0 0 0; font-size: 14px;">Social Media Scheduling Made Easy</p>
  </div>
`;

// Email template footer
const getEmailFooter = () => `
  <div style="background: #1a1a2e; padding: 30px 20px; text-align: center; margin-top: 30px;">
    <p style="color: #a0aec0; margin: 0 0 10px 0; font-size: 14px;">
      Need help? <a href="https://postora.cloud/contact" style="color: #8b5cf6;">Contact our support team</a>
    </p>
    <p style="color: #718096; margin: 0; font-size: 12px;">
      © ${new Date().getFullYear()} Postora. All rights reserved.
    </p>
    <div style="margin-top: 15px;">
      <a href="https://postora.cloud" style="color: #718096; text-decoration: none; font-size: 12px; margin: 0 10px;">Website</a>
      <a href="https://postora.cloud/settings" style="color: #718096; text-decoration: none; font-size: 12px; margin: 0 10px;">Settings</a>
      <a href="https://postora.cloud/privacy" style="color: #718096; text-decoration: none; font-size: 12px; margin: 0 10px;">Privacy</a>
    </div>
  </div>
`;

// CTA button style
const ctaButtonStyle = `
  background: linear-gradient(to right, #8b5cf6, #ec4899); 
  color: white; 
  padding: 14px 28px; 
  border-radius: 8px; 
  text-decoration: none; 
  display: inline-block; 
  font-weight: bold;
  font-size: 16px;
`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    if (!RESEND_API_KEY) {
      logStep("RESEND_API_KEY not configured, skipping email");
      return new Response(
        JSON.stringify({ success: false, message: "Email not configured" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const payload: EmailPayload = await req.json();
    const { type, user_id, email: directEmail, data } = payload;

    logStep(`Processing ${type} email`, { user_id, directEmail, data });

    // Check admin-level toggle for user subscription emails
    const { data: subSettingRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "user_email_subscription_changes")
      .maybeSingle();

    if (subSettingRow) {
      const parsed = typeof subSettingRow.value === "string" ? JSON.parse(subSettingRow.value) : subSettingRow.value;
      if (parsed === false) {
        logStep("Subscription change emails disabled by admin, skipping");
        return new Response(
          JSON.stringify({ success: true, message: "Subscription emails disabled by admin" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    let userEmail: string;
    let userName = "there";

    // For webhook_failure, use direct email instead of looking up user
    if (type === "webhook_failure" && directEmail) {
      userEmail = directEmail;
      userName = "Admin";
    } else if (user_id) {
      // Get user profile
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("email, full_name, email_notifications_enabled")
        .eq("id", user_id)
        .single();

      if (profileError || !profile?.email) {
        logStep("Could not find user profile", { error: profileError });
        return new Response(
          JSON.stringify({ success: false, message: "User not found" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Skip if user has not explicitly enabled email notifications
      if (profile.email_notifications_enabled !== true) {
        logStep("Email notifications disabled for user, skipping", { user_id });
        return new Response(
          JSON.stringify({ success: true, message: "Email notifications disabled by user" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      userName = profile.full_name || "there";
      userEmail = profile.email;
    } else {
      logStep("No user_id or email provided");
      return new Response(
        JSON.stringify({ success: false, message: "No recipient specified" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    logStep("Recipient found", { email: userEmail, name: userName });

    let subject = "";
    let bodyContent = "";

    switch (type) {
      case "subscription_created":
        subject = "🎉 Welcome to Postora Pro!";
        bodyContent = `
          <div style="padding: 30px 20px;">
            <h2 style="color: #8b5cf6; margin-top: 0;">Welcome to the Pro Family!</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">Hey ${userName},</p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Thank you for subscribing to <strong style="color: #8b5cf6;">${data?.plan_name || "Pro"}</strong>! 🚀
            </p>
            <div style="background: #f8f4ff; border-radius: 12px; padding: 20px; margin: 25px 0;">
              <p style="color: #333; margin: 0 0 15px 0; font-weight: bold;">You now have access to:</p>
              <ul style="color: #555; margin: 0; padding-left: 20px; line-height: 1.8;">
                <li>✓ Unlimited social profiles</li>
                <li>✓ Higher posting limits</li>
                <li>✓ AI-powered caption & hashtag generation</li>
                <li>✓ Advanced analytics & insights</li>
                <li>✓ Priority support</li>
              </ul>
            </div>
            <p style="text-align: center; margin-top: 30px;">
              <a href="https://postora.cloud/create" style="${ctaButtonStyle}">Create Your First Post</a>
            </p>
          </div>
        `;
        break;

      case "credits_purchased":
        subject = "⚡ AI Credits Added to Your Account!";
        bodyContent = `
          <div style="padding: 30px 20px;">
            <h2 style="color: #8b5cf6; margin-top: 0;">Credits Added Successfully!</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">Hey ${userName},</p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Your purchase was successful! We've added credits to your account.
            </p>
            <div style="background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%); border-radius: 12px; padding: 25px; margin: 25px 0; text-align: center;">
              <p style="color: rgba(255,255,255,0.9); margin: 0 0 5px 0; font-size: 14px;">Credits Added</p>
              <p style="color: white; margin: 0; font-size: 42px; font-weight: bold;">+${data?.credits || 0}</p>
              <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 14px;">
                New Balance: <strong>${data?.new_balance || 0}</strong> credits
              </p>
            </div>
            <div style="background: #f8f4ff; border-radius: 12px; padding: 20px; margin: 25px 0;">
              <p style="color: #333; margin: 0 0 10px 0; font-weight: bold;">Use your credits for:</p>
              <ul style="color: #555; margin: 0; padding-left: 20px; line-height: 1.8;">
                <li>🎨 AI Caption Generation (1 credit)</li>
                <li>#️⃣ AI Hashtag Suggestions (1 credit)</li>
                <li>🖼️ AI Image Generation (5 credits)</li>
              </ul>
            </div>
            <p style="text-align: center; margin-top: 30px;">
              <a href="https://postora.cloud/create" style="${ctaButtonStyle}">Start Creating</a>
            </p>
          </div>
        `;
        break;

      case "subscription_upgraded":
        subject = "🎉 You've upgraded your plan!";
        bodyContent = `
          <div style="padding: 30px 20px;">
            <h2 style="color: #8b5cf6; margin-top: 0;">Plan Upgraded!</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">Hey ${userName},</p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Your subscription has been upgraded to <strong style="color: #8b5cf6;">${data?.new_plan || "a higher tier"}</strong>!
            </p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              You now have access to even more features. Check out what's new in your dashboard.
            </p>
            <p style="text-align: center; margin-top: 30px;">
              <a href="https://postora.cloud/settings" style="${ctaButtonStyle}">View Your Plan</a>
            </p>
          </div>
        `;
        break;

      case "subscription_downgraded":
        subject = "Your plan has been changed";
        bodyContent = `
          <div style="padding: 30px 20px;">
            <h2 style="color: #8b5cf6; margin-top: 0;">Plan Changed</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">Hey ${userName},</p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Your subscription has been changed to <strong>${data?.new_plan || "a different tier"}</strong>.
            </p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Some features may no longer be available. If this wasn't intentional, you can upgrade anytime.
            </p>
            <p style="text-align: center; margin-top: 30px;">
              <a href="https://postora.cloud/pricing" style="${ctaButtonStyle}">View Plans</a>
            </p>
          </div>
        `;
        break;

      case "subscription_cancelled":
        subject = "😢 We're sorry to see you go";
        bodyContent = `
          <div style="padding: 30px 20px;">
            <h2 style="color: #f59e0b; margin-top: 0;">Subscription Cancelled</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">Hey ${userName},</p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Your subscription has been cancelled and will end on <strong>${data?.end_date || "the end of your billing period"}</strong>.
            </p>
            <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 15px 20px; margin: 20px 0;">
              <p style="color: #92400e; margin: 0;">
                You'll continue to have access to premium features until then.
              </p>
            </div>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              We'd love to have you back! If you change your mind, you can resubscribe anytime.
            </p>
            <p style="text-align: center; margin-top: 30px;">
              <a href="https://postora.cloud/pricing" style="${ctaButtonStyle}">Resubscribe</a>
            </p>
          </div>
        `;
        break;

      case "payment_failed":
        subject = "⚠️ Payment Failed - Action Required";
        bodyContent = `
          <div style="padding: 30px 20px;">
            <h2 style="color: #ef4444; margin-top: 0;">Payment Failed</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">Hey ${userName},</p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              We couldn't process your latest payment for your Postora subscription.
            </p>
            <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 15px 20px; margin: 20px 0;">
              <p style="color: #991b1b; margin: 0;">
                Please update your payment method to avoid any interruption to your service.
              </p>
            </div>
            <p style="text-align: center; margin-top: 30px;">
              <a href="https://postora.cloud/settings" style="background: #ef4444; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: bold;">Update Payment Method</a>
            </p>
          </div>
        `;
        break;

      case "subscription_expiring":
        subject = "⏰ Your subscription is expiring soon";
        bodyContent = `
          <div style="padding: 30px 20px;">
            <h2 style="color: #f59e0b; margin-top: 0;">Subscription Expiring</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">Hey ${userName},</p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Your Postora subscription will expire on <strong>${data?.end_date || "soon"}</strong>.
            </p>
            <div style="background: #f8f4ff; border-radius: 12px; padding: 20px; margin: 25px 0;">
              <p style="color: #333; margin: 0 0 10px 0; font-weight: bold;">Don't lose access to:</p>
              <ul style="color: #555; margin: 0; padding-left: 20px; line-height: 1.8;">
                <li>AI-powered content generation</li>
                <li>Unlimited scheduling</li>
                <li>Advanced analytics</li>
                <li>Priority support</li>
              </ul>
            </div>
            <p style="text-align: center; margin-top: 30px;">
              <a href="https://postora.cloud/pricing" style="${ctaButtonStyle}">Renew Subscription</a>
            </p>
          </div>
        `;
        break;

      case "webhook_failure":
        subject = "🚨 Stripe Webhook Failure Alert";
        bodyContent = `
          <div style="padding: 30px 20px;">
            <h2 style="color: #ef4444; margin-top: 0;">Webhook Processing Failed</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">Hey ${userName},</p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              A Stripe webhook event failed to process correctly. This may require your attention.
            </p>
            <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 20px; margin: 25px 0;">
              <p style="color: #991b1b; margin: 0 0 15px 0; font-weight: bold;">Error Details:</p>
              <table style="width: 100%; color: #374151; font-size: 14px;">
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #fecaca; font-weight: 600;">Event Type:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #fecaca;">${data?.event_type || "Unknown"}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #fecaca; font-weight: 600;">Event ID:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #fecaca; font-family: monospace; font-size: 12px;">${data?.event_id || "N/A"}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #fecaca; font-weight: 600;">Error:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #fecaca; color: #dc2626;">${data?.error_message || "Unknown error"}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: 600;">Timestamp:</td>
                  <td style="padding: 8px 0;">${data?.timestamp || new Date().toISOString()}</td>
                </tr>
              </table>
            </div>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              Please check your Stripe Dashboard and system logs for more details.
            </p>
            <p style="text-align: center; margin-top: 30px;">
              <a href="https://dashboard.stripe.com/webhooks" style="background: #ef4444; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: bold;">View Stripe Webhooks</a>
            </p>
          </div>
        `;
        break;

      case "post_failed": {
        const failedPlatforms = (data?.failed_platforms as Array<{ platform: string; error: string }>) || [];
        const successPlatforms = (data?.success_platforms as string[]) || [];
        const postCaption = (data?.caption as string) || "Your post";
        const truncatedCaption = postCaption.length > 100 ? postCaption.substring(0, 100) + "..." : postCaption;
        
        subject = "❌ Post Publishing Failed";
        bodyContent = `
          <div style="padding: 30px 20px;">
            <h2 style="color: #ef4444; margin-top: 0;">Post Publishing Failed</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">Hey ${userName},</p>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              We encountered issues publishing your post to some platforms.
            </p>
            
            <div style="background: #f8f4ff; border-radius: 12px; padding: 20px; margin: 20px 0;">
              <p style="color: #555; margin: 0; font-style: italic;">"${truncatedCaption}"</p>
            </div>
            
            ${failedPlatforms.length > 0 ? `
              <div style="background: #fef2f2; border-left: 4px solid #ef4444; border-radius: 8px; padding: 15px 20px; margin: 20px 0;">
                <p style="color: #991b1b; margin: 0 0 15px 0; font-weight: bold;">❌ Failed Platforms:</p>
                ${failedPlatforms.map(p => `
                  <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #fecaca;">
                    <p style="color: #dc2626; margin: 0 0 5px 0; font-weight: 600; text-transform: capitalize;">${p.platform}</p>
                    <p style="color: #7f1d1d; margin: 0; font-size: 14px;">${p.error || "Unknown error"}</p>
                  </div>
                `).join("")}
              </div>
            ` : ""}
            
            ${successPlatforms.length > 0 ? `
              <div style="background: #f0fdf4; border-left: 4px solid #22c55e; border-radius: 8px; padding: 15px 20px; margin: 20px 0;">
                <p style="color: #166534; margin: 0; font-weight: bold;">✅ Successfully Published:</p>
                <p style="color: #15803d; margin: 10px 0 0 0; text-transform: capitalize;">${successPlatforms.join(", ")}</p>
              </div>
            ` : ""}
            
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              You can retry publishing from your History page.
            </p>
            
            <p style="text-align: center; margin-top: 30px;">
              <a href="https://postora.cloud/history" style="background: #ef4444; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: bold;">View Post & Retry</a>
            </p>
          </div>
        `;
        break;
      }

      default:
        logStep(`Unknown email type: ${type}`);
        return new Response(
          JSON.stringify({ success: false, message: "Unknown email type" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // Build full HTML email
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f5;">
        <div style="max-width: 600px; margin: 0 auto; background: white;">
          ${getEmailHeader()}
          ${bodyContent}
          ${getEmailFooter()}
        </div>
      </body>
      </html>
    `;

    // Send email via Resend API
    logStep("Sending email via Resend", { to: userEmail, subject });

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Postora <notifications@postora.cloud>",
        to: [userEmail],
        subject,
        html,
      }),
    });

    const emailResult = await emailResponse.json();
    
    if (!emailResponse.ok) {
      logStep("Resend API error", emailResult);
      throw new Error(emailResult.message || "Failed to send email");
    }

    logStep("Email sent successfully", { id: emailResult.id });

    return new Response(
      JSON.stringify({ success: true, id: emailResult.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logStep("ERROR", { message: errorMessage });
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
