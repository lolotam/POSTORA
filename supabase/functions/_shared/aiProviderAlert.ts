// The admin alert for a provider that just degraded.
//
// WHY an admin-only email
// admin_notifications is a BROADCAST: it is the table behind the global bell, so every
// signed-in user would read "the operator's OpenAI key is failing". A degradation
// alert belongs in the admin-only channel, so it reuses the existing admin-email
// pattern (notify-expiring-ai-overrides): the admins from user_roles/profiles and
// Resend.
//
// WHY the message is so plain
// The email reaches only the operator, but it still carries no secret and no user
// data: a provider code, a credential kind and a sanitized sentence.
//
// WHY the claim is two phases
// The row is claimed, the mail is sent, then the claim is closed. A run that dies
// between the send and the close re-claims the row after ten minutes instead of
// losing the alert. The transport deduplicates retries within its 24-hour window.

import type { DegradedProvider } from "./aiProviderHealth.ts";

const CREDENTIAL_LABEL: Record<DegradedProvider["auth_method"], string> = {
  api_key: "API key",
  oauth: "subscription",
};

/**
 * The reason and the provider name end up inside an HTML email. The reason comes
 * from a provider, so it is not trusted to be plain text: everything that reaches
 * the markup goes through here first.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The provider's display name, with the code as the fallback. */
function providerLabel(p: DegradedProvider): string {
  return p.display_name || p.provider_code;
}

export function buildAlertTitle(p: DegradedProvider): string {
  return `AI provider needs attention: ${providerLabel(p)}`;
}

export function buildAlertMessage(p: DegradedProvider): string {
  const state = p.status === "needs_relogin" ? "needs re-login" : "failed";
  const reason = p.reason ? `: ${p.reason}` : ".";
  return `${providerLabel(p)} (${CREDENTIAL_LABEL[p.auth_method]}) is ${state}${reason}`;
}

export function alertRowsToDegraded(rows: Array<Record<string, unknown>>): DegradedProvider[] {
  return rows.map((row) => ({
    provider_code: String(row.provider_code ?? ""),
    // The event snapshot keeps retries byte-stable after a provider rename.
    display_name: typeof row.display_name === "string" ? row.display_name : String(row.provider_code ?? ""),
    auth_method: row.auth_method === "oauth" ? "oauth" : "api_key",
    status: row.status === "needs_relogin" ? "needs_relogin" : "failed",
    reason: typeof row.reason === "string" ? row.reason : null,
    // The break's id. It is what makes a re-claimed alert the SAME alert.
    alert_id: typeof row.alert_id === "string" && row.alert_id ? row.alert_id : null,
  }));
}

/** The provider row a degraded provider is reported under, in the admin card's wording. */
export function buildAlertHtml(degraded: DegradedProvider[]): string {
  const rows = degraded.map((p) => `
    <tr style="border-bottom: 1px solid #e5e7eb;">
      <td style="padding: 12px; font-size: 14px;">
        <strong>${escapeHtml(providerLabel(p))}</strong>
        <br><span style="color: #6b7280; font-size: 12px;">${CREDENTIAL_LABEL[p.auth_method]}</span>
      </td>
      <td style="padding: 12px; font-size: 14px; color: #dc2626;">
        ${p.status === "needs_relogin" ? "Needs re-login" : "Failed"}
      </td>
      <td style="padding: 12px; font-size: 12px; color: #6b7280;">
        ${escapeHtml(p.reason ?? "-")}
      </td>
    </tr>
  `).join("");

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>AI Provider Needs Attention</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #f9fafb; padding: 20px;">
        <div style="max-width: 700px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <div style="background: linear-gradient(135deg, #dc2626 0%, #f97316 100%); padding: 24px 32px;">
            <h1 style="color: white; margin: 0; font-size: 24px;">
              ⚠️ AI Provider Needs Attention
            </h1>
            <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0 0; font-size: 14px;">
              ${degraded.length} provider(s) stopped working
            </p>
          </div>

          <div style="padding: 24px 32px;">
            <p style="color: #374151; margin: 0 0 16px 0;">
              The daily provider check found a provider that was connected and is now failing. Open the admin AI Providers card to test it again.
            </p>

            <table style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
              <thead>
                <tr style="background: #f9fafb;">
                  <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Provider</th>
                  <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Status</th>
                  <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Reason</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
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
}

/** How one alert is sent. */
export interface AdminMailer {
  /** The admins' addresses. An empty list means there is nobody to tell. */
  adminRecipients(signal?: AbortSignal): Promise<string[]>;
  /**
   * Sends one email. Throws when the provider refused it, so the claim stays open.
   *
   * `input.idempotencyKey` is the id of the break the alert is about. The mail
   * provider refuses a second send with the same key, so a claim that is re-claimed
   * after a run that died between the send and the close cannot send twice.
   *
   * `input.signal` bounds the send. A send that runs out of time throws, and a
   * throw leaves the claim open.
   */
  send(input: {
    to: string[];
    subject: string;
    html: string;
    text?: string;
    idempotencyKey: string | null;
    signal?: AbortSignal;
  }): Promise<void>;
}

/**
 * Sends one degradation alert to the admins. Missing recipients leave the event
 * retryable; the runner catches the failure without acknowledging the outbox.
 */
export async function sendDegradedProviderAlert(
  mailer: AdminMailer,
  degraded: DegradedProvider,
  signal?: AbortSignal,
): Promise<void> {
  const to = await mailer.adminRecipients(signal);
  if (!to.length) throw new Error("No admin alert recipients are available");
  await mailer.send({
    to,
    subject: buildAlertTitle(degraded),
    html: buildAlertHtml([degraded]),
    text: buildAlertMessage(degraded),
    idempotencyKey: degraded.alert_id,
    signal,
  });
}
