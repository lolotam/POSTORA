// Pure selection logic and the per-account orchestrator for the undelivered
// store-orders alert email. The Deno.serve entrypoint (index.ts) builds the deps;
// everything here is I/O-free so the behaviour is testable without Supabase or Resend.

export interface UndeliveredAccountRow {
  id: string;
  user_id: string;
  platform: string;
  platform_username: string | null;
  // A social_accounts column (20260116191438), not a metadata key.
  alerts_snoozed: boolean | null;
  account_metadata: {
    undelivered_store_events?: { since?: string; last_at?: string } | null;
    undelivered_alert_email_at?: string | null;
  } | null;
}

export interface ProfileRow {
  email: string;
  full_name: string | null;
  email_notifications_enabled: boolean | null;
}

export interface SendAlertsDeps {
  listFlagged(): Promise<UndeliveredAccountRow[]>;
  loadProfile(userId: string): Promise<ProfileRow | null>;
  claim(accountId: string, since: string): Promise<boolean>;
  send(payload: { to: string; subject: string; html: string }): Promise<void>;
  mark(accountId: string, since: string): Promise<boolean>;
  now(): Date;
}

export const ALERT_SUBJECT = "Store orders are waiting on a disconnected WhatsApp account";

// One email per flagged account: once an alert email has gone out the row is never
// eligible again. There is no "new incident on the same flag" case — the flag and this
// marker are removed together by clear_undelivered_if_none_held, so the next incident
// starts with neither set.
export function selectAccountsToEmail(
  rows: UndeliveredAccountRow[],
  now: Date,
): UndeliveredAccountRow[] {
  const nowMs = now.getTime();
  return rows.filter((row) => {
    if (row.platform !== "whatsapp") return false;
    if (row.alerts_snoozed) return false;
    const since = row.account_metadata?.undelivered_store_events?.since;
    if (!since) return false;
    const sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs) || sinceMs > nowMs) return false;
    return !row.account_metadata?.undelivered_alert_email_at;
  });
}

// HTML emails interpolate user-controlled values (account name, profile name);
// every one of them goes through this before it reaches the template.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The account name is the only identity this email may carry: the row also holds the
 * owner's phone number, and a notification email is forwarded, quoted and searched —
 * never a place for it.
 */
export function buildAlertEmail(
  account: UndeliveredAccountRow,
  fullName: string | null,
): string {
  const accountName = escapeHtml(account.platform_username || "WhatsApp");
  const setupUrl = "https://postora.cloud/messaging/whatsapp/setup";
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
      <table cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <tr>
          <td style="padding: 32px 24px; background: linear-gradient(135deg, #ef4444 0%, #d97706 100%);">
            <h1 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 700;">
              Store orders are waiting
            </h1>
          </td>
        </tr>
        <tr>
          <td style="padding: 24px;">
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              Hi ${escapeHtml(fullName || "there")},
            </p>
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              Your WhatsApp account <strong>${accountName}</strong> is disconnected, and
              incoming store orders are being held instead of delivered. Order messages
              will still be sent once the account is reconnected.
            </p>
            <div style="margin: 24px 0; text-align: center;">
              <a href="${setupUrl}" style="display: inline-block; padding: 14px 32px; background-color: #ef4444; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                Reconnect or move setup
              </a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding: 24px; background-color: #f9fafb; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #6b7280; font-size: 12px; text-align: center;">
              This is an automated alert from Postora.
            </p>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

/**
 * Claim before send, mark after send. A failure at any stage — profile, claim, send or
 * mark — is isolated to its own account: it is recorded in `failed` and the loop moves
 * on, so one broken account can never stop the others from being alerted.
 */
export async function sendAlerts(
  deps: SendAlertsDeps,
): Promise<{ eligible: number; sent: number; failed: string[] }> {
  const rows = await deps.listFlagged();
  const eligible = selectAccountsToEmail(rows, deps.now());

  let sent = 0;
  const failed: string[] = [];
  for (const account of eligible) {
    const since = account.account_metadata?.undelivered_store_events?.since;
    if (!since) continue;

    let stage: "profile" | "claim" | "send" | "mark" = "profile";
    try {
      const profile = await deps.loadProfile(account.user_id);
      if (!profile || profile.email_notifications_enabled !== true) continue;

      stage = "claim";
      const claimed = await deps.claim(account.id, since);
      if (!claimed) continue;

      stage = "send";
      await deps.send({
        to: profile.email,
        subject: ALERT_SUBJECT,
        html: buildAlertEmail(account, profile.full_name),
      });

      stage = "mark";
      const marked = await deps.mark(account.id, since);
      if (!marked) {
        console.error(`[send-undelivered-store-alerts] account ${account.id}: mark refused`);
        failed.push(account.id);
        continue;
      }
      sent += 1;
    } catch {
      // Logged with the account id only: never the recipient email or a phone number.
      console.error(`[send-undelivered-store-alerts] account ${account.id}: ${stage} failed`);
      failed.push(account.id);
    }
  }

  return { eligible: eligible.length, sent, failed };
}
