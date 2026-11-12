// Service-role entrypoint for the WhatsApp disconnect alert emails (spec
// 2026-11-13-whatsapp-disconnect-alerts-design.md). Modelled on send-token-expiry-notifications:
// the caller authenticates with the service role, Resend and a service-role client implement the
// deps, and every PostgREST result is checked explicitly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import {
  sendDisconnectAlerts,
  type AdminProfile,
  type AlertAccount,
  type OwnerProfile,
  type SendAlertsDeps,
} from "./handler.ts";

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
 */
function settingEnabled(value: unknown): boolean {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
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

    const resend = new Resend(resendApiKey);
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
        return data === true;
      },
      async send(payload) {
        const { error } = await resend.emails.send({
          from: FROM_SENDER,
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
        });
        if (error) throw new Error(error.message);
      },
      async mark(accountId, kind) {
        const { data, error } = await admin.rpc("mark_whatsapp_disconnect_emailed", {
          p_account_id: accountId,
          p_kind: kind,
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
    // Raw database/provider errors stay in the log; the response is generic.
    console.error(
      "[send-whatsapp-disconnect-alert] run failed:",
      error instanceof Error ? error.message : String(error),
    );
    return new Response(
      JSON.stringify({ error: "alert run failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
