import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

interface BlogPost {
  id: string;
  title: string;
  excerpt: string | null;
  status: string;
  scheduled_at: string | null;
  cover_image_url: string | null;
}

interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  email_notifications_enabled: boolean | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("Processing scheduled blog posts...");

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Find scheduled posts that are due to be published
    const now = new Date().toISOString();
    const { data: scheduledPosts, error: fetchError } = await supabase
      .from("blog_posts")
      .select("*")
      .eq("status", "scheduled")
      .lte("scheduled_at", now);

    if (fetchError) {
      console.error("Error fetching scheduled posts:", fetchError);
      throw new Error("Failed to fetch scheduled posts");
    }

    if (!scheduledPosts || scheduledPosts.length === 0) {
      console.log("No scheduled posts to publish");
      return new Response(
        JSON.stringify({ success: true, published: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${scheduledPosts.length} scheduled posts to publish`);

    const results = [];

    for (const post of scheduledPosts as BlogPost[]) {
      try {
        // Update status to published
        const { error: updateError } = await supabase
          .from("blog_posts")
          .update({ status: "published", scheduled_at: null })
          .eq("id", post.id);

        if (updateError) {
          console.error(`Failed to publish post ${post.id}:`, updateError);
          results.push({ id: post.id, success: false, error: updateError.message });
          continue;
        }

        console.log(`Published post: ${post.title} (${post.id})`);
        results.push({ id: post.id, success: true });

        // Send email notifications to all users
        if (RESEND_API_KEY) {
          await sendEmailNotifications(supabase, post);
        } else {
          console.log("RESEND_API_KEY not configured, skipping email notifications");
        }
      } catch (error) {
        console.error(`Error processing post ${post.id}:`, error);
        results.push({ id: post.id, success: false, error: String(error) });
      }
    }

    const publishedCount = results.filter(r => r.success).length;
    console.log(`Successfully published ${publishedCount}/${scheduledPosts.length} posts`);

    return new Response(
      JSON.stringify({ success: true, published: publishedCount, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error processing scheduled blog posts:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function sendEmailNotifications(supabase: any, post: BlogPost) {
  try {
    // Check admin-level toggle for blog notification emails
    const { data: blogSettingRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "user_email_blog_notifications")
      .maybeSingle();

    if (blogSettingRow) {
      const parsed = typeof blogSettingRow.value === "string" ? JSON.parse(blogSettingRow.value) : blogSettingRow.value;
      if (parsed === false) {
        console.log("Blog notification emails disabled by admin, skipping");
        return;
      }
    }

    console.log(`Sending email notifications for post: ${post.title}`);

    // Get users who have email notifications enabled
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, email, full_name, email_notifications_enabled")
      .eq("email_notifications_enabled", true)
      .limit(100); // Limit to prevent overwhelming the email service

    if (profilesError) {
      console.error("Error fetching profiles:", profilesError);
      return;
    }

    if (!profiles || profiles.length === 0) {
      console.log("No users to notify (all opted out or no users)");
      return;
    }

    // All returned profiles already have email_notifications_enabled = true
    const eligibleProfiles = profiles as Profile[];

    console.log(`Sending notifications to ${eligibleProfiles.length} users with email notifications enabled`);

    // Send emails in batches to avoid rate limits
    const BATCH_SIZE = 10;
    for (let i = 0; i < eligibleProfiles.length; i += BATCH_SIZE) {
      const batch = eligibleProfiles.slice(i, i + BATCH_SIZE);
      
      await Promise.all(
        batch.map(async (profile) => {
          try {
            const emailHtml = generateEmailHtml(post, profile);
            
            // Use fetch to call Resend API directly
            const response = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${RESEND_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: "Postora Updates <updates@postora.cloud>",
                to: [profile.email],
                subject: `🚀 New Update: ${post.title}`,
                html: emailHtml,
              }),
            });

            if (!response.ok) {
              const error = await response.text();
              console.error(`Failed to send email to ${profile.email}:`, error);
            } else {
              console.log(`Email sent to ${profile.email}`);
            }
          } catch (emailError) {
            console.error(`Error sending email to ${profile.email}:`, emailError);
          }
        })
      );

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < eligibleProfiles.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log("Email notifications completed");
  } catch (error) {
    console.error("Error sending email notifications:", error);
  }
}

function generateEmailHtml(post: BlogPost, profile: Profile): string {
  const postUrl = `https://postora.io/whats-new/${post.id}`;
  const userName = profile.full_name || "there";
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%); padding: 32px 40px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700;">🚀 New Update</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="margin: 0 0 20px; color: #374151; font-size: 16px; line-height: 1.6;">
                Hey ${userName}! 👋
              </p>
              
              <h2 style="margin: 0 0 16px; color: #111827; font-size: 22px; font-weight: 600;">
                ${post.title}
              </h2>
              
              ${post.cover_image_url ? `
              <img src="${post.cover_image_url}" alt="${post.title}" style="width: 100%; height: auto; border-radius: 8px; margin-bottom: 20px;">
              ` : ''}
              
              ${post.excerpt ? `
              <p style="margin: 0 0 24px; color: #6b7280; font-size: 15px; line-height: 1.7;">
                ${post.excerpt}
              </p>
              ` : ''}
              
              <a href="${postUrl}" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%); color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                Read Full Update →
              </a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 24px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0 0 8px; color: #6b7280; font-size: 13px;">
                You're receiving this because you're subscribed to Postora updates.
              </p>
              <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                © ${new Date().getFullYear()} Postora. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}
