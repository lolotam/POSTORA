import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { verifyCronAuth } from "../_shared/cron-auth.ts";

import { restrictedCorsHeaders } from "../_shared/cors.ts";

const PLATFORM_DISPLAY_NAMES: Record<string, string> = {
  youtube: "YouTube",
  twitter: "Twitter/X",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  threads: "Threads",
  bluesky: "Bluesky",
  reddit: "Reddit",
};

// Token expiry thresholds per platform (in hours)
const TOKEN_EXPIRY_THRESHOLDS: Record<string, number> = {
  youtube: 168,    // 7 days
  twitter: 168,    // 7 days
  facebook: 168,   // 7 days
  instagram: 168,  // 7 days
  tiktok: 24,      // 1 day (short-lived tokens)
  linkedin: 168,   // 7 days
  pinterest: 168,  // 7 days
  threads: 24,     // 1 day (short-lived like TikTok)
  bluesky: 72,     // 3 days
  reddit: 24,      // 1 day
};

interface ExpiringAccount {
  id: string;
  platform: string;
  platform_username: string | null;
  token_expires_at: string;
  user_id: string;
  needs_reauth: boolean;
  last_alert_sent_at: string | null;
}

function getPlatformDisplayName(platform: string): string {
  return PLATFORM_DISPLAY_NAMES[platform.toLowerCase()] || platform;
}

function generateExpiryWarningEmail(
  accounts: ExpiringAccount[],
  userName: string
): string {
  const accountsHtml = accounts
    .map((account) => {
      const platformName = getPlatformDisplayName(account.platform);
      const expiresAt = new Date(account.token_expires_at);
      const hoursLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60)));
      const daysLeft = Math.ceil(hoursLeft / 24);
      
      let timeText = "";
      let urgencyColor = "#f59e0b"; // amber
      
      if (hoursLeft <= 0) {
        timeText = "Expired";
        urgencyColor = "#ef4444"; // red
      } else if (hoursLeft < 24) {
        timeText = `${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}`;
        urgencyColor = "#ef4444"; // red
      } else {
        timeText = `${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
      }

      return `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
            <strong>${platformName}</strong><br>
            <span style="color: #6b7280; font-size: 13px;">${account.platform_username || "Unknown"}</span>
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">
            <span style="color: ${urgencyColor}; font-weight: 600;">${timeText}</span>
          </td>
        </tr>
      `;
    })
    .join("");

  const multipleAccounts = accounts.length > 1;
  const criticalCount = accounts.filter(a => {
    const hoursLeft = Math.ceil((new Date(a.token_expires_at).getTime() - Date.now()) / (1000 * 60 * 60));
    return hoursLeft <= 24;
  }).length;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
      <table cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <tr>
          <td style="padding: 32px 24px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);">
            <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700;">
              ⏰ ${multipleAccounts ? `${accounts.length} Accounts` : "Account"} Expiring Soon
            </h1>
            <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">
              ${criticalCount > 0 ? `${criticalCount} expire${criticalCount === 1 ? "s" : ""} within 24 hours!` : "Action recommended soon"}
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding: 24px;">
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              Hi ${userName},
            </p>
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              ${multipleAccounts 
                ? "Some of your connected social accounts have tokens that will expire soon." 
                : "One of your connected social accounts has a token that will expire soon."}
              To keep posting without interruption, please refresh ${multipleAccounts ? "these connections" : "this connection"}.
            </p>
            
            <table cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; margin: 24px 0;">
              <thead>
                <tr style="background-color: #f9fafb;">
                  <th style="padding: 12px; text-align: left; font-size: 12px; text-transform: uppercase; color: #6b7280; font-weight: 600;">Account</th>
                  <th style="padding: 12px; text-align: right; font-size: 12px; text-transform: uppercase; color: #6b7280; font-weight: 600;">Expires In</th>
                </tr>
              </thead>
              <tbody>
                ${accountsHtml}
              </tbody>
            </table>
            
            <div style="margin: 24px 0; text-align: center;">
              <a href="https://postora.cloud/connection-health" style="display: inline-block; padding: 14px 32px; background-color: #3b82f6; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                Refresh Connections Now
              </a>
            </div>
            
            <div style="margin: 24px 0; padding: 16px; background-color: #eff6ff; border-radius: 8px; border-left: 4px solid #3b82f6;">
              <p style="margin: 0; color: #1e40af; font-size: 14px;">
                <strong>💡 Tip:</strong> Regularly visiting your Connection Health page helps keep all your accounts connected and ready for scheduling.
              </p>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding: 24px; background-color: #f9fafb; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #6b7280; font-size: 12px; text-align: center;">
              You're receiving this because you have social accounts expiring soon. 
              <a href="https://postora.cloud/settings" style="color: #3b82f6; text-decoration: none;">Manage notification preferences</a>
            </p>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // P1-3: require CRON_SECRET (or service-role) — cron-only function.
  // Without this gate, any external caller could trigger mass expiry
  // emails to real users (phishing surface) and drain Resend quota.
  const __cronAuth = verifyCronAuth(req);
  if (!__cronAuth.ok) return __cronAuth.response;

  try {
    console.log("Starting token expiry notification check...");

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      console.warn("RESEND_API_KEY not configured, skipping email sending");
      return new Response(
        JSON.stringify({ message: "Email sending not configured" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resend = new Resend(resendApiKey);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Check global feature flag — if email notifications are disabled globally, skip
    const { data: flagRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "feature_email_notifications")
      .maybeSingle();

    if (flagRow) {
      let flagValue = flagRow.value;
      if (typeof flagValue === "string") {
        try { flagValue = JSON.parse(flagValue); } catch { /* keep as-is */ }
      }
      if (flagValue === false || flagValue === "false") {
        console.log("Email notifications globally disabled via feature flag, skipping.");
        return new Response(
          JSON.stringify({ message: "Email notifications disabled globally", sent: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Check admin-level toggle for user token expiry emails
    const { data: tokenExpirySettingRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "user_email_token_expiry")
      .maybeSingle();

    if (tokenExpirySettingRow) {
      let settingVal = tokenExpirySettingRow.value;
      if (typeof settingVal === "string") {
        try { settingVal = JSON.parse(settingVal); } catch { /* keep */ }
      }
      if (settingVal === false) {
        console.log("Token expiry emails disabled by admin, skipping.");
        return new Response(
          JSON.stringify({ message: "Token expiry emails disabled by admin", sent: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Find all active accounts with tokens expiring soon
    // Max threshold is 7 days (168 hours)
    const maxExpiryWindow = new Date(now.getTime() + 168 * 60 * 60 * 1000);

    const { data: expiringAccounts, error: accountsError } = await supabase
      .from("social_accounts")
      .select("id, platform, platform_username, token_expires_at, user_id, needs_reauth, last_alert_sent_at, alerts_snoozed")
      .eq("is_active", true)
      .eq("needs_reauth", false)
      .not("token_expires_at", "is", null)
      .lte("token_expires_at", maxExpiryWindow.toISOString())
      .gt("token_expires_at", now.toISOString());

    if (accountsError) {
      console.error("Error fetching expiring accounts:", accountsError);
      throw accountsError;
    }

    console.log(`Found ${expiringAccounts?.length || 0} accounts with tokens expiring within 7 days`);

    if (!expiringAccounts || expiringAccounts.length === 0) {
      return new Response(
        JSON.stringify({ message: "No accounts expiring soon", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Filter accounts that:
    // 1. Haven't been notified in the last 24 hours
    // 2. Are within their platform-specific threshold
    // 3. Don't have alerts snoozed
    const accountsToNotify = expiringAccounts.filter((account) => {
      // Skip if alerts are snoozed
      if (account.alerts_snoozed) return false;

      // Check if already notified within 24 hours
      if (account.last_alert_sent_at) {
        const lastAlertDate = new Date(account.last_alert_sent_at);
        if (lastAlertDate > oneDayAgo) return false;
      }

      // Check if within platform-specific threshold
      const threshold = TOKEN_EXPIRY_THRESHOLDS[account.platform.toLowerCase()] || 168;
      const expiresAt = new Date(account.token_expires_at);
      const hoursUntilExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      
      return hoursUntilExpiry <= threshold;
    });

    console.log(`${accountsToNotify.length} accounts need notifications`);

    if (accountsToNotify.length === 0) {
      return new Response(
        JSON.stringify({ message: "All accounts already notified or outside threshold", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Group accounts by user
    const accountsByUser: Record<string, ExpiringAccount[]> = {};
    for (const account of accountsToNotify) {
      if (!accountsByUser[account.user_id]) {
        accountsByUser[account.user_id] = [];
      }
      accountsByUser[account.user_id].push(account as ExpiringAccount);
    }

    let emailsSent = 0;
    const accountsNotified: string[] = [];
    const errors: string[] = [];

    // Send one email per user with all their expiring accounts
    for (const [userId, accounts] of Object.entries(accountsByUser)) {
      try {
        // Get user profile
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("email, full_name, email_notifications_enabled")
          .eq("id", userId)
          .single();

        if (profileError || !profile?.email) {
          console.error(`Could not find profile for user ${userId}:`, profileError);
          continue;
        }

        // Check admin global toggle for user token expiry emails
        // (already checked once at top, but keeping user-level check here)
        // Skip if user has not explicitly enabled email notifications (null and false both mean disabled)
        if (profile.email_notifications_enabled !== true) {
          console.log(`Skipping notification for ${profile.email} - notifications disabled`);
          continue;
        }

        const userName = profile.full_name || "there";
        const emailHtml = generateExpiryWarningEmail(accounts, userName);

        const accountCount = accounts.length;
        const criticalCount = accounts.filter(a => {
          const hoursLeft = (new Date(a.token_expires_at).getTime() - Date.now()) / (1000 * 60 * 60);
          return hoursLeft <= 24;
        }).length;

        let subject = "";
        if (criticalCount > 0) {
          subject = `🚨 ${criticalCount} account${criticalCount > 1 ? "s" : ""} expire${criticalCount === 1 ? "s" : ""} within 24 hours`;
        } else {
          subject = `⏰ ${accountCount} account${accountCount > 1 ? "s" : ""} expiring soon - action recommended`;
        }

        const { error: emailError } = await resend.emails.send({
          from: "Postora <notifications@postora.cloud>",
          to: [profile.email],
          subject,
          html: emailHtml,
        });

        if (emailError) {
          console.error(`Failed to send email to ${profile.email}:`, emailError);
          errors.push(`${profile.email}: ${emailError.message}`);
        } else {
          console.log(`Sent expiry notification to ${profile.email} for ${accountCount} accounts`);
          emailsSent++;
          accountsNotified.push(...accounts.map(a => a.id));
        }
      } catch (err) {
        console.error(`Error processing user ${userId}:`, err);
        errors.push(`User ${userId}: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }

    // Update last_alert_sent_at for all notified accounts
    if (accountsNotified.length > 0) {
      const { error: updateError } = await supabase
        .from("social_accounts")
        .update({ last_alert_sent_at: now.toISOString() })
        .in("id", accountsNotified);

      if (updateError) {
        console.error("Error updating last_alert_sent_at:", updateError);
      } else {
        console.log(`Updated last_alert_sent_at for ${accountsNotified.length} accounts`);
      }
    }

    console.log(`Finished: sent ${emailsSent} notification emails for ${accountsNotified.length} accounts`);

    return new Response(
      JSON.stringify({
        message: `Sent ${emailsSent} notification emails`,
        sent: emailsSent,
        accountsNotified: accountsNotified.length,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in send-token-expiry-notifications:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
