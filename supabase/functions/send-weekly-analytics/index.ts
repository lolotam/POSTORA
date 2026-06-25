import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

interface PlatformStats {
  platform: string;
  posts: number;
  scheduled: number;
  failed: number;
}

interface UserAnalytics {
  user_id: string;
  email: string;
  full_name: string | null;
  total_posts: number;
  successful_posts: number;
  scheduled_posts: number;
  failed_posts: number;
  platform_breakdown: PlatformStats[];
  connected_accounts: number;
  expiring_accounts: number;
}

function getPlatformDisplayName(platform: string): string {
  return PLATFORM_DISPLAY_NAMES[platform.toLowerCase()] || platform;
}

function generateWeeklyAnalyticsEmail(analytics: UserAnalytics, weekStart: Date, weekEnd: Date): string {
  const formatDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const weekRange = `${formatDate(weekStart)} - ${formatDate(weekEnd)}`;
  
  const successRate = analytics.total_posts > 0 
    ? Math.round((analytics.successful_posts / analytics.total_posts) * 100) 
    : 0;
  
  const platformRows = analytics.platform_breakdown
    .filter(p => p.posts > 0)
    .sort((a, b) => b.posts - a.posts)
    .map(p => `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
          <strong>${getPlatformDisplayName(p.platform)}</strong>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          ${p.posts}
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          <span style="color: ${p.failed > 0 ? '#ef4444' : '#22c55e'};">${p.failed > 0 ? p.failed + ' failed' : '✓'}</span>
        </td>
      </tr>
    `)
    .join("");

  const userName = analytics.full_name || "there";
  
  // Summary message based on performance
  let summaryMessage = "";
  if (analytics.total_posts === 0) {
    summaryMessage = "You haven't posted anything this week. Time to share some content!";
  } else if (successRate === 100) {
    summaryMessage = "🎉 Perfect week! All your posts were published successfully.";
  } else if (successRate >= 80) {
    summaryMessage = "Great job! Most of your posts went out smoothly.";
  } else {
    summaryMessage = "Some posts had issues this week. Check the details below.";
  }

  const healthWarning = analytics.expiring_accounts > 0 ? `
    <div style="margin: 24px 0; padding: 16px; background-color: #fef3c7; border-radius: 8px; border-left: 4px solid #f59e0b;">
      <p style="margin: 0; color: #92400e; font-size: 14px;">
        <strong>⚠️ Attention:</strong> ${analytics.expiring_accounts} account${analytics.expiring_accounts > 1 ? 's' : ''} need${analytics.expiring_accounts === 1 ? 's' : ''} reconnection soon.
        <a href="https://postora.cloud/connection-health" style="color: #d97706; font-weight: 600;">Check Connection Health →</a>
      </p>
    </div>
  ` : "";

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
          <td style="padding: 32px 24px; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);">
            <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700;">
              📊 Your Weekly Summary
            </h1>
            <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">
              ${weekRange}
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding: 24px;">
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              Hi ${userName},
            </p>
            <p style="margin: 0 0 24px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              ${summaryMessage}
            </p>
            
            <!-- Stats Grid -->
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
              <tr>
                <td style="padding: 16px; background-color: #f0fdf4; border-radius: 8px; text-align: center; width: 33%;">
                  <div style="font-size: 28px; font-weight: 700; color: #22c55e;">${analytics.successful_posts}</div>
                  <div style="font-size: 12px; color: #6b7280; text-transform: uppercase;">Published</div>
                </td>
                <td style="width: 8px;"></td>
                <td style="padding: 16px; background-color: #eff6ff; border-radius: 8px; text-align: center; width: 33%;">
                  <div style="font-size: 28px; font-weight: 700; color: #3b82f6;">${analytics.scheduled_posts}</div>
                  <div style="font-size: 12px; color: #6b7280; text-transform: uppercase;">Scheduled</div>
                </td>
                <td style="width: 8px;"></td>
                <td style="padding: 16px; background-color: ${analytics.failed_posts > 0 ? '#fef2f2' : '#f9fafb'}; border-radius: 8px; text-align: center; width: 33%;">
                  <div style="font-size: 28px; font-weight: 700; color: ${analytics.failed_posts > 0 ? '#ef4444' : '#9ca3af'};">${analytics.failed_posts}</div>
                  <div style="font-size: 12px; color: #6b7280; text-transform: uppercase;">Failed</div>
                </td>
              </tr>
            </table>

            ${analytics.platform_breakdown.filter(p => p.posts > 0).length > 0 ? `
            <!-- Platform Breakdown -->
            <h3 style="margin: 24px 0 16px 0; font-size: 16px; color: #374151;">Platform Breakdown</h3>
            <table cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
              <thead>
                <tr style="background-color: #f9fafb;">
                  <th style="padding: 12px; text-align: left; font-size: 12px; text-transform: uppercase; color: #6b7280; font-weight: 600;">Platform</th>
                  <th style="padding: 12px; text-align: center; font-size: 12px; text-transform: uppercase; color: #6b7280; font-weight: 600;">Posts</th>
                  <th style="padding: 12px; text-align: center; font-size: 12px; text-transform: uppercase; color: #6b7280; font-weight: 600;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${platformRows}
              </tbody>
            </table>
            ` : ""}

            ${healthWarning}
            
            <!-- Account Status -->
            <div style="margin: 24px 0; padding: 16px; background-color: #f9fafb; border-radius: 8px;">
              <p style="margin: 0; color: #374151; font-size: 14px;">
                <strong>Connected Accounts:</strong> ${analytics.connected_accounts} active
              </p>
            </div>
            
            <div style="margin: 24px 0; text-align: center;">
              <a href="https://postora.cloud/analytics" style="display: inline-block; padding: 14px 32px; background-color: #3b82f6; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                View Full Analytics
              </a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding: 24px; background-color: #f9fafb; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #6b7280; font-size: 12px; text-align: center;">
              You're receiving this weekly summary because you have email notifications enabled.
              <a href="https://postora.cloud/settings" style="color: #3b82f6; text-decoration: none;">Manage preferences</a>
            </p>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const __cronAuth = verifyCronAuth(req);
  if (!__cronAuth.ok) return __cronAuth.response;

  try {
    console.log("Starting weekly analytics email job...");

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

    // Check admin-level toggle for weekly summary emails
    const { data: weeklySettingRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "user_email_weekly_summary")
      .maybeSingle();

    if (weeklySettingRow) {
      let settingVal = weeklySettingRow.value;
      if (typeof settingVal === "string") {
        try { settingVal = JSON.parse(settingVal); } catch { /* keep */ }
      }
      if (settingVal === false) {
        console.log("Weekly summary emails disabled by admin, skipping.");
        return new Response(
          JSON.stringify({ message: "Weekly summary emails disabled by admin", sent: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Calculate last week's date range (Monday to Sunday)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() - daysToLastMonday);
    weekEnd.setHours(0, 0, 0, 0);
    
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekEnd.getDate() - 7);

    console.log(`Analyzing posts from ${weekStart.toISOString()} to ${weekEnd.toISOString()}`);

    // Get all users with email notifications enabled
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, email, full_name, email_notifications_enabled")
      .eq("email_notifications_enabled", true);

    if (profilesError) {
      console.error("Error fetching profiles:", profilesError);
      throw profilesError;
    }

    console.log(`Found ${profiles?.length || 0} users with notifications enabled`);

    let emailsSent = 0;
    const errors: string[] = [];

    for (const profile of profiles || []) {
      try {
        // Get user's posts from last week
        const { data: posts, error: postsError } = await supabase
          .from("posts")
          .select("id, status, platforms, created_at, posted_at, scheduled_at")
          .eq("user_id", profile.id)
          .gte("created_at", weekStart.toISOString())
          .lt("created_at", weekEnd.toISOString());

        if (postsError) {
          console.error(`Error fetching posts for user ${profile.id}:`, postsError);
          continue;
        }

        // Get platform_posts for detailed status
        const postIds = posts?.map(p => p.id) || [];
        let platformPosts: any[] = [];
        
        if (postIds.length > 0) {
          const { data: ppData, error: ppError } = await supabase
            .from("platform_posts")
            .select("post_id, platform, status")
            .in("post_id", postIds);
          
          if (!ppError) {
            platformPosts = ppData || [];
          }
        }

        // Get connected accounts
        const { data: accounts, error: accountsError } = await supabase
          .from("social_accounts")
          .select("id, platform, token_expires_at, needs_reauth")
          .eq("user_id", profile.id)
          .eq("is_active", true);

        if (accountsError) {
          console.error(`Error fetching accounts for user ${profile.id}:`, accountsError);
        }

        // Calculate expiring accounts (within 7 days)
        const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const expiringAccounts = (accounts || []).filter(a => {
          if (a.needs_reauth) return true;
          if (!a.token_expires_at) return false;
          const expiresAt = new Date(a.token_expires_at);
          return expiresAt < sevenDaysFromNow && expiresAt > now;
        }).length;

        // Calculate platform breakdown
        const platformStats: Record<string, PlatformStats> = {};
        
        for (const pp of platformPosts) {
          if (!platformStats[pp.platform]) {
            platformStats[pp.platform] = {
              platform: pp.platform,
              posts: 0,
              scheduled: 0,
              failed: 0,
            };
          }
          
          platformStats[pp.platform].posts += 1;
          if (pp.status === "failed") {
            platformStats[pp.platform].failed += 1;
          }
        }

        // Count scheduled posts (not yet posted)
        const scheduledPosts = (posts || []).filter(p => p.status === "scheduled").length;
        const successfulPosts = platformPosts.filter(pp => pp.status === "posted" || pp.status === "success").length;
        const failedPosts = platformPosts.filter(pp => pp.status === "failed").length;

        const analytics: UserAnalytics = {
          user_id: profile.id,
          email: profile.email,
          full_name: profile.full_name,
          total_posts: posts?.length || 0,
          successful_posts: successfulPosts,
          scheduled_posts: scheduledPosts,
          failed_posts: failedPosts,
          platform_breakdown: Object.values(platformStats),
          connected_accounts: accounts?.length || 0,
          expiring_accounts: expiringAccounts,
        };

        // Skip if user has no activity and no expiring accounts
        if (analytics.total_posts === 0 && analytics.connected_accounts === 0) {
          console.log(`Skipping ${profile.email} - no activity`);
          continue;
        }

        const emailHtml = generateWeeklyAnalyticsEmail(analytics, weekStart, weekEnd);

        const { error: emailError } = await resend.emails.send({
          from: "Postora <notifications@postora.cloud>",
          to: [profile.email],
          subject: `📊 Your Weekly Summary: ${analytics.successful_posts} posts published`,
          html: emailHtml,
        });

        if (emailError) {
          console.error(`Failed to send email to ${profile.email}:`, emailError);
          errors.push(`${profile.email}: ${emailError.message}`);
        } else {
          console.log(`Sent weekly analytics to ${profile.email}`);
          emailsSent++;
        }
      } catch (err) {
        console.error(`Error processing user ${profile.id}:`, err);
        errors.push(`User ${profile.id}: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }

    console.log(`Finished: sent ${emailsSent} weekly analytics emails`);

    return new Response(
      JSON.stringify({
        message: `Sent ${emailsSent} weekly analytics emails`,
        sent: emailsSent,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in send-weekly-analytics:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
