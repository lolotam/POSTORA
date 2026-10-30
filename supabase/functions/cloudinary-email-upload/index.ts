import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  deleteEmailAttachment,
  EMAIL_ATTACHMENT_ERROR_STATUS,
  EmailAttachmentStorageError,
  attachmentFailureLogMetadata,
  storeEmailAttachment,
} from "../_shared/emailAttachmentStorage.ts";
import { logToDatabase } from "../_shared/logging.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify JWT and admin role
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify admin role
    const admin = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: roleData } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .single();

    if (!roleData) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action } = body;

    if (action === "delete") {
      const { publicId } = body;
      if (!publicId) {
        return new Response(
          JSON.stringify({ error: "Missing publicId" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const outcome = await deleteEmailAttachment(publicId);
      if (!outcome.success) {
        console.error("[cloudinary-email-upload] attachment delete failed:", outcome.error);
        await logToDatabase(admin, {
          level: "warn",
          category: "system",
          source: "cloudinary-email-upload",
          message: "Email attachment delete failed",
          user_id: user.id,
          metadata: { detail: outcome.error },
        });
      }

      return new Response(JSON.stringify(outcome), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Default action: upload
    const { fileData, fileName, contentType, folder } = body;

    if (!fileData || !fileName) {
      return new Response(
        JSON.stringify({ error: "Missing fileData or fileName" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Decode base64 file data
    const binaryString = atob(fileData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const date = new Date().toISOString().split("T")[0];
    const cloudFolder =
      folder === "inbound"
        ? `admin/email/inbound/${body.emailId || date}`
        : `admin/email/outbound/${date}`;

    try {
      const result = await storeEmailAttachment({
        bytes,
        filename: fileName,
        contentType: contentType || "application/octet-stream",
        folder: cloudFolder,
        uniqueKey: crypto.randomUUID(),
      });

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (error) {
      if (!(error instanceof EmailAttachmentStorageError)) throw error;
      console.error("[cloudinary-email-upload] attachment upload failed:", error.message);
      await logToDatabase(admin, {
        level: "error",
        category: "system",
        source: "cloudinary-email-upload",
        message: "Email attachment upload failed",
        user_id: user.id,
        metadata: attachmentFailureLogMetadata(fileName, error),
      });
      return new Response(JSON.stringify({ error: error.publicMessage, code: error.code }), {
        status: EMAIL_ATTACHMENT_ERROR_STATUS[error.code],
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (error: unknown) {
    console.error("Error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
