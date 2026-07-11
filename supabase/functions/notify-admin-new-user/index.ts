import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyCronAuth } from "../_shared/cron-auth.ts";


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ADMIN_EMAIL = "dr.vet.waleedtam@gmail.com";
const FROM_EMAIL = "Postora <noreply@postora.cloud>";

function buildEmailHtml(profile: {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
}) {
  const name = profile.full_name || "(no name)";
  const signupDate = new Date(profile.created_at).toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "short",
  });
  const adminUrl = `https://postora.cloud/admin/users?id=${profile.id}`;
  const avatar = profile.avatar_url
    ? `<img src="${profile.avatar_url}" alt="" width="64" height="64" style="border-radius:50%;display:block;margin:0 auto 16px;" />`
    : `<div style="width:64px;height:64px;border-radius:50%;background:#6366f1;color:#fff;font-size:28px;font-weight:700;line-height:64px;text-align:center;margin:0 auto 16px;">${name.charAt(0).toUpperCase()}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>New User Registered</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a2e;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
        <tr><td style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:32px 24px;text-align:center;">
          <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">🎉 New User Registered on Postora</h1>
        </td></tr>
        <tr><td style="padding:32px 24px;">
          ${avatar}
          <h2 style="margin:0 0 24px;text-align:center;font-size:20px;font-weight:600;color:#1a1a2e;">${name}</h2>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;padding:16px;">
            <tr><td style="padding:8px 12px;font-size:13px;color:#6b7280;width:40%;">Email</td><td style="padding:8px 12px;font-size:14px;color:#1a1a2e;font-weight:500;">${profile.email}</td></tr>
            <tr><td style="padding:8px 12px;font-size:13px;color:#6b7280;">Signup Date</td><td style="padding:8px 12px;font-size:14px;color:#1a1a2e;">${signupDate}</td></tr>
            <tr><td style="padding:8px 12px;font-size:13px;color:#6b7280;">User ID</td><td style="padding:8px 12px;font-size:12px;color:#6b7280;font-family:monospace;">${profile.id}</td></tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:32px;"><tr><td align="center">
            <a href="${adminUrl}" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 28px;border-radius:8px;">View user in admin →</a>
          </td></tr></table>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:20px 24px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">© ${new Date().getFullYear()} WALEED PROLIFE LLC · Postora</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    if (!resendApiKey) throw new Error("RESEND_API_KEY not configured");

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: profiles, error: fetchError } = await supabase
      .from("profiles")
      .select("id, email, full_name, avatar_url, created_at")
      .is("admin_notified_at", null)
      .order("created_at", { ascending: true })
      .limit(50);

    if (fetchError) throw fetchError;

    if (!profiles || profiles.length === 0) {
      return new Response(
        JSON.stringify({ success: true, processed: 0, message: "No new users" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing ${profiles.length} new user notifications`);

    let processed = 0;
    let failed = 0;

    for (const profile of profiles) {
      try {
        const html = buildEmailHtml(profile);
        const subject = `🎉 New user: ${profile.full_name || profile.email}`;

        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [ADMIN_EMAIL],
            subject,
            html,
          }),
        });

        if (!resendResponse.ok) {
          const errorData = await resendResponse.json();
          throw new Error(`Resend error: ${errorData.message || JSON.stringify(errorData)}`);
        }

        await supabase
          .from("profiles")
          .update({ admin_notified_at: new Date().toISOString() })
          .eq("id", profile.id);

        processed++;
        console.log(`Notified admin about new user: ${profile.email}`);
      } catch (err) {
        failed++;
        console.error(`Failed to notify admin about user ${profile.id}:`, err);
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed, failed }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("notify-admin-new-user error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
