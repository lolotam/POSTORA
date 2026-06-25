import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ScheduledChange {
  id: string;
  feature_key: string;
  scheduled_value: boolean;
  scheduled_at: string;
  status: string;
  created_by: string | null;
}

const FLAG_LABELS: Record<string, string> = {
  feature_video_compress: "Video Compression",
  feature_tiktok_transcode: "TikTok Transcode",
  feature_image_crop: "Image Cropping",
  feature_ai_caption: "AI Caption Generation",
  feature_ai_hashtags: "AI Hashtag Suggestions",
  feature_ai_thumbnails: "AI Thumbnails",
  feature_ai_image: "AI Image Generation",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const __cronAuth = verifyCronAuth(req);
  if (!__cronAuth.ok) return __cronAuth.response;

  console.log("Starting scheduled flags processor...");

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    const supabase = createClient(supabaseUrl, supabaseKey);
    const resend = resendApiKey ? new Resend(resendApiKey) : null;

    // Get pending scheduled changes that are due
    const now = new Date().toISOString();
    const { data: pendingChanges, error: fetchError } = await supabase
      .from("feature_flag_schedules")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_at", now);

    if (fetchError) {
      console.error("Error fetching scheduled changes:", fetchError);
      throw fetchError;
    }

    if (!pendingChanges || pendingChanges.length === 0) {
      console.log("No pending scheduled changes found");
      return new Response(
        JSON.stringify({ message: "No pending changes", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${pendingChanges.length} pending scheduled changes`);

    const results: { id: string; feature_key: string; success: boolean; error?: string }[] = [];
    const executedChanges: ScheduledChange[] = [];

    for (const change of pendingChanges as ScheduledChange[]) {
      console.log(`Processing scheduled change: ${change.feature_key} -> ${change.scheduled_value}`);

      try {
        // Get current value for audit log
        const { data: currentSetting } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", change.feature_key)
          .single();

        let oldValue: boolean | null = null;
        if (currentSetting) {
          try {
            const parsed = typeof currentSetting.value === "string" 
              ? JSON.parse(currentSetting.value) 
              : currentSetting.value;
            oldValue = parsed === true || parsed === "true";
          } catch {
            oldValue = null;
          }
        }

        // Update the app_settings
        const { error: updateError } = await supabase
          .from("app_settings")
          .update({ value: JSON.stringify(change.scheduled_value) })
          .eq("key", change.feature_key);

        if (updateError) throw updateError;

        // Log to audit
        await supabase.from("feature_flag_audit_log").insert({
          feature_key: change.feature_key,
          old_value: oldValue,
          new_value: change.scheduled_value,
          changed_by: change.created_by,
          change_type: "scheduled",
          notes: `Scheduled change executed at ${new Date().toISOString()}`,
        });

        // Mark as executed
        await supabase
          .from("feature_flag_schedules")
          .update({ status: "executed", executed_at: new Date().toISOString() })
          .eq("id", change.id);

        results.push({ id: change.id, feature_key: change.feature_key, success: true });
        executedChanges.push(change);

        console.log(`Successfully executed: ${change.feature_key}`);
      } catch (error) {
        console.error(`Error processing ${change.feature_key}:`, error);
        results.push({
          id: change.id,
          feature_key: change.feature_key,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Check admin email setting for scheduled flags
    const { data: flagSettingRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "admin_email_scheduled_flags")
      .maybeSingle();

    let scheduledFlagEmailsEnabled = true; // default enabled
    if (flagSettingRow) {
      const parsed = typeof flagSettingRow.value === "string" ? JSON.parse(flagSettingRow.value) : flagSettingRow.value;
      if (parsed === false) scheduledFlagEmailsEnabled = false;
    }

    // Send email notification to admins if changes were executed
    if (resend && executedChanges.length > 0 && scheduledFlagEmailsEnabled) {
      try {
        // Get admin emails
        const { data: adminRoles } = await supabase
          .from("user_roles")
          .select("user_id")
          .eq("role", "admin");

        if (adminRoles && adminRoles.length > 0) {
          const adminUserIds = adminRoles.map((r) => r.user_id);
          const { data: adminProfiles } = await supabase
            .from("profiles")
            .select("email")
            .in("id", adminUserIds);

          const adminEmails = adminProfiles?.map((p) => p.email).filter(Boolean) || [];

          if (adminEmails.length > 0) {
            const changesHtml = executedChanges
              .map(
                (c) =>
                  `<li><strong>${FLAG_LABELS[c.feature_key] || c.feature_key}</strong>: ${c.scheduled_value ? "Enabled" : "Disabled"}</li>`
              )
              .join("");

            await resend.emails.send({
              from: "Postora System <support@postora.cloud>",
              to: adminEmails,
              subject: `🚀 ${executedChanges.length} Scheduled Feature Flag Change(s) Executed`,
              html: `
                <h2>Scheduled Feature Flag Changes Executed</h2>
                <p>The following scheduled feature flag changes have been automatically executed:</p>
                <ul>${changesHtml}</ul>
                <p><strong>Executed at:</strong> ${new Date().toLocaleString()}</p>
                <p>Visit your admin dashboard to review these changes.</p>
              `,
            });

            console.log(`Email notification sent to ${adminEmails.length} admins`);
          }
        }
      } catch (emailError) {
        console.error("Failed to send email notification:", emailError);
      }
    }

    const successCount = results.filter((r) => r.success).length;
    console.log(`Completed: ${successCount}/${results.length} changes executed successfully`);

    return new Response(
      JSON.stringify({
        message: "Scheduled flags processed",
        processed: results.length,
        successful: successCount,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in process-scheduled-flags:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
