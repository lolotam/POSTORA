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
// losing the alert or sending it twice.

import type { DegradedProvider } from "./aiProviderHealth.ts";

const CREDENTIAL_LABEL: Record<DegradedProvider["auth_method"], string> = {
  api_key: "API key",
  oauth: "subscription",
};

export function buildAlertTitle(p: DegradedProvider): string {
  return `AI provider needs attention: ${p.provider_code}`;
}

export function buildAlertMessage(p: DegradedProvider): string {
  const state = p.status === "needs_relogin" ? "needs re-login" : "failed";
  const reason = p.reason ? `: ${p.reason}` : ".";
  return `${p.provider_code} (${CREDENTIAL_LABEL[p.auth_method]}) ${state}${reason}`;
}

export function alertRowsToDegraded(rows: Array<Record<string, unknown>>): DegradedProvider[] {
  return rows.map((row) => ({
    provider_code: String(row.provider_code ?? ""),
    auth_method: row.auth_method === "oauth" ? "oauth" : "api_key",
    status: row.status === "needs_relogin" ? "needs_relogin" : "failed",
    reason: typeof row.reason === "string" ? row.reason : null,
  }));
}

/** The provider row a degraded provider is reported under, in the admin card's wording. */
export function buildAlertHtml(degraded: DegradedProvider[]): string {
  const rows = degraded.map((p) => `
    <tr style="border-bottom: 1px solid #e5e7eb;">
      <td style="padding: 12px; font-size: 14px;">
        <strong>${p.provider_code}</strong>
        <br><span style="color: #6b7280; font-size: 12px;">${CREDENTIAL_LABEL[p.auth_method]}</span>
      </td>
      <td style="padding: 12px; font-size: 14px; color: #dc2626;">
        ${p.status === "needs_relogin" ? "Needs re-login" : "Failed"}
      </td>
      <td style="padding: 12px; font-size: 12px; color: #6b7280;">
        ${p.reason ?? "-"}
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

/** The channel the alert travels on. */
export interface AdminMailer {
  /** The admins' addresses. An empty list means there is nobody to tell. */
  adminRecipients(): Promise<string[]>;
  /** Sends one email. Throws when the provider refused it, so the claim stays open. */
  send(to: string[], subject: string, html: string): Promise<void>;
}

/**
 * Sends one degradation alert to the admins. With no admin address there is nobody
 * to tell, so the alert is dropped rather than failing the run.
 */
export async function sendDegradedProviderAlert(
  mailer: AdminMailer,
  degraded: DegradedProvider,
): Promise<void> {
  const to = await mailer.adminRecipients();
  if (!to.length) return;
  await mailer.send(to, buildAlertTitle(degraded), buildAlertHtml([degraded]));
}
