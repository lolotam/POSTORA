import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { AdminMailer } from "../_shared/aiProviderAlert.ts";
import { MAX_ALERT_SEND_TIMEOUT_MS } from "../_shared/aiProviderHealth.ts";

type Admin = SupabaseClient;

/**
 * The sender of the degradation alert.
 *
 * WHY not the shared test domain
 * notifications@resend.dev is restricted to permitted testing recipients. The
 * sibling alert (send-token-failure-alert) already sends from the verified
 * sender, so the degradation alert uses the same one.
 */
const ALERT_SENDER = "Postora Alerts <admin@postora.cloud>";

/** A mail send cannot outlive the runner's five-second ceiling. */
const RESEND_TIMEOUT_MS = MAX_ALERT_SEND_TIMEOUT_MS;

/** The admin mailer: the admins from user_roles/profiles, delivered by Resend. */
export function createAdminMailer(admin: Admin): AdminMailer {
  return {
    async adminRecipients(signal = AbortSignal.timeout(5_000)): Promise<string[]> {
      const { data: roles, error: rolesError } = await admin
        .from("user_roles")
        .select("user_id")
        .eq("role", "admin").abortSignal(signal);
      if (rolesError) throw new Error("admin role read failed");
      const ids = (roles ?? []).map((r) => (r as { user_id: string }).user_id).filter(Boolean);
      if (!ids.length) return [];
      const { data: profiles, error: profilesError } = await admin
        .from("profiles")
        .select("id, email")
        .in("id", ids).abortSignal(signal);
      if (profilesError) throw new Error("admin profile read failed");
      return (profiles ?? [])
        .map((p) => (p as { email?: unknown }).email)
        .filter((email): email is string => typeof email === "string" && email.length > 0);
    },
    async send({ to, subject, html, text, idempotencyKey, signal }): Promise<void> {
      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (!resendKey) {
        // No mail provider configured: the alert cannot be delivered. Throwing keeps
        // the claim open, so the row is re-claimed instead of the alert being lost.
        throw new Error("RESEND_API_KEY is not configured");
      }
      const sender = Deno.env.get("RESEND_FROM_EMAIL")?.trim() || ALERT_SENDER;
      if (/@(?:[^>\s]+\.)?resend\.dev(?:[>\s]|$)/i.test(sender)) {
        throw new Error("RESEND_FROM_EMAIL must use a verified sending domain");
      }
      if (!idempotencyKey) throw new Error("An alert idempotency key is required");
      const headers: Record<string, string> = {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      };
      // The id of the break. The same break always carries the same key, so a claim
      // that is re-claimed after a run that died between the send and the close
      // is deduplicated within the transport's 24-hour retention window.
      headers["Idempotency-Key"] = idempotencyKey;
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: sender,
          to,
          subject,
          html,
          ...(text ? { text } : {}),
        }),
        // A mail provider that hangs must not eat the whole time budget. The runner
        // passes the tighter of the alert budget and the send ceiling.
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(RESEND_TIMEOUT_MS)])
          : AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (!response.ok) {
        // The body can quote the request, so only the status is reported.
        throw new Error(`the mail provider refused the alert (HTTP ${response.status})`);
      }
    },
  };
}

