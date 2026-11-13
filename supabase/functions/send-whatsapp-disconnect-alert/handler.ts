// Pure selection, HTML rendering and the per-recipient send for the WhatsApp disconnect
// alert. The Deno.serve entrypoint builds the deps; everything here is I/O free so the
// behaviour is testable without Supabase or Resend.

export const OWNER_SUBJECT = "Your WhatsApp account needs to be reconnected";
export const ADMIN_SUBJECT = "A Postora user's WhatsApp account needs to be reconnected";
export const RECONNECT_URL = "https://postora.cloud/messaging/whatsapp/setup";

export type AlertKind = "user" | "admin";

export interface AlertAccount {
  id: string;
  user_id: string;
  platform_username: string | null;
  /** The owner's phone number. It must never reach an email. */
  platform_user_id: string;
}

export interface OwnerProfile {
  email: string;
  full_name: string | null;
  email_notifications_enabled: boolean | null;
}

export interface AdminProfile {
  email: string;
  full_name: string | null;
}

export interface SendAlertsDeps {
  loadAccount(accountId: string): Promise<AlertAccount | null>;
  loadOwnerProfile(userId: string): Promise<OwnerProfile | null>;
  loadAdmins(): Promise<AdminProfile[]>;
  isGlobalEmailEnabled(): Promise<boolean>;
  isAdminAlertEnabled(): Promise<boolean>;
  /** The episode id of the claimed episode, or null when the claim was refused. */
  claim(accountId: string, kind: AlertKind): Promise<string | null>;
  send(payload: {
    to: string[];
    subject: string;
    html: string;
    /** Stable per episode and recipient: the provider dedupes a retry on it. */
    idempotencyKey: string;
  }): Promise<void>;
  /** The episode id the mark must match: a mark for another episode is refused. */
  mark(accountId: string, kind: AlertKind, episodeId: string): Promise<boolean>;
}

export interface SendSummary {
  ownerSent: boolean;
  adminSent: boolean;
  skipped: string | null;
  failed: string[];
}

// HTML emails interpolate user-controlled values (account name, profile name); every one of
// them goes through this before it reaches the template.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The account name is the only identity this email may carry: the row also holds the owner's
 * phone number, and a notification email is forwarded, quoted and searched — never a place
 * for it.
 */
function accountLabel(account: AlertAccount): string {
  const username = account.platform_username;
  // The username may BE the phone number. A WhatsApp row whose display name was never
  // set stores the number in platform_username, and platform_user_id holds the same
  // digits. Naming it would put the owner's number in both emails, so the generic
  // label is used instead.
  if (!username || username === account.platform_user_id) return "WhatsApp";
  return escapeHtml(username);
}

function emailShell(
  headerGradient: string,
  headline: string,
  body: string,
  cta: string | null,
): string {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
      <table cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <tr>
          <td style="padding: 32px 24px; background: ${headerGradient};">
            <h1 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 700;">
              ${headline}
            </h1>
          </td>
        </tr>
        <tr>
          <td style="padding: 24px;">
            ${body}
            ${
              cta
                ? `<div style="margin: 24px 0; text-align: center;">
              <a href="${RECONNECT_URL}" style="display: inline-block; padding: 14px 32px; background-color: #ef4444; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                ${cta}
              </a>
            </div>`
                : ""
            }
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

export function buildOwnerEmail(account: AlertAccount, fullName: string | null): string {
  const body = `
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              Hi ${escapeHtml(fullName || "there")},
            </p>
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              Your WhatsApp account <strong>${accountLabel(account)}</strong> is no longer connected.
              Messages sent to it are not being delivered until you scan a new QR code.
            </p>`;
  return emailShell(
    "linear-gradient(135deg, #ef4444 0%, #d97706 100%)",
    "WhatsApp needs reconnecting",
    body,
    "Reconnect WhatsApp",
  );
}

export function buildAdminEmail(account: AlertAccount, ownerName: string | null): string {
  const owner = escapeHtml(ownerName || "a Postora user");
  // No button here: the WhatsApp setup page lists the accounts of the person who opens it,
  // so an admin would land on their own accounts and never on the affected one. The admin
  // cannot reconnect this account either way — only its owner can scan a new QR code.
  const body = `
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              The WhatsApp account <strong>${accountLabel(account)}</strong> of ${owner} is no longer
              connected and needs a new QR code before it can receive messages again.
            </p>
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              Only the account owner can restore it: they have to open
              <strong>Messaging &rarr; WhatsApp</strong> and scan a new QR code with the paired phone.
              The dashboard shows the affected account with a red reconnect banner until they do.
            </p>`;
  return emailShell(
    "linear-gradient(135deg, #334155 0%, #0f172a 100%)",
    "WhatsApp account needs reconnecting",
    body,
    null,
  );
}

/** One alert, addressed to one recipient group. */
interface Delivery {
  accountId: string;
  kind: AlertKind;
  to: string[];
  subject: string;
  html: string;
}

/** "not-claimed" means the episode was already alerted for this recipient. */
type DeliveryOutcome = "sent" | "not-claimed" | "mark-refused";

/**
 * The provider's idempotency key for one email: one episode, one recipient.
 *
 * A crash between the send and the mark leaves the claim unclosed, and the next run retries
 * the send. The key is what makes that retry the SAME email: the provider returns the first
 * result instead of delivering a second copy, so the owner is never told twice about one
 * outage. A later outage is a different episode and therefore a different key.
 */
export function idempotencyKeyFor(accountId: string, episodeId: string, kind: AlertKind): string {
  return `whatsapp-disconnect:${accountId}:${episodeId}:${kind}`;
}

/**
 * Claim before send, mark after send. The owner and the admins are claimed independently, so
 * a failure on one side never blocks the other: each records its own outcome.
 */
async function deliverEmail(deps: SendAlertsDeps, delivery: Delivery): Promise<DeliveryOutcome> {
  const episodeId = await deps.claim(delivery.accountId, delivery.kind);
  if (!episodeId) return "not-claimed";

  await deps.send({
    to: delivery.to,
    subject: delivery.subject,
    html: delivery.html,
    idempotencyKey: idempotencyKeyFor(delivery.accountId, episodeId, delivery.kind),
  });

  const marked = await deps.mark(delivery.accountId, delivery.kind, episodeId);
  if (!marked) return "mark-refused";
  return "sent";
}

/** The outcome of one recipient group: did the email go out, and did anything fail. */
interface RecipientOutcome {
  sent: boolean;
  failed: boolean;
}

async function deliverToOwner(
  deps: SendAlertsDeps,
  account: AlertAccount,
  owner: OwnerProfile,
): Promise<RecipientOutcome> {
  try {
    const outcome = await deliverEmail(deps, {
      accountId: account.id,
      kind: "user",
      to: [owner.email],
      subject: OWNER_SUBJECT,
      html: buildOwnerEmail(account, owner.full_name),
    });
    if (outcome === "mark-refused") {
      console.error(`[send-whatsapp-disconnect-alert] account ${account.id}: owner mark refused`);
      return { sent: false, failed: true };
    }
    return { sent: outcome === "sent", failed: false };
  } catch {
    // Logged with the account id only: never the recipient address or a phone number.
    console.error(`[send-whatsapp-disconnect-alert] account ${account.id}: owner email failed`);
    return { sent: false, failed: true };
  }
}

async function deliverToAdmins(
  deps: SendAlertsDeps,
  account: AlertAccount,
  ownerName: string | null,
): Promise<RecipientOutcome> {
  try {
    const admins = await deps.loadAdmins();
    if (admins.length === 0) return { sent: false, failed: false };

    const outcome = await deliverEmail(deps, {
      accountId: account.id,
      kind: "admin",
      to: admins.map((admin) => admin.email),
      subject: ADMIN_SUBJECT,
      html: buildAdminEmail(account, ownerName),
    });
    if (outcome === "mark-refused") {
      console.error(`[send-whatsapp-disconnect-alert] account ${account.id}: admin mark refused`);
      return { sent: false, failed: true };
    }
    return { sent: outcome === "sent", failed: false };
  } catch {
    console.error(`[send-whatsapp-disconnect-alert] account ${account.id}: admin email failed`);
    return { sent: false, failed: true };
  }
}

export async function sendDisconnectAlerts(
  deps: SendAlertsDeps,
  accountId: string,
): Promise<SendSummary> {
  const summary: SendSummary = { ownerSent: false, adminSent: false, skipped: null, failed: [] };

  const account = await deps.loadAccount(accountId);
  if (!account) {
    summary.skipped = "account not found";
    return summary;
  }
  if (!(await deps.isGlobalEmailEnabled())) {
    summary.skipped = "email notifications disabled";
    return summary;
  }

  // The owner email and the admin email are independent: a profile lookup that fails must
  // cost the owner their email, not the admins theirs. The failure is recorded and the run
  // continues without an owner name.
  let owner: OwnerProfile | null = null;
  try {
    owner = await deps.loadOwnerProfile(account.user_id);
  } catch {
    console.error(
      `[send-whatsapp-disconnect-alert] account ${account.id}: owner profile lookup failed`,
    );
    summary.failed.push(account.id);
  }

  if (owner && owner.email_notifications_enabled === true) {
    const outcome = await deliverToOwner(deps, account, owner);
    summary.ownerSent = outcome.sent;
    if (outcome.failed) summary.failed.push(account.id);
  }

  if (await deps.isAdminAlertEnabled()) {
    const outcome = await deliverToAdmins(deps, account, owner?.full_name ?? null);
    summary.adminSent = outcome.sent;
    if (outcome.failed) summary.failed.push(account.id);
  }

  summary.failed = [...new Set(summary.failed)];
  return summary;
}
