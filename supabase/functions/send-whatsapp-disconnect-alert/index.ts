// Service-role entrypoint for the WhatsApp disconnect alert emails (spec
// 2026-11-13-whatsapp-disconnect-alerts-design.md). Modelled on send-token-expiry-notifications:
// the caller authenticates with the service role, Resend and a service-role client implement the
// deps, and every PostgREST result is checked explicitly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { sanitizedError } from "../_shared/errorContext.ts";
import { redactSensitive } from "../_shared/logging.ts";
import {
  sendDisconnectAlerts,
  type AdminProfile,
  type AlertAccount,
  type OwnerProfile,
  type SendAlertsDeps,
} from "./handler.ts";
import { sendResendEmail } from "./resend.ts";

const FROM_SENDER = "Postora <notifications@postora.cloud>";

const BodySchema = z.object({
  account_id: z.string().uuid(),
});

/** A row of user_roles, narrowed to the one column this function reads. */
interface AdminRoleRow {
  user_id: string;
}

/**
 * Constant-time comparison, so a caller cannot learn the service-role key one character at
 * a time from the response timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

/**
 * The app_settings value is jsonb, but a row written by an older admin screen may hold the
 * JSON as a string. Both shapes mean the same thing: only an explicit false turns a toggle
 * off, and a missing row means enabled.
 *
 * A value that cannot be read at all is treated as enabled: one malformed row must not stop
 * every disconnect alert in the product.
 */
function settingEnabled(value: unknown): boolean {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return true;
    }
  }
  return parsed !== false;
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceRoleKey || !timingSafeEqual(bearerToken(req), serviceRoleKey)) {
      return new Response(
        JSON.stringify({ error: "unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "invalid request" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const parsed = BodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "invalid request" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!resendApiKey || !supabaseUrl) {
      console.error("[send-whatsapp-disconnect-alert] email not configured");
      return new Response(
        JSON.stringify({ error: "email not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const deps: SendAlertsDeps = {
      async loadAccount(accountId) {
        const { data, error } = await admin
          .from("social_accounts")
          .select("id, user_id, platform_username, platform_user_id")
          .eq("id", accountId)
          .eq("platform", "whatsapp")
          .eq("connection_mode", "evolution_qr")
          .maybeSingle();
        if (error) throw error;
        return (data as AlertAccount | null) ?? null;
      },
      async loadOwnerProfile(userId) {
        const { data, error } = await admin
          .from("profiles")
          .select("email, full_name, email_notifications_enabled")
          .eq("id", userId)
          .maybeSingle();
        if (error) throw error;
        return (data as OwnerProfile | null) ?? null;
      },
      async loadAdmins() {
        const { data: roles, error: roleError } = await admin
          .from("user_roles")
          .select("user_id")
          .eq("role", "admin");
        if (roleError) throw roleError;
        const ids = ((roles ?? []) as AdminRoleRow[]).map((role) => role.user_id);
        if (ids.length === 0) return [];
        const { data, error } = await admin
          .from("profiles")
          .select("email, full_name")
          .in("id", ids)
          .eq("email_notifications_enabled", true);
        if (error) throw error;
        return (data ?? []) as AdminProfile[];
      },
      async isGlobalEmailEnabled() {
        const { data, error } = await admin
          .from("app_settings")
          .select("value")
          .eq("key", "feature_email_notifications")
          .maybeSingle();
        if (error) throw error;
        if (!data) return true;
        return settingEnabled(data.value);
      },
      async isAdminAlertEnabled() {
        const { data, error } = await admin
          .from("app_settings")
          .select("value")
          .eq("key", "admin_email_whatsapp_disconnect_alerts")
          .maybeSingle();
        if (error) throw error;
        if (!data) return true;
        return settingEnabled(data.value);
      },
      async claim(accountId, kind) {
        const { data, error } = await admin.rpc("claim_whatsapp_disconnect_email", {
          p_account_id: accountId,
          p_kind: kind,
        });
        if (error) throw error;
        // The RPC returns the episode id of the claimed episode, or NULL when it refused.
        return typeof data === "string" ? data : null;
      },
      async send(payload) {
        // Raw fetch instead of the SDK: the SDK version this function pins cannot set the
        // Idempotency-Key header, and that header is what makes a retry the same email.
        // The timeout, the bounded retry and the idempotency-key handling live in
        // resend.ts, where they are tested without a network.
        await sendResendEmail(payload, { apiKey: resendApiKey, from: FROM_SENDER });
      },
      async mark(accountId, kind, episodeId) {
        const { data, error } = await admin.rpc("mark_whatsapp_disconnect_emailed", {
          p_account_id: accountId,
          p_kind: kind,
          p_episode_id: episodeId,
        });
        if (error) throw error;
        return data === true;
      },
    };

    const summary = await sendDisconnectAlerts(deps, parsed.data.account_id);
    console.log(
      `[send-whatsapp-disconnect-alert] ${JSON.stringify({
        ownerSent: summary.ownerSent,
        adminSent: summary.adminSent,
        skipped: summary.skipped,
        failed: summary.failed.length,
      })}`,
    );
    return new Response(
      JSON.stringify({ ok: true, ...summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    // The raw provider/database error can carry the recipient address, a phone number
    // or a fragment of the message, so it never reaches the log as it is. What is
    // logged is a sanitized code plus the operational context needed to find the run
    // again; the response stays generic.
    console.error(
      "[send-whatsapp-disconnect-alert] run failed",
      redactSensitive({
        event: "send_whatsapp_disconnect_alert_failed",
        ...sanitizedError(error),
      }),
    );
    return new Response(
      JSON.stringify({ error: "alert run failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
