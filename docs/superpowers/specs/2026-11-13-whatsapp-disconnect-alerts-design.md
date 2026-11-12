# WhatsApp disconnect alerts — design

**Date:** 2026-11-13
**Status:** proposed (owner request 2026-11-13)
**Branch:** `feat/whatsapp-disconnect-alerts` (cut from `origin/main` @ `13455738`)
**Scope:** a WhatsApp account connected through the self-hosted Evolution API (`connection_mode = 'evolution_qr'`) that goes offline must (1) raise the existing dashboard red flag, (2) email the account owner **and** the admins, and (3) optionally raise an in-app notification.

---

## 1. Problem

When a Baileys session dies, Postora learns about it through Evolution's `connection.update` webhook
(`supabase/functions/whatsapp-evolution-webhook/connectionUpdate.ts:26`). The webhook's only durable effect
is deactivation:

```ts
// supabase/functions/_shared/evolutionQrAccount.ts:206-214
if (connection === "close") {
  const { error } = await admin
    .from("social_accounts")
    .update({ is_active: false })
    .eq("id", account.id);
  if (error) throw error;
  await emitConnectionTransition(admin, account.id, previous, false);
  return account.platform_user_id;
}
```

That is the whole reaction. `social_accounts.is_active = false` is invisible on the dashboard, because the
one red-flag banner is scoped to accounts that are **active but flagged**:

```ts
// src/components/dashboard/TokenReauthBanner.tsx:40-45
const { data, error } = await supabase
  .from("social_accounts")
  .select("id, platform, platform_username, needs_reauth, last_refresh_error, social_profile_id")
  .eq("user_id", user.id)
  .eq("is_active", true)
  .eq("needs_reauth", true);
```

A disconnected Evolution account is therefore *invisible*: no banner, no email, no admin signal. The owner
discovers the outage when a customer says their messages stopped arriving.

Two further facts shape the design:

- The Evolution instance still exists after a spontaneous disconnect, and it still reports a terminal
  connection state. Postora can therefore ask Evolution "is this still connected?" — it does not have to
  trust the webhook.
- A user can deliberately disconnect an Evolution WhatsApp account from the WhatsApp page
  (`src/components/messaging/WhatsAppSetup.tsx:340-348` renders the Disconnect button for every connected
  account, including `isEvolutionQr`). A deliberate disconnect must **not** produce a "please reconnect" email.

---

## 2. Vocabulary: what "disconnected, needs a new QR" means

### 2.1 What the code knows today

Postora records the last Evolution state on the instance row:

```ts
// supabase/functions/whatsapp-evolution-webhook/connectionUpdate.ts:37-41
const state = String(payload.state || payload.connection || payload.status || "").toLowerCase();
if (!state) return undefined;
await admin.from("whatsapp_evolution_instances")
  .update({ last_connection_state: state })
  .eq("social_account_id", account.id);
```

`syncEvolutionAccountConnection` acts on exactly two states and ignores the rest
(`supabase/functions/_shared/evolutionQrAccount.ts:203-204`):

```ts
const connection = state.toLowerCase();
if (connection !== "open" && connection !== "close") return account.platform_user_id;
```

The bridge's QR poll reads the state straight from Evolution
(`supabase/functions/whatsapp-evolution-bridge/qr.ts:17-21`):

```ts
export function extractState(payload: unknown): string | null {
  const root = object(payload);
  const state = object(root.instance).state || root.state || root.connectionStatus;
  return typeof state === "string" && state.length > 0 ? state : null;
}
```

and `evolutionApi.connectionState` hits `GET /instance/connectionState/{instance}`
(`supabase/functions/_shared/evolutionApi.ts:205`). The bridge treats only `"open"` as success
(`supabase/functions/whatsapp-evolution-bridge/reconnect.ts:81`).

### 2.2 The classification this design uses

| Class | States | Meaning for an Evolution QR account |
|---|---|---|
| **Healthy** | `open` | The session is live. |
| **Transient** | `connecting` | Baileys is (re)connecting. Baileys emits `close` then `connecting` during a *normal* reconnect — this is the flap we must not alert on. |
| **Terminal** | everything else, including `close`, `timeout`, `unpaired`, `logged_out`, `qr`, and any state this codebase has never seen | The session is gone. The phone must scan a new QR code for the account to work again. |

The classification is **fail-safe**: an unknown future state is treated as terminal, and only a state that
is *still* terminal after the grace window (and confirmed by a second, independent poll) produces an alert.
A state we have never seen therefore causes at worst one extra email after ten minutes, never a missed
outage.

Two states are deliberately excluded from the candidate set entirely:

- `pending_%` rows — a QR attempt that never paired (`supabase/functions/sweep-pending-whatsapp-qr/`). They
  are not accounts yet, so there is nothing to reconnect. The existing sweep removes them after 30 minutes
  (`supabase/migrations/20261112200000_sweep_pending_whatsapp_qr_cron.sql:1-5`).
- `retired_%` rows — numbers Postora has handed back.

### 2.3 Number mismatch is not a disconnect

When a *different* phone is paired, `syncEvolutionAccountConnection` refuses the activation and flags
`account_metadata.number_mismatch` (`supabase/functions/_shared/evolutionQrAccount.ts:233-256`). The
instance state in that path is not a terminal connection state, so it does not open an episode. The
mismatch already has its own owner-facing surface (the QR setup page shows the expected number). Firing a
"disconnected" email on top of it would be a second, redundant notification for the same incident. **Number
mismatch is out of scope for this feature** — see §12.

---

## 3. The debounce rule (decision)

> **A WhatsApp account is alerted only when Evolution has reported a terminal connection state for it
> continuously for at least 10 minutes, confirmed by a poll, with no non-terminal observation in between.
> Independently, an account that has been non-healthy for 60 minutes within the same episode is alerted
> even if it keeps flapping between terminal and transient states.**

Formally, the episode record holds two timestamps:

| Field | Meaning | Reset by |
|---|---|---|
| `since` | Start of the current **continuous terminal streak**. | Any transient (`connecting`) observation. |
| `first_seen` | Start of the **episode**. Never reset while the episode is open. | Only by `clear` (healthy / reconnected). |

- `now - since >= 10 min` → **continuous outage**. Alert. This is the primary rule.
- `now - first_seen >= 60 min` → **persistently unhealthy** (flapping or stuck). Alert. This is the
  backstop for an account that drops every few minutes; without it a pathological flap would never alert.

Both the dashboard red flag and the email use this one rule, evaluated in one place. There is no second
debounce, no "flag immediately, email later" split, and no timer in the browser.

**Why the poll, not the webhook, decides.** The webhook is the fast path but it is not trustworthy: it
fires from Evolution's server, it can be lost, and it is not the component that decides whether a `close`
was a flap or a death. The poll asks Evolution directly (`GET /instance/connectionState/{instance}`) and
sees the *current* state. Two consequences:

1. A flap (`close` → `connecting` → `open`) never reaches the alert threshold: the transient observation
   resets `since`, and the healthy observation clears the episode.
2. The feature works **even when the webhook never fires** (Evolution restarted, webhook URL unreachable,
   a dropped connection). The webhook stays exactly as it is today; it is not modified by this feature.

**Why 10 minutes.** Baileys' own reconnect cycle is a matter of seconds; Evolution's `connecting` → `open`
round trip after a dropped socket is typically well under a minute. Ten minutes is long enough that no
ordinary reconnect reaches it, and short enough that an owner finds out the same afternoon. It is a
deliberate round number, and it is a single constant (`DISCONNECT_GRACE_MINUTES = 10`) in the watch
function.

**Why 60 minutes.** A number that reconnects successfully in the first ten minutes is not broken. A
number that has been down for an hour — in any pattern — is broken, and the owner has no other signal.

---

## 4. Architecture

```
              Evolution API                          Postgres
                  │                                     │
   ┌──────────────┴───────────────┐        ┌────────────┴────────────┐
   │ whatsapp-disconnect-watch    │───────▶│ social_accounts         │
   │ (cron, every 5 min)          │        │  .account_metadata      │
   │  1. list paired QR accounts  │        │    .whatsapp_disconnect  │
   │  2. GET connectionState      │        │    .whatsapp_disconnect_user_email_at
   │  3. classify                 │        │    .whatsapp_disconnect_admin_email_at
   │  4. observe / clear episode  │        │    .whatsapp_user_disconnected_at
   │  5. flag needs_reauth        │        │  .needs_reauth          │
   │  6. POST the sender          │        │  .last_refresh_error    │
   └──────────────┬───────────────┘        └─────────────────────────┘
                  │  service-role POST
                  ▼
   ┌──────────────────────────────┐
   │ send-whatsapp-disconnect-alert│──▶ Resend ──▶ owner email
   │ (one email per recipient     │           └─▶ admin email (all admins)
   │  kind, claimed atomically)   │
   └──────────────────────────────┘
```

Two edge functions, split by responsibility:

- **`whatsapp-disconnect-watch`** — the detector. Cron entrypoint, authenticates with the cron secret,
  polls Evolution, owns the episode state machine, sets the red flag, and dispatches the alert.
- **`send-whatsapp-disconnect-alert`** — the sender. Service-role entrypoint, claims each recipient
  atomically, renders the HTML, sends through Resend.

The split mirrors the existing `refresh-tokens` → `send-token-failure-alert` relationship
(`supabase/functions/send-token-failure-alert/index.ts`) and keeps the detector testable without Resend.

### 4.1 The watch function's loop

For each candidate account, in one run:

1. Read the Evolution state: `GET /instance/connectionState/{instance_name}`.
2. **The call failed** (Evolution unreachable, instance gone, non-200) → **skip the account entirely**.
   Never open an episode, never clear one, never alert. An unverifiable state is not evidence.
3. Classify the state as healthy / transient / terminal.
4. **Healthy** → `clear_whatsapp_disconnect_episode(account_id)`: removes the episode, both email
   markers and the red flag.
5. **Transient** → `observe_whatsapp_disconnect_state(..., terminal = false)`: restarts the streak
   (`since = now`), keeps `first_seen`.
6. **Terminal** → `observe_whatsapp_disconnect_state(..., terminal = true)`: opens the episode if there is
   none, keeps `since` / `first_seen` otherwise.
7. Evaluate the debounce against the returned episode. If due:
   - set `needs_reauth = true` and `last_refresh_error = <sanitized message>` on the account row;
   - POST to `send-whatsapp-disconnect-alert` with the account id.

### 4.2 Bounded work

The watch function polls at most `MAX_ACCOUNTS_PER_RUN = 50` accounts per run, ordered by the least
recently polled. Poll freshness lives in `whatsapp_evolution_instances.last_polled_at`, a column the
generated types do not carry (that table is not in `src/integrations/supabase/types.ts`), so no type
regeneration is needed. The Evolution API call is the only outbound request and it is sequential and
bounded; there is no fan-out and no unbounded `waitUntil` work.

---

## 5. The dashboard red flag

### 5.1 Reuse, not a second banner

`TokenReauthBanner` is the only red-flag banner system for reconnectable accounts, and it is already
mounted on the dashboard (`src/pages/Dashboard.tsx:42`). This feature reuses it. **No new banner component
is created** (ARCHITECTURE.md §1, "Zero Dead Modules", and the owner's explicit instruction).

The banner is driven by two columns that already exist on `social_accounts`:

- `needs_reauth` — "this account needs the owner to act" (`src/integrations/supabase/types.ts:7141`).
- `last_refresh_error` — the detail line under the message (`src/integrations/supabase/types.ts:7140`).

Setting them on a WhatsApp Evolution row makes the existing banner render it, with the existing
destructive variant, the existing dismiss button and the existing minute-by-minute refetch
(`src/components/dashboard/TokenReauthBanner.tsx:51`).

### 5.2 Why `needs_reauth` is free on this table

`needs_reauth` is otherwise written by the token-refresh path, and the two paths must not collide. They
do not:

- The refresh sweep only selects accounts with a token to refresh:
  `.or('token_expires_at.not.is.null,auth_provider.eq.composio')`
  (`supabase/functions/refresh-tokens/index.ts:1322`).
- An Evolution QR account is created with `access_token: ''` and **no** `token_expires_at` and **no**
  `refresh_token` (`supabase/functions/whatsapp-evolution-bridge/index.ts:231-237`, the
  `create_and_get_qr` insert).
- `auth_provider` defaults to `'native'`
  (`supabase/migrations/20260903120100_youtube_composio_provider.sql:10`).

So an `evolution_qr` row never enters the refresh sweep and `needs_reauth` on such a row belongs
exclusively to this feature. The same holds for `last_refresh_error`.

### 5.3 The exact changes needed for a WhatsApp row to appear

Two changes, both in the frontend:

1. **The query must see inactive WhatsApp rows.** The banner currently filters `.eq("is_active", true)`
   (`src/components/dashboard/TokenReauthBanner.tsx:44`), but a disconnected Evolution account is
   `is_active = false` by design (`_shared/evolutionQrAccount.ts:209`). It must additionally select rows
   where `platform = 'whatsapp'` **and** `connection_mode = 'evolution_qr'` **and** `is_active = false`.
   `is_active` must **not** be flipped to `true`: the reconnectable-account list depends on it
   (`src/hooks/useReconnectableQrAccounts.ts:27`), and the webhook's account lookup filters on it
   (`supabase/functions/whatsapp-evolution-webhook/index.ts`, `findAccount`) so that a deactivated
   account's stale session stops delivering webhooks.
2. **The Reconnect button must not go through the OAuth flow.** The banner calls
   `handleReconnectPlatform(social_profile_id, platform, account.id)`
   (`src/components/dashboard/TokenReauthBanner.tsx:67-71`), and `useProfileOAuth.handleReconnectPlatform`
   has branches for tiktok, instagram, facebook, linkedin, twitter, threads, bluesky and reddit — and
   **none for whatsapp** (`src/hooks/useProfileOAuth.tsx:96-152`). A WhatsApp QR account reconnects by
   scanning a new QR code on the WhatsApp setup page
   (`src/components/messaging/WhatsAppSetup.tsx`, `handleQrReconnect` → the bridge's `reconnect_qr`
   action), so the button must link to `/messaging/whatsapp/setup`.

### 5.4 Where the query lives

ARCHITECTURE.md §11 forbids new raw Supabase queries inside visual components; §10 allows query
integration in hooks. `TokenReauthBanner` already contains a raw query — a pre-existing violation in a
file this change must touch. The fix is to move the query into a new hook,
`src/hooks/useAccountsNeedingReconnect.ts`, and have the banner consume it. That satisfies §11 for the
changed code and removes the violation from the banner in the same change.

### 5.5 The banner text

Reuse the existing `reauth.*` keys where they fit and add only what is genuinely new. The new copy is
about a *session* ending, not a *token* expiring:

- title: `"{{platform}} Disconnected"` — the existing `reauth.connectionExpired` ("Connection Expired") is
  wrong wording for a dropped Baileys session.
- body: the existing `reauth.accountWithUsernameNeedsReconnect` / `reauth.accountNeedsReconnect` keys.
- action: a new `reauth.reconnectWhatsapp` key ("Reconnect WhatsApp"), because the button is a link, not
  the OAuth flow.

New keys must be added to `src/i18n/locales/ar/dashboard.json`; `scripts/check-i18n-coverage.mjs` fails
the build when a key is used in code but missing from the bundle, **and** when a bundle key is no longer
used in code.

---

## 6. The emails

### 6.1 Recipients

| Recipient | Resolution | Gate |
|---|---|---|
| **Account owner** | `social_accounts.user_id` → `profiles.email` | `profiles.email_notifications_enabled = true` and the global `feature_email_notifications` flag is not `false` |
| **Admins** | `user_roles` where `role = 'admin'` → `profiles` where `email_notifications_enabled = true` | the global flag and the new `admin_email_whatsapp_disconnect_alerts` app setting (default on) |

Both are the patterns already in the codebase:

- the owner lookup with `email_notifications_enabled` —
  `supabase/functions/send-undelivered-store-alerts/index.ts:49-57`;
- the admin lookup — `supabase/functions/send-token-failure-alert/index.ts:313-337`, which selects
  `user_roles` where `role = 'admin'` and then `profiles` where `email_notifications_enabled = true`, and
  sends **one** email addressed to all admins (`:462-467`);
- the global flag — `app_settings` key `feature_email_notifications`, read in
  `supabase/functions/send-token-expiry-notifications/index.ts:192-211`, where a missing row means enabled.

### 6.2 Two independent sends

The owner email and the admin email are claimed and sent **independently**, so a failure on one side
never blocks the other. Each has its own once-only marker.

### 6.3 Template

Modelled on `supabase/functions/send-undelivered-store-alerts/handler.ts:71-118`, which is the closest
existing template (same product, same page, same 600px table layout, same gradient header, same centred
button):

- 600px table, `#f3f4f6` page background, white card.
- Red gradient header (`#ef4444` → `#d97706`) with the headline.
- Body paragraph naming the account by `platform_username` only.
- A centred **"Reconnect WhatsApp"** button in `#ef4444` linking to
  `https://postora.cloud/messaging/whatsapp/setup` — the page where the QR reconnect happens
  (`src/components/messaging/WhatsAppSetup.tsx`, `handleQrReconnect`).
- A muted footer: "This is an automated alert from Postora."

The admin email is a variant: it names the affected account, the owner (name only), and repeats the same
CTA. It uses the same layout with a neutral header gradient so an admin can tell the two apart at a
glance.

**Privacy.** The email carries the account's display name and the owner's display name. It never carries a
phone number. The rule is explicit in the existing template:

```ts
// supabase/functions/send-undelivered-store-alerts/handler.ts:66-75
/**
 * The account name is the only identity this email may carry: the row also holds the
 * owner's phone number, and a notification email is forwarded, quoted and searched —
 * never a place for it.
 */
```

Every interpolated value goes through the same `escapeHtml` helper
(`supabase/functions/send-undelivered-store-alerts/handler.ts:57-64`).

### 6.4 Sender identity and delivery logging

- From address: `Postora <notifications@postora.cloud>` — the same sender as
  `send-token-expiry-notifications` and `send-undelivered-store-alerts`
  (`supabase/functions/send-undelivered-store-alerts/index.ts:12`).
- The admin email is sent to all admins in one `to` array, as `send-token-failure-alert` does
  (`supabase/functions/send-token-failure-alert/index.ts:462-467`).
- Delivery status: the only live delivery-tracking mechanism in this repo is `admin_inbox_messages`
  (direction `outbound`, `resend_id`, `status`), which `process-scheduled-emails` writes
  (`supabase/functions/process-scheduled-emails/index.ts:140-147`) and which
  `sync-resend-delivery-status` polls. The `email_log` table exists in the schema but **nothing reads
  it** — writing there would be a dead write (ARCHITECTURE.md §1).
  The nearest live precedent, `send-undelivered-store-alerts`, logs a per-account summary line
  (`supabase/functions/send-undelivered-store-alerts/handler.ts:163`) and returns
  `{eligible, sent, failed}` as its JSON summary. This feature follows that precedent: a structured
  `console.log` summary plus the JSON response. It does **not** write to `admin_inbox_messages`, because
  that table feeds the admin inbox UI (`src/hooks/useAdminInbox.ts`) and a user-facing transactional email
  does not belong in the operator's inbox.

### 6.5 The new admin toggle

`app_settings` has no seed rows for the email toggles; the readers treat a missing row as "enabled"
(`supabase/functions/send-token-failure-alert/index.ts:142`: `settingsMap[row.key] = parsed !== false`).
The new key `admin_email_whatsapp_disconnect_alerts` therefore needs no migration seed — only a new entry
in the admin UI toggle list (`src/components/admin/AdminNotificationSettings.tsx:15-21`).

The **owner** email is gated only by the global flag and `profiles.email_notifications_enabled`. A
WhatsApp number that has stopped receiving customers' messages is the account owner's business, and the
product already emails the owner about a disconnected WhatsApp account in the store-orders case without a
separate admin toggle (`send-undelivered-store-alerts`). A dedicated per-user toggle is a follow-up
(§12).

---

## 7. Idempotency — one alert per disconnection episode

### 7.1 The episode record

The episode lives on the account row in `account_metadata`, the same place the repo already keeps the
undelivered-store-orders incident (`account_metadata.undelivered_store_events`):

```jsonc
"whatsapp_disconnect": {
  "since":       "2026-11-13T10:00:00.000Z",  // start of the current continuous terminal streak
  "first_seen":  "2026-11-13T09:55:00.000Z",  // start of the episode
  "state":       "close",                      // the last observed Evolution state
  "observed_at": "2026-11-13T10:05:00.000Z"
}
```

plus two sibling markers and one deliberate-disconnect marker:

| Key | Meaning |
|---|---|
| `account_metadata.whatsapp_disconnect_user_email_at` | the owner email for this episode has been sent |
| `account_metadata.whatsapp_disconnect_admin_email_at` | the admin email for this episode has been sent |
| `account_metadata.whatsapp_user_disconnected_at` | the owner disconnected this account deliberately — never alert |

**Why `account_metadata` and not a new table.** The repo's established idiom for "one email per incident"
is a JSONB key plus a set of SECURITY DEFINER RPCs
(`supabase/migrations/20261004100000_whatsapp_setup_summary_and_undelivered_flag.sql:76-156`). A new table
would additionally require RLS policies, grants, indexes and a regenerated `types.ts`
(ARCHITECTURE.md §23: "Schema changes must be reflected in generated/maintained TypeScript database
types"), and no local regeneration path exists in this repo. `account_metadata` is already typed as `Json`
in `src/integrations/supabase/types.ts`, so the JSONB route needs **no type change at all**.

### 7.2 The atomic claim

One RPC per write, each `SECURITY DEFINER`, `SET search_path = public`, executable by `service_role` only:

| RPC | Atomicity mechanism |
|---|---|
| `observe_whatsapp_disconnect_state(p_account_id uuid, p_state text, p_terminal boolean)` | A single `UPDATE ... SET account_metadata = jsonb_set(...)` with the whole episode computed inside the statement. The row lock serialises two concurrent pollers; the loser sees the winner's `since` and preserves it. `since` and `first_seen` are never rewritten by a terminal observation. |
| `claim_whatsapp_disconnect_email(p_account_id uuid, p_kind text)` | A conditional `UPDATE` that sets `whatsapp_disconnect_claimed_at` **only** when the recipient's marker is absent, and only when no live claim exists. `RETURN FOUND` is the claim: exactly one caller can win. |
| `mark_whatsapp_disconnect_emailed(p_account_id uuid, p_kind text)` | Sets the recipient's marker after a successful send. |
| `clear_whatsapp_disconnect_episode(p_account_id uuid)` | Removes the episode, both markers and the red flag. |
| `mark_whatsapp_user_disconnected(p_account_id uuid)` | Sets the deliberate-disconnect marker. |

The claim shape is copied from the existing incident claim, including its stale-claim window:

```sql
-- supabase/migrations/20261004100000_whatsapp_setup_summary_and_undelivered_flag.sql:145-152
UPDATE social_accounts
   SET account_metadata = jsonb_set(account_metadata, '{undelivered_alert_claimed_at}', to_jsonb(clock_timestamp()::text))
 WHERE id = p_account_id
   AND account_metadata->'undelivered_store_events'->>'since' = p_since
   AND NOT (account_metadata ? 'undelivered_alert_email_at')
   AND (NOT (account_metadata ? 'undelivered_alert_claimed_at')
        OR (account_metadata->>'undelivered_alert_claimed_at')::timestamptz < clock_timestamp() - interval '30 minutes');
RETURN FOUND;
```

A claim older than 30 minutes is treated as a failed send and may be retaken, so a process that dies
between "claim" and "send" cannot strand the episode forever.

### 7.3 What "once only" means precisely

For one disconnection episode, per recipient:

- the owner receives **at most one** email, and the admins receive **at most one** email;
- a cron tick that re-observes the same terminal state sends nothing more;
- a second `connection.update` webhook for the same outage sends nothing more (the webhook never sends
  emails in this design at all);
- a **new** outage after a successful reconnect gets its own episode and its own email — the episode is
  cleared on reconnect, which resets the markers.

### 7.4 Clearing on reconnect

`clear_whatsapp_disconnect_episode` is called from the one place where an Evolution account becomes active
again: the `"open"` branch of `syncEvolutionAccountConnection`
(`supabase/functions/_shared/evolutionQrAccount.ts:224`, `updates = { is_active: true }`). That single
call site covers all three activation paths — the webhook, the bridge's QR poll, and the reconcile path —
because all three funnel through `syncEvolutionAccountConnection`.

It clears: the episode object, both email markers, the deliberate-disconnect marker,
`needs_reauth = false` and `last_refresh_error = null`.

---

## 8. Deliberate disconnects are not outages

`disconnectWhatsAppAccount` (`supabase/functions/_shared/whatsappDisconnect.ts:222-248`) is the single
teardown for every WhatsApp mode. For an Evolution account it logs the session out, **deletes the
Evolution instance**, records `last_connection_state = 'close'` and sets `is_active = false`.

Without a marker, the watch function would poll Evolution, find no instance (or a closed one), and email
the owner "please reconnect" about a disconnect they performed on purpose.

The teardown therefore stamps `account_metadata.whatsapp_user_disconnected_at` through
`mark_whatsapp_user_disconnected`. The watch function skips any account carrying that marker. The marker
is cleared by `clear_whatsapp_disconnect_episode`, so a deliberate disconnect followed by a fresh QR
pairing behaves normally from then on.

The marker is written by the shared teardown module, so it applies to both entry points that can
disconnect an Evolution account: the `whatsapp-oauth` `"disconnect"` action
(`supabase/functions/whatsapp-oauth/index.ts:149-158`, which the frontend calls —
`src/hooks/useWhatsAppConnect.ts:138-148`) and the bridge's `logoutInstance` action
(`supabase/functions/whatsapp-evolution-bridge/index.ts:375-382`).

---

## 9. In-app notification — decision

**Decision: no new in-app notification is added. The dashboard red flag *is* the in-app notification.**

Justification from the code:

1. `admin_notifications` is an admin-authored broadcast with no target-user column. The repo states this
   itself: *"This is not `admin_notifications`, which has no target-user column."*
   (`docs/superpowers/specs/2026-10-01-whatsapp-account-continuity-design.md:205`).
2. `system_notifications` **does** support per-user targeting — `target_type = 'user'` with
   `target_users uuid[]` (`supabase/tests/baseline_schema.sql:8097-8120`), the RLS policy *"All users can
   view active notifications"* resolves it per caller
   (`supabase/tests/baseline_schema.sql:17389-17391`), and there is a per-user RPC `get_my_notifications`
   (`supabase/tests/baseline_schema.sql:2071-2104`). Edge functions already write to it
   (`supabase/functions/threads-webhook/index.ts:126`, `supabase/functions/threads-mentions/index.ts:87`).
3. **But nothing in the frontend ever reads it.** `get_my_notifications` appears in
   `src/integrations/supabase/types.ts:11982` and nowhere else in `src/` — the Threads mention
   notifications those two functions write are invisible to the user who received them.

Writing a `system_notifications` row would therefore be a write nobody can see: a dead write under
ARCHITECTURE.md §1, and a user told nothing. The only visible per-user in-app surface for this class of
problem is the dashboard red flag, which requirement 1 already covers and which the owner sees on every
page load.

Building the consumer (wiring `get_my_notifications` into a notification centre) is a separate, larger
feature. It is recorded as a follow-up in §12.

---

## 10. Schema change

One migration, `supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql`:

```sql
-- Poll freshness for the round-robin. whatsapp_evolution_instances is not present in
-- src/integrations/supabase/types.ts (RLS revokes anon/authenticated), so this column
-- needs no type regeneration.
ALTER TABLE public.whatsapp_evolution_instances
  ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;
```

That is the **only** schema change. Everything else is `account_metadata` JSONB keys, `needs_reauth`,
`last_refresh_error` — all already typed — plus five SECURITY DEFINER RPCs.

Index (ARCHITECTURE.md §23, "index foreign keys and frequent filters where appropriate"):

```sql
CREATE INDEX IF NOT EXISTS whatsapp_evolution_instances_last_polled_at_idx
  ON public.whatsapp_evolution_instances (last_polled_at)
  WHERE last_polled_at IS NOT NULL;
```

### 10.1 The cron job

Following the repo's guarded-DO-block pattern (e.g.
`supabase/migrations/20261112200000_sweep_pending_whatsapp_qr_cron.sql:7-24`):

```sql
DO $do_cron_whatsapp_disconnect_watch$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'whatsapp-disconnect-watch cron not scheduled: pg_cron or get_cron_secret() is missing';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch') THEN
    PERFORM cron.schedule(
      'whatsapp-disconnect-watch',
      '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/whatsapp-disconnect-watch', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
      $$
    );
  END IF;
END $do_cron_whatsapp_disconnect_watch$;
```

The minutes are offset from the top of the hour so the run does not land on `*/5` with the other jobs.
The cron secret is resolved at run time through `public.get_cron_secret()`; no credential is stored in
the migration or in `cron.job.command`.

The sender is **not** a cron job — the watch function calls it with the service role, so the two never
run concurrently on their own.

---

## 11. Edge function shape

Both functions follow ARCHITECTURE.md §12 (an entrypoint is an adapter) and §13–16.

### `whatsapp-disconnect-watch`

| File | Role |
|---|---|
| `supabase/functions/whatsapp-disconnect-watch/index.ts` | `Deno.serve` adapter: CORS via `restrictedCorsHeaders`, auth via `verifyCronAuth`, builds the deps, returns the JSON summary. |
| `supabase/functions/whatsapp-disconnect-watch/run.ts` | The pure state machine and orchestration, expressed against injected ports. No Supabase, no Resend, no `Deno.env`. |
| `supabase/functions/whatsapp-disconnect-watch/run.test.ts` | Deno tests for the state machine. |

This is exactly the `sweep-pending-whatsapp-qr` shape (`index.ts` / `run.ts` / `run.test.ts`).

The ports the pure module declares: `listCandidates`, `readState`, `observe`, `clear`, `markFlagged`,
`dispatchAlert`, `now`.

### `send-whatsapp-disconnect-alert`

| File | Role |
|---|---|
| `supabase/functions/send-whatsapp-disconnect-alert/index.ts` | Service-role adapter: validates the request body with Zod, builds the deps, returns the JSON summary. |
| `supabase/functions/send-whatsapp-disconnect-alert/handler.ts` | Pure selection, HTML rendering and the per-recipient orchestration. |
| `supabase/functions/send-whatsapp-disconnect-alert/handler.test.ts` | Deno tests for selection, escaping and the claim/send/mark order. |

Authentication: the sender is called by the watch function with the **service-role key** as a bearer
token, exactly as `refresh-tokens` calls `send-token-failure-alert`. The sender rejects any request that
does not carry it, and it validates the body with Zod (ARCHITECTURE.md §15).

`supabase/config.toml` gains:

```toml
[functions.whatsapp-disconnect-watch]
verify_jwt = false

[functions.send-whatsapp-disconnect-alert]
verify_jwt = false
```

Both are behind the service role / cron secret, and `verify_jwt = false` is the pattern the other cron
functions use (`[functions.sweep-pending-whatsapp-qr] verify_jwt = false`).

Errors are sanitised: the response body carries a generic message and the raw provider error goes to the
log only (ARCHITECTURE.md §16, and the pattern at
`supabase/functions/send-undelivered-store-alerts/index.ts:91-101`).

---

## 12. Out of scope

| Item | Why |
|---|---|
| Number-mismatch incidents | A different cause with its own owner-facing surface (§2.3). A separate email for the same incident would double-notify. |
| A new per-user email toggle for disconnect alerts | The owner email is gated by the global flag and `profiles.email_notifications_enabled`. The admin email has its own toggle. A dedicated per-user toggle is a follow-up. |
| A notification centre that renders `get_my_notifications` | The per-user in-app channel exists in the database but has no frontend consumer (§9). Building it is a separate feature. |
| Deep-linking the email to one specific account | The reconnect flow resumes a specific account from the page's account list (`useReconnectableQrAccounts`); there is no per-account URL today. The button targets the page. |
| Flipping `is_active` for a disconnected account | `is_active = false` is what makes the account appear in the reconnectable list and what stops the stale Baileys session from delivering webhooks. |
| Alerting on the webhook alone | The webhook can be lost, and it cannot distinguish a flap from a death. The poll is the authority (§3). |

---

## 13. Failure modes

| Failure | Behaviour |
|---|---|
| Evolution API unreachable | The account is skipped: no episode opened, no episode cleared, no alert. An unverifiable state is not evidence. |
| The webhook never fires | Irrelevant. The cron polls Evolution directly and opens the episode itself. |
| The watch function dies after claiming but before sending | The claim goes stale after 30 minutes and the next run reclaims it. |
| The owner email fails but the admin email succeeds | The two are claimed independently. The owner's marker stays absent, so the owner is emailed on the next run; the admins are not emailed twice. |
| The account reconnects between the poll and the email | The episode is cleared on reconnect; the next run sees a healthy state and sends nothing. The email may still arrive — acceptable, and it is why the email says what happened rather than claiming the account is still down. |
| Two cron runs overlap | The row lock plus the conditional claim make both safe: only one claim wins. |
| The account was disconnected deliberately | Skipped via `whatsapp_user_disconnected_at`. |
| The phone number changed (mismatch) | No episode is opened (§2.3). |

---

## 14. UNVERIFIED

These could not be confirmed from the repository alone. Each is stated with what is needed to verify it.

1. **The exact Evolution connection-state vocabulary.** The code treats `open` and `close` as the only
   meaningful states (`_shared/evolutionQrAccount.ts:204`), and the QR flow records `connecting`
   (`whatsapp-evolution-webhook/index.ts`, `handleQrUpdate`). The wider Baileys/Evolution enum
   (`timeout`, `unpaired`, `logged_out`, `conflict`, …) is **not** enumerated anywhere in this repo, and
   Evolution is a self-hosted third-party service, so its exact values are unverified. *Needed:* a live
   `GET /instance/connectionState/{instance}` against the deployed Evolution instance, or the Evolution API
   version's own state enum. **Mitigation:** the classification is fail-safe — every state that is not
   `open` and not `connecting` is terminal, so an unknown state is handled without needing the enum.
2. **Whether Evolution reports `qr` for a previously paired instance, and what it reports for an instance
   that was deleted.** The code does not record these. *Needed:* a live probe of a disconnected instance.
   **Mitigation:** `qr` is terminal in the classification, which is correct for a dead paired session, and
   the deleted-instance case is handled by the "call failed → skip" rule.
3. **The exact interval Baileys needs to complete a normal reconnect.** The 10-minute grace is chosen to be
   far above it, not measured from it. *Needed:* live timing of `close` → `connecting` → `open` on a
   dropped socket in the deployed Evolution instance.
4. **Whether the production Evolution deployment has any accounts at all.** The number of paired
   `evolution_qr` accounts determines the poll load. *Needed:* a count query against the live
   `social_accounts` table.
5. **That `system_notifications` has no frontend consumer.** Established by grepping `src/` for
   `get_my_notifications` and `from("system_notifications")` — only the generated type mentions them. The
   production deployment could in principle carry a frontend bundle not in this repository, but Postora's
   frontend deploys from this repository, so this is treated as verified. *Needed:* confirm on the deployed
   bundle if the owner wants certainty.
6. **The live `app_settings` value of `admin_email_whatsapp_disconnect_alerts`.** The key is new, so no row
   exists; the readers treat a missing row as enabled. *Needed:* nothing, unless the owner wants it off by
   default.
7. **The `RESEND_API_KEY` sender identity.** `notifications@postora.cloud` is the sender used by the two
   existing cron senders, but whether it is verified in the Resend domain is a live-account fact.
   *Needed:* check the Resend domain, or send one test message.

---

## 15. Files this design touches

**New**

- `supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql`
- `supabase/tests/whatsapp_disconnect_alerts.sql`
- `supabase/functions/whatsapp-disconnect-watch/{index.ts,run.ts,run.test.ts}`
- `supabase/functions/send-whatsapp-disconnect-alert/{index.ts,handler.ts,handler.test.ts}`
- `src/hooks/useAccountsNeedingReconnect.ts`
- `src/hooks/__tests__/useAccountsNeedingReconnect.test.tsx`

**Changed**

- `supabase/functions/_shared/evolutionQrAccount.ts` — clear the episode on the `"open"` branch
- `supabase/functions/_shared/whatsappDisconnect.ts` — stamp the deliberate-disconnect marker
- `src/components/dashboard/TokenReauthBanner.tsx` — consume the hook; WhatsApp button links to the QR page
- `src/i18n/locales/ar/dashboard.json` — the new banner strings
- `src/components/admin/AdminNotificationSettings.tsx` — the new admin toggle
- `supabase/config.toml` — `verify_jwt = false` for the two new functions
- `.github/workflows/ci.yml` — a Deno check/test step for the new functions
- `scripts/db-harness.sh` — register the new SQL test

**Not changed:** the Evolution webhook, the Evolution bridge, `social_accounts`'s column set, the generated
database types.
