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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Fetch full inbound email content from Resend Receiving API
async function fetchEmailContent(
  emailId: string,
  apiKey: string
): Promise<{
  text: string;
  html: string | null;
}> {
  console.log(`Fetching inbound email content for email_id: ${emailId}`);

  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    console.error(`Failed to fetch inbound email content: ${response.status} ${response.statusText}`);
    const errorText = await response.text();
    console.error("Error response:", errorText);
    throw new Error(`Failed to fetch inbound email: ${response.status}`);
  }

  const json = await response.json();
  const email = (json?.data ?? json) as { text?: string; html?: string | null };

  return {
    text: email?.text || "",
    html: email?.html || null,
  };
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
    source: "fetch-email-content",
    message: "Inbound email attachment could not be downloaded",
    metadata: attachmentDownloadFailureLogMetadata(filename, status),
  });
}

// Fetch inbound attachments from Resend Receiving API and store them in Openinary.
// `failed` counts attachments that could not be stored, so the caller can report it.
async function fetchAndStoreAttachments(
  emailId: string,
  apiKey: string,
  supabase: Parameters<typeof logToDatabase>[0]
): Promise<{ stored: StoredInboundAttachment[]; failed: number }> {
  console.log(`Fetching inbound attachments for email_id: ${emailId}`);

  const list = await readResendAttachmentList(emailId, apiKey);
  if (!list.ok) {
    // Not "no attachments": the list itself could not be read, so count it as a failure.
    console.error(`Failed to read attachments list: ${list.status ?? "no response"} ${list.detail}`);
    await logToDatabase(supabase, {
      level: "error",
      category: "system",
      source: "fetch-email-content",
      message: "Inbound email attachment list could not be read",
      metadata: { code: "list_failed", status: list.status, detail: list.detail },
    });
    return { stored: [], failed: 1 };
  }

  if (list.attachments.length === 0) {
    console.log("No attachments found");
    return { stored: [], failed: 0 };
  }

  const storedAttachments: StoredInboundAttachment[] = [];
  let failed = 0;

  for (const [index, attachment] of list.attachments.entries()) {
    const { filename, contentType, downloadUrl } = attachment;
    try {
      if (!downloadUrl) {
        failed++;
        await logDownloadFailure(supabase, filename, null);
        continue;
      }

      const fileResponse = await downloadResendAttachment(downloadUrl, apiKey);
      if (!fileResponse) {
        failed++;
        await logDownloadFailure(supabase, filename, null);
        continue;
      }

      if (!fileResponse.ok) {
        failed++;
        await logDownloadFailure(supabase, filename, fileResponse.status);
        continue;
      }

      const fileBlob = await fileResponse.blob();
      const fileBuffer = await fileBlob.arrayBuffer();

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
      failed++;
      console.error(`Error processing attachment ${filename}:`, attError);
      await logToDatabase(supabase, {
        level: "error",
        category: "system",
        source: "fetch-email-content",
        message: "Inbound email attachment could not be stored",
        metadata: attachmentFailureLogMetadata(filename, attError),
      });
    }
  }

  return { stored: storedAttachments, failed };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    if (!resendApiKey) {
      console.error("RESEND_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "RESEND_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify authorization
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    // Verify the user is authenticated
    const { data: { user }, error: authError } = await createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { messageId } = await req.json();

    if (!messageId) {
      return new Response(
        JSON.stringify({ error: "Missing messageId" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Fetching content for message: ${messageId}`);

    // Get the message from database
    const { data: message, error: fetchError } = await supabase
      .from("admin_inbox_messages")
      .select("*")
      .eq("id", messageId)
      .single();

    if (fetchError || !message) {
      console.error("Message not found:", fetchError);
      return new Response(
        JSON.stringify({ error: "Message not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Try to get resend_id from message, or extract from metadata
    let resendId = message.resend_id;
    
    // If resend_id is not directly stored, try to extract from metadata
    if (!resendId && message.metadata) {
      const metadata = message.metadata as { raw_event?: { data?: { email_id?: string } } };
      resendId = metadata.raw_event?.data?.email_id || null;
      
      // If we found it in metadata, update the message record for future use
      if (resendId) {
        console.log(`Found email_id in metadata: ${resendId}, updating message record`);
        await supabase
          .from("admin_inbox_messages")
          .update({ resend_id: resendId })
          .eq("id", messageId);
      }
    }
    
    if (!resendId) {
      return new Response(
        JSON.stringify({ error: "No Resend ID found in message or metadata" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Fetching content from Resend for email_id: ${resendId}`);

    // Fetch email content
    let textBody = "";
    let htmlBody: string | null = null;
    let fetchedContent = false;

    try {
      const emailContent = await fetchEmailContent(resendId, resendApiKey);
      textBody = emailContent.text;
      htmlBody = emailContent.html;
      fetchedContent = true;
      console.log(`Fetched body - text: ${textBody.length} chars, html: ${htmlBody ? "yes" : "no"}`);
    } catch (error) {
      console.error("Failed to fetch email content:", error);
    }

    // Fetch and store attachments
    let storedAttachments: StoredInboundAttachment[] = [];
    let attachmentsFailed = 0;

    try {
      const outcome = await fetchAndStoreAttachments(resendId, resendApiKey, supabase);
      storedAttachments = outcome.stored;
      attachmentsFailed = outcome.failed;
      console.log(`Stored ${storedAttachments.length} attachments, ${attachmentsFailed} failed`);
    } catch (error) {
      console.error("Failed to fetch attachments:", error);
    }

    // Update the message in database
    const updateData: Record<string, unknown> = {};
    
    if (textBody) {
      updateData.body = textBody;
    }
    if (htmlBody) {
      updateData.html_body = htmlBody;
    }
    if (storedAttachments.length > 0) {
      // Merge with existing attachments that might have URLs
      const existingAttachments = Array.isArray(message.attachments) ? message.attachments : [];
      const existingWithUrls = existingAttachments.filter((a: { url?: string }) => a.url);
      // A re-fetch stores to the same path (stable Resend attachment id), so an
      // attachment already on the message is not added a second time.
      const known = new Set(existingWithUrls.map((a: { publicId?: string }) => a.publicId).filter(Boolean));
      updateData.attachments = [...existingWithUrls, ...storedAttachments.filter((a) => !known.has(a.publicId))];
    }

    if (Object.keys(updateData).length > 0) {
      const { error: updateError } = await supabase
        .from("admin_inbox_messages")
        .update(updateData)
        .eq("id", messageId);

      if (updateError) {
        console.error("Failed to update message:", updateError);
        return new Response(
          JSON.stringify({ error: "Failed to update message" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        fetched: {
          body: fetchedContent,
          bodyLength: textBody.length,
          hasHtml: !!htmlBody,
          attachments: storedAttachments.length,
          attachments_failed: attachmentsFailed,
        }
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
