import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { verifyCronAuth } from "../_shared/cron-auth.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ExpiringOverride {
  id: string;
  user_id: string;
  provider: string;
  model: string;
  expires_at: string;
  reason: string | null;
  user_email: string;
  user_name: string | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // P1-2: require CRON_SECRET (or service-role) — cron-only function.
  const __cronAuth = verifyCronAuth(req);
  if (!__cronAuth.ok) return __cronAuth.response;

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    if (!RESEND_API_KEY) {
      console.error("RESEND_API_KEY is not configured");
      return new Response(
        JSON.stringify({ error: "RESEND_API_KEY is not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check admin email setting
    const { data: settingRow } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "admin_email_ai_override_expiry")
      .maybeSingle();

    if (settingRow) {
      const parsed = typeof settingRow.value === "string" ? JSON.parse(settingRow.value) : settingRow.value;
      if (parsed === false) {
        console.log("AI override expiry alerts disabled by admin, skipping");
        return new Response(
          JSON.stringify({ message: "AI override alerts disabled", count: 0 }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Get overrides expiring in the next 3 days
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
    
    const now = new Date();

    console.log("Checking for AI model overrides expiring before:", threeDaysFromNow.toISOString());

    // Fetch expiring overrides
    const { data: expiringOverrides, error: overridesError } = await supabaseAdmin
      .from("user_ai_model_overrides")
      .select("*")
      .not("expires_at", "is", null)
      .gte("expires_at", now.toISOString())
      .lte("expires_at", threeDaysFromNow.toISOString());

    if (overridesError) {
      console.error("Error fetching expiring overrides:", overridesError);
      throw overridesError;
    }

    if (!expiringOverrides || expiringOverrides.length === 0) {
      console.log("No AI model overrides expiring in the next 3 days");
      return new Response(
        JSON.stringify({ message: "No expiring overrides found", count: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${expiringOverrides.length} expiring AI model overrides`);

    // Fetch user profiles for the overrides
    const userIds = expiringOverrides.map((o) => o.user_id);
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, email, full_name")
      .in("id", userIds);

    const profileMap = new Map(profiles?.map((p) => [p.id, p]));

    // Fetch admin emails to notify
    const { data: adminRoles } = await supabaseAdmin
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin");

    const adminIds = adminRoles?.map((r) => r.user_id) || [];
    
    const { data: adminProfiles } = await supabaseAdmin
      .from("profiles")
      .select("id, email, full_name")
      .in("id", adminIds);

    if (!adminProfiles || adminProfiles.length === 0) {
      console.log("No admin profiles found to notify");
      return new Response(
        JSON.stringify({ message: "No admin emails to notify", count: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build the list of expiring overrides with user info
    const enrichedOverrides: ExpiringOverride[] = expiringOverrides.map((override) => {
      const profile = profileMap.get(override.user_id);
      return {
        ...override,
        user_email: profile?.email || "Unknown",
        user_name: profile?.full_name || null,
      };
    });

    // Build email content
    const formatDate = (dateStr: string) => {
      const date = new Date(dateStr);
      return date.toLocaleDateString("en-US", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    };

    const overrideRows = enrichedOverrides
      .map((o) => {
        const expiresDate = new Date(o.expires_at);
        const hoursLeft = Math.round((expiresDate.getTime() - now.getTime()) / (1000 * 60 * 60));
        const urgency = hoursLeft < 24 ? "🔴" : hoursLeft < 48 ? "🟡" : "🟢";
        
        return `
          <tr style="border-bottom: 1px solid #e5e7eb;">
            <td style="padding: 12px; font-size: 14px;">
              ${urgency} <strong>${o.user_email}</strong>
              ${o.user_name ? `<br><span style="color: #6b7280; font-size: 12px;">${o.user_name}</span>` : ""}
            </td>
            <td style="padding: 12px; font-size: 14px;">
              <span style="background: #f3f4f6; padding: 2px 8px; border-radius: 4px; font-family: monospace; font-size: 12px;">
                ${o.model}
              </span>
              <br><span style="color: #6b7280; font-size: 12px;">${o.provider}</span>
            </td>
            <td style="padding: 12px; font-size: 14px;">
              ${formatDate(o.expires_at)}
              <br><span style="color: ${hoursLeft < 24 ? '#dc2626' : hoursLeft < 48 ? '#d97706' : '#059669'}; font-size: 12px; font-weight: 500;">
                ${hoursLeft < 24 ? `${hoursLeft}h left` : `${Math.round(hoursLeft / 24)}d left`}
              </span>
            </td>
            <td style="padding: 12px; font-size: 12px; color: #6b7280;">
              ${o.reason || "-"}
            </td>
          </tr>
        `;
      })
      .join("");

    const emailHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>AI Model Overrides Expiring Soon</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #f9fafb; padding: 20px;">
          <div style="max-width: 700px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
            <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 24px 32px;">
              <h1 style="color: white; margin: 0; font-size: 24px;">
                ⏰ AI Model Overrides Expiring Soon
              </h1>
              <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0 0; font-size: 14px;">
                ${enrichedOverrides.length} override(s) will expire in the next 3 days
              </p>
            </div>
            
            <div style="padding: 24px 32px;">
              <p style="color: #374151; margin: 0 0 16px 0;">
                The following user AI model overrides are expiring soon. Please review and extend or remove them as needed:
              </p>
              
              <table style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
                <thead>
                  <tr style="background: #f9fafb;">
                    <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">User</th>
                    <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Model</th>
                    <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Expires</th>
                    <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  ${overrideRows}
                </tbody>
              </table>
              
              <div style="margin-top: 24px; padding: 16px; background: #f0f9ff; border-radius: 8px; border-left: 4px solid #3b82f6;">
                <p style="margin: 0; color: #1e40af; font-size: 14px;">
                  <strong>💡 Tip:</strong> Visit the Admin Settings page to extend or remove these overrides before they expire.
                </p>
              </div>
            </div>
            
            <div style="padding: 16px 32px; background: #f9fafb; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #6b7280; font-size: 12px;">
                This is an automated notification from your Postora admin system.
              </p>
            </div>
          </div>
        </body>
      </html>
    `;

    // Send email to all admins
    const adminEmails = adminProfiles.map((p) => p.email);
    console.log("Sending notification to admins:", adminEmails);

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Postora <notifications@resend.dev>",
        to: adminEmails,
        subject: `⏰ ${enrichedOverrides.length} AI Model Override(s) Expiring Soon`,
        html: emailHtml,
      }),
    });

    const emailData = await emailResponse.json();

    if (!emailResponse.ok) {
      console.error("Resend API error:", emailData);
      throw new Error(emailData.message || "Failed to send email");
    }

    console.log("Email sent successfully:", emailData);

    return new Response(
      JSON.stringify({
        message: "Notifications sent successfully",
        count: enrichedOverrides.length,
        adminNotified: adminEmails.length,
        emailId: emailData.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error in notify-expiring-ai-overrides:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
