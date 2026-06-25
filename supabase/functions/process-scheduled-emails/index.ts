import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ScheduledEmail {
  id: string;
  admin_id: string;
  from_email: string;
  to_email: string;
  cc_email: string | null;
  bcc_email: string | null;
  subject: string;
  html_body: string;
  text_body: string | null;
  attachments: Array<{ filename: string; path: string }>;
  scheduled_at: string;
  reply_to_message_id: string | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY not configured");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("Checking for pending scheduled emails...");

    // Get all pending scheduled emails that are due
    const { data: pendingEmails, error: fetchError } = await supabase
      .from("scheduled_emails")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_at", new Date().toISOString())
      .limit(10);

    if (fetchError) {
      console.error("Error fetching scheduled emails:", fetchError);
      throw fetchError;
    }

    if (!pendingEmails || pendingEmails.length === 0) {
      console.log("No pending emails to process");
      return new Response(
        JSON.stringify({ success: true, processed: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${pendingEmails.length} emails to process`);

    let successCount = 0;
    let failCount = 0;

    for (const email of pendingEmails as ScheduledEmail[]) {
      try {
        // Mark as processing
        await supabase
          .from("scheduled_emails")
          .update({ status: "processing" })
          .eq("id", email.id);

        console.log(`Processing email ${email.id} to ${email.to_email}`);

        // Prepare Resend payload
        const resendPayload: Record<string, unknown> = {
          from: `Postora <${email.from_email}>`,
          to: [email.to_email],
          subject: email.subject,
          html: email.html_body,
          text: email.text_body || email.html_body.replace(/<[^>]*>/g, ""),
          reply_to: email.from_email,
        };

        // Add CC if present
        if (email.cc_email) {
          resendPayload.cc = email.cc_email.split(",").map((e) => e.trim());
        }

        // Add BCC if present
        if (email.bcc_email) {
          resendPayload.bcc = email.bcc_email.split(",").map((e) => e.trim());
        }

        // Add attachments if present
        if (email.attachments && email.attachments.length > 0) {
          resendPayload.attachments = email.attachments;
        }

        // Send via Resend
        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(resendPayload),
        });

        if (!resendResponse.ok) {
          const errorData = await resendResponse.json();
          throw new Error(`Resend error: ${errorData.message || "Unknown error"}`);
        }

        const resendData = await resendResponse.json();
        console.log(`Email ${email.id} sent successfully: ${resendData.id}`);

        // Get thread ID if this is a reply
        let threadId = null;
        if (email.reply_to_message_id) {
          const { data: originalMessage } = await supabase
            .from("admin_inbox_messages")
            .select("id, thread_id")
            .eq("id", email.reply_to_message_id)
            .single();

          if (originalMessage) {
            threadId = originalMessage.thread_id || originalMessage.id;
          }
        }

        // Store in inbox messages
        await supabase.from("admin_inbox_messages").insert({
          from_email: email.from_email,
          to_email: email.to_email,
          subject: email.subject,
          body: email.text_body || email.html_body.replace(/<[^>]*>/g, ""),
          html_body: email.html_body,
          resend_id: resendData.id,
          direction: "outbound",
          status: "sent",
          is_read: true,
          admin_id: email.admin_id,
          reply_to_id: email.reply_to_message_id,
          thread_id: threadId,
          message_type: "email",
          attachments: email.attachments || null,
          metadata: {
            cc: email.cc_email?.split(",").map((e) => e.trim()) || [],
            bcc: email.bcc_email?.split(",").map((e) => e.trim()) || [],
            scheduled: true,
            scheduled_at: email.scheduled_at,
          },
        });

        // Mark as sent
        await supabase
          .from("scheduled_emails")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
          })
          .eq("id", email.id);

        // Update original message if this was a reply
        if (email.reply_to_message_id) {
          await supabase
            .from("admin_inbox_messages")
            .update({
              status: "replied",
              thread_id: threadId || email.reply_to_message_id,
            })
            .eq("id", email.reply_to_message_id);
        }

        successCount++;
      } catch (error) {
        console.error(`Failed to send email ${email.id}:`, error);
        
        // Mark as failed
        await supabase
          .from("scheduled_emails")
          .update({
            status: "failed",
            error_message: error instanceof Error ? error.message : "Unknown error",
          })
          .eq("id", email.id);

        failCount++;
      }
    }

    console.log(`Processed ${successCount} emails successfully, ${failCount} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: successCount,
        failed: failCount,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: unknown) {
    console.error("Process scheduled emails error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
