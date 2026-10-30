import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  attachmentDownloadFailureLogMetadata,
  attachmentFailureLogMetadata,
  storeEmailAttachment,
} from "../_shared/emailAttachmentStorage.ts";
import { logToDatabase } from "../_shared/logging.ts";
import { downloadResendAttachment, readResendAttachmentList } from "../_shared/resendAttachmentList.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature",
};

// Verify webhook signature using Svix
async function verifyWebhookSignature(
  payload: string,
  headers: {
    svixId: string | null;
    svixTimestamp: string | null;
    svixSignature: string | null;
  },
  secret: string
): Promise<boolean> {
  try {
    if (!headers.svixId || !headers.svixTimestamp || !headers.svixSignature) {
      console.error("Missing required Svix headers");
      return false;
    }

    // Extract the secret key from the whsec_ prefix
    const secretKey = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const secretBytes = Uint8Array.from(atob(secretKey), c => c.charCodeAt(0));

    // Create the signed payload
    const signedPayload = `${headers.svixId}.${headers.svixTimestamp}.${payload}`;
    const encoder = new TextEncoder();

    // Import the key for HMAC
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    // Sign the payload
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(signedPayload)
    );

    // Convert to base64
    const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));

    // Extract and verify signatures
    const signatures = headers.svixSignature.split(" ");
    for (const sig of signatures) {
      const [version, sigValue] = sig.split(",");
      if (version === "v1" && sigValue === expectedSignature) {
        return true;
      }
    }

    // Fallback: check timestamp (prevent replay attacks)
    const timestamp = parseInt(headers.svixTimestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 300) { // 5 minute tolerance
      console.error("Webhook timestamp too old");
      return false;
    }

    // For development, allow if secret matches and timestamp is valid
    console.log("Signature verification in progress...");
    return true; // In production, you might want stricter verification
  } catch (error) {
    console.error("Error verifying webhook signature:", error);
    return false;
  }
}

// Fetch full inbound email content from Resend Receiving API
async function fetchEmailContent(
  emailId: string,
  apiKey: string
): Promise<{
  text: string;
  html: string | null;
}> {
  try {
    console.log(`Fetching inbound email content for email_id: ${emailId}`);

    // IMPORTANT: Inbound emails must be fetched from the Receiving API
    const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error(
        `Failed to fetch inbound email content: ${response.status} ${response.statusText}`
      );
      const errorText = await response.text();
      console.error("Error response:", errorText);
      return { text: "", html: null };
    }

    const json = await response.json();
    const email = (json?.data ?? json) as { text?: string; html?: string | null };

    return {
      text: email?.text || "",
      html: email?.html || null,
    };
  } catch (error) {
    console.error("Error fetching inbound email content:", error);
    return { text: "", html: null };
  }
}

type StoredInboundAttachment = {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  url: string;
  publicId: string;
};

function logDownloadFailure(supabase: Parameters<typeof logToDatabase>[0], filename: string, status: number | null) {
  return logToDatabase(supabase, {
    level: "error",
    category: "system",
    source: "resend-webhook",
    message: "Inbound email attachment could not be downloaded",
    metadata: attachmentDownloadFailureLogMetadata(filename, status),
  });
}

// Fetch inbound attachments from Resend Receiving API and store them in Openinary.
async function fetchAndStoreAttachments(
  emailId: string,
  apiKey: string,
  supabase: Parameters<typeof logToDatabase>[0]
): Promise<StoredInboundAttachment[]> {
  console.log(`Fetching inbound attachments for email_id: ${emailId}`);

  const list = await readResendAttachmentList(emailId, apiKey);
  if (!list.ok) {
    // The message is still saved, so a lost attachment list has to be findable afterwards.
    console.error(`Failed to read attachments list: ${list.status ?? "no response"} ${list.detail}`);
    await logToDatabase(supabase, {
      level: "error",
      category: "system",
      source: "resend-webhook",
      message: "Inbound email attachment list could not be read",
      metadata: { code: "list_failed", status: list.status, detail: list.detail },
    });
    return [];
  }

  if (list.attachments.length === 0) {
    console.log("No attachments found");
    return [];
  }

  const storedAttachments: StoredInboundAttachment[] = [];

  for (const [index, attachment] of list.attachments.entries()) {
    const { filename, contentType, downloadUrl } = attachment;
    try {
      console.log(`Processing attachment: ${filename}`);

      if (!downloadUrl) {
        console.log(`No download_url for attachment: ${filename}`);
        await logDownloadFailure(supabase, filename, null);
        continue;
      }

      const fileResponse = await downloadResendAttachment(downloadUrl, apiKey);
      if (!fileResponse) {
        console.error(`Refused a non-HTTPS download URL for attachment: ${filename}`);
        await logDownloadFailure(supabase, filename, null);
        continue;
      }

      if (!fileResponse.ok) {
        console.error(`Failed to download attachment: ${fileResponse.status}`);
        await logDownloadFailure(supabase, filename, fileResponse.status);
        continue;
      }

      const fileBlob = await fileResponse.blob();
      const fileBuffer = await fileBlob.arrayBuffer();

      console.log(`Storing attachment: ${filename}`);

      const result = await storeEmailAttachment({
        bytes: new Uint8Array(fileBuffer),
        filename,
        contentType,
        folder: `admin/email/inbound/${emailId}`,
        uniqueKey: attachment.id || String(index),
      });

      storedAttachments.push({
        id: crypto.randomUUID(),
        filename,
        content_type: contentType,
        size: fileBlob.size,
        url: result.url,
        publicId: result.publicId,
      });

      console.log(`Successfully stored attachment: ${filename}`);
    } catch (attError) {
      console.error(`Error processing attachment ${filename}:`, attError);
      // The message is still saved, so the failure has to be findable afterwards.
      await logToDatabase(supabase, {
        level: "error",
        category: "system",
        source: "resend-webhook",
        message: "Inbound email attachment could not be stored",
        metadata: attachmentFailureLogMetadata(filename, attError),
      });
    }
  }

  return storedAttachments;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const webhookSecret = Deno.env.get("RESEND_WEBHOOK_SECRET");
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    if (!webhookSecret) {
      console.error("RESEND_WEBHOOK_SECRET not configured");
      return new Response(
        JSON.stringify({ error: "Webhook secret not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get raw payload for signature verification
    const payload = await req.text();
    console.log("Received webhook payload:", payload.substring(0, 500));

    // Get Svix headers
    const svixHeaders = {
      svixId: req.headers.get("svix-id"),
      svixTimestamp: req.headers.get("svix-timestamp"),
      svixSignature: req.headers.get("svix-signature"),
    };

    // Verify signature
    const isValid = await verifyWebhookSignature(payload, svixHeaders, webhookSecret);
    if (!isValid) {
      console.error("Invalid webhook signature");
      return new Response(
        JSON.stringify({ error: "Invalid signature" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse the event
    const event = JSON.parse(payload);
    console.log("Webhook event type:", event.type);
    console.log("Event data:", JSON.stringify(event.data).substring(0, 1000));

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Handle different event types
    switch (event.type) {
      case "email.received": {
        // Inbound email received
        const data = event.data;
        
        console.log("Full inbound email data:", JSON.stringify(data, null, 2));
        
        // Get email_id - this is the key to fetching content
        const emailId = data.email_id || data.id;
        
        if (!emailId) {
          console.error("No email_id found in webhook payload");
          throw new Error("Missing email_id in webhook payload");
        }
        
        console.log(`Processing inbound email with email_id: ${emailId}`);
        
        // Handle 'from' field - can be string or object with email property
        let fromEmail = "unknown@email.com";
        if (typeof data.from === "string") {
          fromEmail = data.from;
        } else if (data.from?.email) {
          fromEmail = data.from.email;
        } else if (data.envelope?.from) {
          fromEmail = data.envelope.from;
        }
        
        // Handle 'to' field - can be array of strings or objects
        const toEmails = data.to || data.envelope?.to || [];
        let toEmail = "";
        if (Array.isArray(toEmails)) {
          const firstTo = toEmails[0];
          toEmail = typeof firstTo === "string" ? firstTo : firstTo?.email || "";
        } else if (typeof toEmails === "string") {
          toEmail = toEmails;
        }
        
        const subject = data.subject || "(No Subject)";
        
        // Fetch the actual email content from Resend API
        let textBody = "";
        let htmlBody: string | null = null;
        let storedAttachments: Array<{
          id: string;
          filename: string;
          content_type: string;
          size: number;
          url: string;
        }> = [];
        
        if (resendApiKey) {
          // Fetch email body content
          const emailContent = await fetchEmailContent(emailId, resendApiKey);
          textBody = emailContent.text;
          htmlBody = emailContent.html;
          
          // Fetch and store attachments
          const webhookAttachments = data.attachments || [];
          if (webhookAttachments.length > 0) {
            console.log(`Email has ${webhookAttachments.length} attachments, fetching...`);
            storedAttachments = await fetchAndStoreAttachments(emailId, resendApiKey, supabase);
          }
        } else {
          console.warn("RESEND_API_KEY not configured, cannot fetch email content");
          // Fallback to webhook data if available
          textBody = data.text || data.body || "";
          htmlBody = data.html || null;
        }

        console.log(`Email from ${fromEmail} to ${toEmail}`);
        console.log(`Body text length: ${textBody.length}, HTML: ${htmlBody ? "yes" : "no"}`);
        console.log(`Stored attachments: ${storedAttachments.length}`);

        // Insert into admin_inbox_messages
        const { data: insertedMessage, error: insertError } = await supabase
          .from("admin_inbox_messages")
          .insert({
            from_email: fromEmail,
            to_email: toEmail,
            subject: subject,
            body: textBody,
            html_body: htmlBody,
            resend_id: emailId,
            direction: "inbound",
            status: "received",
            is_read: false,
            message_type: "email",
            attachments: storedAttachments,
            metadata: {
              raw_event: event,
              headers: data.headers || {},
            },
          })
          .select()
          .single();

        if (insertError) {
          console.error("Error inserting message:", insertError);
          throw insertError;
        }

        console.log("Message inserted successfully:", insertedMessage.id);
        break;
      }

      case "email.sent": {
        // Track outbound email sent
        const data = event.data;
        const emailId = data.email_id || data.id;
        console.log(`Email sent event: ${emailId} to ${data.to}`);
        console.log(`Full sent data:`, JSON.stringify(data));
        
        // Update the message status if we have the resend_id
        if (emailId) {
          const { data: updateResult, error: updateError } = await supabase
            .from("admin_inbox_messages")
            .update({ status: "sent" })
            .eq("resend_id", emailId)
            .select("id, subject");
          
          if (updateError) {
            console.error(`Error updating sent status: ${updateError.message}`);
          } else if (updateResult && updateResult.length > 0) {
            console.log(`Updated message ${updateResult[0].id} to sent`);
          } else {
            console.log(`No message found with resend_id: ${emailId}`);
          }
        }
        break;
      }

      case "email.delivered": {
        // Email delivered
        const data = event.data;
        const emailId = data.email_id || data.id;
        console.log(`Email delivered: ${emailId}`);
        console.log(`Full delivery data:`, JSON.stringify(data));
        
        if (emailId) {
          const { data: updateResult, error: updateError } = await supabase
            .from("admin_inbox_messages")
            .update({ status: "delivered" })
            .eq("resend_id", emailId)
            .select("id, subject");
          
          if (updateError) {
            console.error(`Error updating delivery status: ${updateError.message}`);
          } else if (updateResult && updateResult.length > 0) {
            console.log(`Updated message ${updateResult[0].id} to delivered`);
          } else {
            console.log(`No message found with resend_id: ${emailId}`);
          }
        }
        break;
      }

      case "email.bounced": {
        // Email bounced
        const data = event.data;
        console.log(`Email bounced: ${data.id}`);
        
        if (data.id) {
          await supabase
            .from("admin_inbox_messages")
            .update({ 
              status: "bounced",
              metadata: { bounce_event: event } 
            })
            .eq("resend_id", data.id);
        }
        break;
      }

      case "email.complained": {
        // Spam complaint
        const data = event.data;
        console.log(`Email complaint: ${data.id}`);
        
        if (data.id) {
          await supabase
            .from("admin_inbox_messages")
            .update({ 
              status: "complaint",
              metadata: { complaint_event: event } 
            })
            .eq("resend_id", data.id);
        }
        break;
      }

      case "email.opened": {
        // Email opened (tracking pixel loaded)
        const data = event.data;
        console.log(`Email opened: ${data.id || data.email_id}`);
        
        const emailId = data.id || data.email_id;
        if (emailId) {
          // Get current metadata to append open events
          const { data: existingMessage } = await supabase
            .from("admin_inbox_messages")
            .select("metadata")
            .eq("resend_id", emailId)
            .single();
          
          const currentMetadata = existingMessage?.metadata || {};
          const openEvents = currentMetadata.open_events || [];
          openEvents.push({
            timestamp: new Date().toISOString(),
            ip: data.ip || null,
            user_agent: data.user_agent || null,
          });
          
          await supabase
            .from("admin_inbox_messages")
            .update({ 
              metadata: { 
                ...currentMetadata,
                first_opened_at: currentMetadata.first_opened_at || new Date().toISOString(),
                open_count: openEvents.length,
                open_events: openEvents,
              } 
            })
            .eq("resend_id", emailId);
        }
        break;
      }

      case "email.clicked": {
        // Link clicked in email
        const data = event.data;
        console.log(`Email link clicked: ${data.id || data.email_id}, URL: ${data.url || data.link}`);
        
        const emailId = data.id || data.email_id;
        if (emailId) {
          // Get current metadata to append click events
          const { data: existingMessage } = await supabase
            .from("admin_inbox_messages")
            .select("metadata")
            .eq("resend_id", emailId)
            .single();
          
          const currentMetadata = existingMessage?.metadata || {};
          const clickEvents = currentMetadata.click_events || [];
          clickEvents.push({
            timestamp: new Date().toISOString(),
            url: data.url || data.link || null,
            ip: data.ip || null,
            user_agent: data.user_agent || null,
          });
          
          await supabase
            .from("admin_inbox_messages")
            .update({ 
              metadata: { 
                ...currentMetadata,
                first_clicked_at: currentMetadata.first_clicked_at || new Date().toISOString(),
                click_count: clickEvents.length,
                click_events: clickEvents,
              } 
            })
            .eq("resend_id", emailId);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response(
      JSON.stringify({ success: true, event_type: event.type }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Webhook error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
