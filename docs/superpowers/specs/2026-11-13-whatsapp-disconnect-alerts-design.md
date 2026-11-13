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
| `since` | Start of the current **continuous terminal streak**. It is **null** while no terminal streak runs. | Any transient (`connecting`) observation clears it; the terminal observation that follows starts a new streak. |
| `first_seen` | Start of the **episode**. Never reset while the episode is open. | Only by `clear` (healthy / reconnected). |

- `now - since >= 10 min` → **continuous outage**. Alert. This is the primary rule. It only
  applies while a terminal streak is running, so a transient observation can never age into it.
- `now - first_seen >= 60 min` → **persistently unhealthy** (flapping or stuck). Alert. This is the
  backstop for an account that drops every few minutes; without it a pathological flap would never alert.

A transient observation may **open** the episode — it sets `first_seen` — but it never starts a
terminal streak. An account that never leaves `connecting` is broken, and the backstop needs a
`first_seen` to count from; without one, an account stuck in `connecting` would never be alerted
at all. A transient-only episode therefore has `since = null`: the ten minute rule is out of
reach for it and only the sixty minute backstop can fire.

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
2. **The call failed** (Evolution unreachable, instance gone, non-200) → count the account as
   failed. Never open an episode, never clear one, never alert. An unverifiable state is not
   evidence. The poll time **is** written: candidates are ordered by `last_polled_at` nulls
   first, and a row left unmarked would stay at the head of every run. The failure remains in
   the run summary, so the outage is still visible.
   A 404 counts as "unverifiable" and not as "terminal": a deleted instance and an Evolution
   server that lost its instances look the same from here, and treating the second as a
   terminal outage would alert every account in the product at once. The owner of a deleted
   instance is not stranded either — the account is inactive, so it shows up on the WhatsApp
   setup page as reconnectable.
3. Classify the state as healthy / transient / terminal.
4. **Healthy** → `clear_whatsapp_disconnect_episode(account_id)`: removes the episode, both email
   markers and the red flag. The exception is an account **this watcher deactivated**: the watcher
   sets `is_active = false` when it flags a dead session, and the session can come back on its own.
   For such an account the healthy poll calls `restore_whatsapp_disconnect_account(account_id)`,
   which reactivates the row and clears the episode **in one statement**. The restore is conditional
   in SQL: the row must be inactive, its open episode must carry `flagged_at` (so it is the episode
   the watcher flagged and not one the owner or the webhook opened), and it must carry no
   deliberate-disconnect marker. An account the owner disconnected on purpose, or one that was
   inactive for another reason, is never resurrected. When restore returns false, the watcher calls
   `clear_unflagged_whatsapp_disconnect_episode(account_id)`. That strips the episode, the claim,
   and both email markers, and it deletes the stored payloads. It does **not** change `is_active`,
   `needs_reauth`, or `last_refresh_error`: on an inactive row the reauth marker is the banner, and
   the ordinary clear would remove it without bringing the account back. A flagged episode and a
   deliberate disconnect are left untouched. The function is
   `supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql`.
5. **Transient** → `observe_whatsapp_disconnect_state(..., terminal = false)`: clears the terminal
   streak (`since = null`), keeps `first_seen`, and opens the episode when there is none — an account
   stuck in `connecting` needs a `first_seen` for the sixty minute backstop.
6. **Terminal** → `observe_whatsapp_disconnect_state(..., terminal = true)`: opens the episode if there is
   none, keeps `first_seen` otherwise, and starts a new terminal streak when the previous observation
   was not terminal (`since = now`).
7. Evaluate the debounce against the returned episode. If due:
   - call `flag_whatsapp_disconnect_episode(account_id, episode_id, <sanitized message>)`, which sets
     `is_active = false`, `needs_reauth = true` and `last_refresh_error` **only while that episode is
     still the open one** and the account carries no deliberate-disconnect marker. Observing and
     flagging are two calls, and an owner who reconnects (or disconnects on purpose) between them
     must win: an unconditional update would re-raise the banner on a healthy account;
   - if the flag was refused, stop: no alert is sent for an episode that is already over;
   - otherwise POST to `send-whatsapp-disconnect-alert` with the account id.

**Candidates are not filtered by `is_active`.** A disconnected Evolution account is inactive by
design — the webhook deactivates the row — so an `is_active = true` filter would skip exactly
the accounts this feature exists to alert on. An inactive deliberate marker excludes an account
the owner disconnected on purpose. Active marked rows remain candidates so SQL can recover stale
teardown intent after its 30-minute protection window.

**Flagging deactivates the account.** `is_active = false` is what makes the account appear in
the reconnectable list (`useReconnectableQrAccounts`) and in the banner's inactive query, so the
watcher sets it in the same statement that sets `needs_reauth`. Without it the red banner would
appear for an account the owner cannot resume. The account is set back to `is_active = true` in
exactly one case: a healthy poll on an account whose open episode is the one the watcher flagged
(see step 4 above). That restore is the only path that flips the flag back, and it never touches
an account the owner disconnected on purpose.

### 4.2 Bounded work

The watch function polls at most `MAX_ACCOUNTS_PER_RUN = 50` accounts per run, ordered by the least
recently polled. Poll freshness lives in `whatsapp_evolution_instances.last_polled_at`, a column the
generated types do not carry (that table is not in `src/integrations/supabase/types.ts`), so no type
regeneration is needed. The Evolution API call is the only outbound request and it is sequential and
bounded; there is no fan-out and no unbounded `waitUntil` work.

**The freshness window is shorter than the cron interval.** `last_polled_at` is written *after* the
Evolution call, so on the next five-minute tick the row's age is a little under five minutes. A
cutoff of exactly five minutes would therefore skip that account and halve the polling cadence to
ten minutes. The window is `POLL_FRESHNESS_MINUTES = POLL_CRON_INTERVAL_MINUTES - 1` (four minutes),
so every account is polled on every tick.

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
   where `platform = 'whatsapp'` **and** `connection_mode = 'evolution_qr'` **and** `is_active = false`
   **and** `needs_reauth = true`. An active `evolution_qr` row is dropped from the first query even
   when it carries `needs_reauth`: a live QR account is connected, and the marker is honoured only
   on an inactive row.
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

   `src/lib/reconnectTarget.ts` has four targets:

   - `link`: Evolution QR, to `/messaging/whatsapp/setup`.
   - `whatsapp_meta`: unflagged Meta WhatsApp (`cloud_api` / `coexistence`), through
     `useWhatsAppReconnect` and the stored-token `whatsapp-oauth` `"reconnect"` action.
   - `whatsapp_meta_connect`: flagged Meta WhatsApp, through `useWhatsAppConnect` (Embedded
     Signup), preserving `coexistence` or defaulting to `cloud_api`.
   - `oauth`: other platforms, through `useProfileOAuth`.

   **Owner decision, comment 4558985416:** the third branch is the shipped routing, not a
   verified renewal operation for an already-owned WABA. The onboarding picker limitation
   documented in `useWhatsAppConnect.ts` remains unresolved. This review pass does not change
   that branch or resolve/reply to its review thread. The owner must decide before merge.
   WhatsApp never falls through to `oauth`, which has no WhatsApp branch.

### 5.4 Where the query lives

ARCHITECTURE.md §11 forbids new raw Supabase queries inside visual components; §10 allows query
integration in hooks. `TokenReauthBanner` already contains a raw query — a pre-existing violation in a
file this change must touch. The fix is to move the query into a new hook,
`src/hooks/useAccountsNeedingReconnect.ts`, and have the banner consume it. That satisfies §11 for the
changed code and removes the violation from the banner in the same change.

The hook's React Query data is `{ accounts, partialError }`, not an account array.
`partialError` is null or `{ scope: "active" | "whatsapp_qr" }`. A single read failure keeps
accounts from the successful half and signals incomplete results. Both reads failing throws
so React Query retains its error/retry behaviour. The banner uses `data?.accounts ?? []`
and `isError || data?.partialError != null` to display retry feedback.

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

The admin email is a variant: it names the affected account and the owner (name only). It has
**no button**: the WhatsApp setup page lists the accounts of whoever opens it, so an admin would
land on their own accounts and never on the affected one — a button there would promise an
action it cannot perform. It says instead that only the owner can restore the account, by
scanning a new QR code on the WhatsApp setup page. It uses the same layout with a neutral header
gradient so an admin can tell the two apart at a glance.

**Privacy.** The email carries the account's display name and the owner's display name. It never carries a
phone number. A name that is exactly the phone number becomes "WhatsApp". A run of 7 to 15 digits
inside a longer name, including a number written with spaces, dashes, dots, parentheses, or a leading
plus, is removed before the name is HTML-escaped. The shop words stay. The same removal is applied
to the owner's display name. The rule is explicit in the existing template:

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
  "episode_id":  "3f1c…",                      // identity of THIS episode
  "since":       "2026-11-13T10:00:00.000Z",  // start of the current continuous terminal streak (null while none runs)
  "first_seen":  "2026-11-13T09:55:00.000Z",  // start of the episode
  "state":       "close",                      // the last observed Evolution state
  "observed_at": "2026-11-13T10:05:00.000Z",
  "flagged_at":  "2026-11-13T10:15:00.000Z"   // the watcher flagged this episode (and deactivated the account)
}
```

plus two sibling markers and one deliberate-disconnect marker:

| Key | Meaning |
|---|---|
| `account_metadata.whatsapp_disconnect_user_email_at` | the owner email for this episode has been sent |
| `account_metadata.whatsapp_disconnect_admin_email_at` | the admin email for this episode has been sent |
| `account_metadata.whatsapp_user_disconnected_at` | the owner disconnected this account deliberately — never alert |

**`flagged_at` is what makes the episode "the watcher's".** The flag writes it in the same
statement that sets `is_active = false`, and the conditional restore refuses any account whose
open episode does not carry it. Without that stamp, a healthy poll could reactivate an account
that was inactive for a reason that has nothing to do with this watcher.

**`episode_id` is what binds a claim to its episode.** It is generated when the episode opens
and never moves while the episode is open. The claim returns it and the mark requires it, so a
marker can never outlive its episode: a mark that arrives after the episode was closed (or after
a later episode opened) writes nothing, and the next outage is not silenced by a stale marker.

**Episode state and private payload storage.** The episode and delivery markers remain in
`account_metadata`, already typed as `Json`. Rendered payloads contain recipient addresses,
including the admin list, so they live in `public.whatsapp_disconnect_email_payloads`, not
in browser-readable metadata. The table's primary key is
`(social_account_id, kind, episode_id)`, with a cascading FK to `social_accounts`, an account
index, and `created_at`. RLS is enabled with no policies; public/browser grants are revoked,
and only `service_role` receives SELECT, INSERT, DELETE. Browser database types do not expose
this backend-only table. SQL proofs verify role denial and payload cleanup.

### 7.2 The atomic claim

One RPC per write, each `SECURITY DEFINER`, `SET search_path = public, pg_temp`, executable by `service_role` only:

| RPC | Atomicity mechanism |
|---|---|
| `observe_whatsapp_disconnect_state(p_account_id uuid, p_state text, p_terminal boolean)` | A SELECT FOR UPDATE serializes observations before the metadata update. Terminal observations preserve a continuous `since`; transient observations reset it to null while preserving `first_seen`. Inactive deliberate markers refuse observation; fresh active markers protect teardown for 30 minutes; older or unreadable active markers recover under the lock. |
| `claim_whatsapp_disconnect_email(p_account_id uuid, p_kind text, p_payload jsonb) RETURNS jsonb` | Locks the account, rejects deliberate markers and already-emailed/live claims, stores the first rendered payload, and returns `{ episode_id, payload }` or NULL. A stale claim returns the original payload so its idempotency key never carries a different body. |
| `mark_whatsapp_disconnect_emailed(p_account_id uuid, p_kind text, p_episode_id uuid)` | Writes the recipient marker only when the same episode remains open and the recipient holds a claim. |
| `clear_whatsapp_disconnect_episode(p_account_id uuid)` | Clears an active row's episode, payloads, and reconnect state. Refuses inactive rows and fresh active deliberate markers; older or unreadable active markers can recover. |
| `clear_unflagged_whatsapp_disconnect_episode(p_account_id uuid)` | Clears an inactive, unflagged episode and its payloads without changing activity or reconnect state. Refuses flagged episodes and deliberate markers. |
| `flag_whatsapp_disconnect_episode(p_account_id uuid, p_episode_id text, p_reason text)` | Matches the current episode and rejects deliberate markers before deactivating, raising reauth, and stamping `flagged_at`. |
| `restore_whatsapp_disconnect_account(p_account_id uuid)` | Reactivates only an inactive flagged episode with no deliberate marker, clearing the episode and payloads atomically. |
| `mark_whatsapp_user_disconnected(p_account_id uuid)` | Writes deliberate intent and closes the episode, claims, markers, and stored payloads. |
| `unmark_whatsapp_user_disconnected(p_account_id uuid)` | Rolls back deliberate intent only on an active Evolution QR WhatsApp row; never removes an inactive row's legitimate marker. |
| `backfill_whatsapp_legacy_disconnects(p_rollout_at timestamptz)` | Conservatively stamps inactive unmarked QR accounts. Rerun after shared teardown deployment and before enabling cron. |

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
between "claim" and "send" cannot strand the episode forever. The claim timestamps are parsed inside
an exception block: a malformed value is treated as stale, because one unreadable timestamp must
not abort the claim and silence every later alert for that account.

**The claim is per recipient, not per account.** `whatsapp_disconnect_claimed_at` is a map keyed
by `user` and `admin`, so a failing owner send never costs the admins their alert and the admin
claim never blocks the owner's.

### 7.3 What "once only" means precisely

For one disconnection episode, per recipient:

- the owner receives **at most one** email, and the admins receive **at most one** email;
- a cron tick that re-observes the same terminal state sends nothing more;
- a second `connection.update` webhook for the same outage sends nothing more (the webhook never sends
  emails in this design at all);
- a **new** outage after a successful reconnect gets its own episode and its own email — the episode is
  cleared on reconnect, which resets the markers.

**The delivery contract, stated honestly.** The guarantee is *at-most-once delivery per episode
and per recipient*, and it rests on two things working together:

1. The provider's idempotency key. Every send carries `Idempotency-Key: whatsapp-disconnect:<account>:<episode>:<recipient>`.
   The key is stable for one episode and one recipient, so a retry after a crash is **the same
   email**: Resend returns the first result instead of delivering a second copy. A later outage is
   a different episode and therefore a different key, so it is a genuinely new email. A 409 is
   classified only by the two Resend names this code knows: `concurrent_idempotent_requests` is
   retried, and `invalid_idempotent_request` is a permanent payload mismatch. Any other name in
   the body becomes the local code `idempotency_conflict`, because that name is free text and a
   string error code is copied into the log.
2. The episode-bound marker. The marker is only written when the episode it belongs to is still
   the open one, so a late completion can never silence the next outage.

What this is **not**: it is not exactly-once *processing*. A crash between "claim" and "send"
loses that one email for that episode — the retry happens 30 minutes later, and the provider
dedupes it against the first attempt, so if the first attempt never reached the provider the
retry delivers it. The provider's idempotency key is honoured for 24 hours, so a retry that
happens more than a day after the first attempt (only possible when the watcher itself has been
down for a day) could deliver a second copy. Within that window the owner is told once.

### 7.4 Clearing on reconnect

The reset is **atomic with the activation**. A `BEFORE UPDATE` trigger on `social_accounts`
(`clear_whatsapp_disconnect_on_reactivate`) fires when a WhatsApp Evolution row goes from
`is_active = false` to `is_active = true` and strips the episode, both email markers, the claims,
the deliberate-disconnect marker, `needs_reauth` and `last_refresh_error` in the same statement.

The reason is failure, not elegance. The reset used to be a separate best-effort call from the
`"open"` branch of `syncEvolutionAccountConnection`
(`supabase/functions/_shared/evolutionQrAccount.ts`). When that call failed, the old episode and
its "already emailed" marker survived the reconnect: the next outage reused that episode, the
marker silenced the new alert, and the owner never heard about a real outage. A trigger makes the
two writes inseparable, and it covers every path that flips `is_active` back to true — the
webhook's `"open"` branch, the bridge's QR poll, the reconcile path and the activation RPC —
because they all end in the same `UPDATE`.

The watcher's own clear (a healthy observation) stays best-effort, and that is safe: it runs on
**every** poll of a healthy account, so a failed clear is simply retried on the next cycle.

---

## 8. Deliberate disconnects are not outages

`disconnectWhatsAppAccount` (`supabase/functions/_shared/whatsappDisconnect.ts:222-248`) is the single
teardown for every WhatsApp mode. For an Evolution account it logs the session out, **deletes the
Evolution instance**, records `last_connection_state = 'close'` and sets `is_active = false`.

Without a marker, the watch function would poll Evolution, find no instance (or a closed one), and email
the owner "please reconnect" about a disconnect they performed on purpose.

The teardown therefore stamps `account_metadata.whatsapp_user_disconnected_at` through
`mark_whatsapp_user_disconnected`, **before** it touches the remote session, and the stamp is
mandatory: if it fails, the teardown raises before logging out or deactivating anything and the
owner retries. Once the session is gone the watcher sees a terminal state, so a teardown that
continued without the marker would produce exactly the false alert this section forbids.

A marker whose later deactivation failed must not hide an outage permanently. The teardown
attempts `unmark_whatsapp_user_disconnected` after a remote lookup exception or local
deactivation failure, then rethrows the original error. Rollback is **best-effort**; its
failure is logged. An inactive row keeps its marker because the disconnect completed there.

Candidate selection excludes inactive marked rows but includes active marked rows. Under
the row lock, observation and healthy clear protect a fresh active marker for 30 minutes
so they cannot erase intent while teardown is still in flight. An older or unreadable
marker on an active row is removed, allowing normal outage observation or healthy cleanup.
Thus rollback failure delays detection but does not suppress it indefinitely. A newly
observed outage still gets its own ten-minute terminal grace window.

`claim_whatsapp_disconnect_email` and `flag_whatsapp_disconnect_episode` reject any deliberate
marker under their row lock/update predicate. If a user disconnects between observation and
flag/claim, intent closes the episode and wins. A completed inactive deliberate disconnect
is never restored or cleared by the watcher. Reactivation clears its marker atomically.

The marker is written by the shared teardown module, so it applies to both entry points that can
disconnect an Evolution account: the `whatsapp-oauth` `"disconnect"` action
(`supabase/functions/whatsapp-oauth/index.ts:149-158`, which the frontend calls —
`src/hooks/useWhatsAppConnect.ts:138-148`) and the bridge's `logoutInstance` action
(`supabase/functions/whatsapp-evolution-bridge/index.ts:375-382`).

### 8.1 Accounts that were disconnected before this feature existed

The marker is written by the teardown, and the teardown only ran **after** this feature existed.
An account the owner disconnected *before* the rollout therefore carries no marker, and the watcher
would poll it, find a still-closed remote session, and email the owner about a disconnect they
performed on purpose — the exact false alert this section forbids.

The migration therefore runs a **one-time backfill** over every `evolution_qr` WhatsApp account
that was already `is_active = false` when it ran, and stamps each one with
`whatsapp_user_disconnected_at` set to the rollout instant (`2026-11-13 00:00:00+00`, the value the
migration passes to `public.backfill_whatsapp_legacy_disconnects`). The choice is deliberately
conservative: a missed alert is recoverable, a false "please reconnect" email about a deliberate
disconnect is not.

Consequences:

- A pre-rollout inactive account is **never alerted** and is not polled at all — the watcher skips
  inactive accounts carrying the marker.
- It re-enters the watching when it is **reactivated**: the reactivation trigger (§7.4) clears
  `whatsapp_user_disconnected_at` in the same statement as the activation, so a reactivated account
  is polled again and can alert on a future outage.
- The backfill never touches an active account, a Cloud API WhatsApp row, a Meta row, or a row that
  already carries the marker.

The migration creates the cron job **paused**, so schema application cannot start alerts.
The operator deploys both functions and the shared teardown to all consumers, waits for old
invocations to finish, reruns the backfill using `clock_timestamp()`, and only then enables
the existing job with `cron.alter_job(jobid, active := true)`. This second pass covers deliberate
disconnects during the schema/deployment gap. Full sequence: [plan section 6](../plans/2026-11-13-whatsapp-disconnect-alerts.md#6-safe-production-rollout).


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

One unapplied migration, `supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql`, includes the poll column:

```sql
-- Poll freshness for the round-robin. whatsapp_evolution_instances is not present in
-- src/integrations/supabase/types.ts (RLS revokes anon/authenticated), so this column
-- needs no type regeneration.
ALTER TABLE public.whatsapp_evolution_instances
  ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;
```

The migration also creates the backend-only payload table described in section 7.1, ten
service-role-only episode/teardown RPCs listed in section 7.2, the trusted cron URL resolver
`get_cron_functions_base_url()`, and the reactivation trigger function
`clear_whatsapp_disconnect_on_reactivate()`. Recovery and unflagged-inactive cleanup are
folded into this unapplied migration; there are no later feature migrations.

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

  IF public.get_cron_functions_base_url() IS NULL THEN
    RAISE WARNING 'whatsapp-disconnect-watch has no functions base URL yet: set the app.settings.supabase_url database setting or the vault secret functions_base_url. The job skips its call until one is configured.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch') THEN
    PERFORM cron.schedule(
      'whatsapp-disconnect-watch',
      '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
      $$
      DO $do_call$
      DECLARE
        v_url text;
      BEGIN
        SELECT public.get_cron_functions_base_url() || '/functions/v1/whatsapp-disconnect-watch' INTO v_url;
        IF v_url IS NULL THEN
          RAISE NOTICE 'whatsapp-disconnect-watch: no functions base URL configured, skipping this run';
          RETURN;
        END IF;
        PERFORM net.http_post(url := v_url, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
      END $do_call$;
      $$
    );
  END IF;
  -- Migrations alone must never start alerts. Deploy the shared teardown and both
  -- functions, rerun backfill_whatsapp_legacy_disconnects(clock_timestamp()), then
  -- explicitly enable this job with cron.alter_job(jobid, active := true).
  PERFORM cron.alter_job(jobid, active := false)
    FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch';
END $do_cron_whatsapp_disconnect_watch$;
```

The endpoint is resolved at run time through `public.get_cron_functions_base_url()` (the
`app.settings.supabase_url` database setting, then the vault secret `functions_base_url`),
so a staging or self-hosted database calls its own watcher and never production's. A
database with neither keeps the paused job; if later enabled without configuration, it skips every call.

An `app_settings` row is deliberately **not** a source. That table is editable by an
application admin, and the resolved value is the host the cron secret is sent to in an
`Authorization` header: an editable row would let an admin redirect the secret to a host
of their choosing.

**Rollout prerequisite.** Before relying on the watcher in production, the operator sets
the vault secret `functions_base_url` (for Postora,
`SELECT vault.create_secret('https://api.postora.cloud', 'functions_base_url');`) — or
sets the `app.settings.supabase_url` database setting — and verifies
`SELECT public.get_cron_functions_base_url();` returns that trusted URL. The migration
raises a `WARNING` when it finds neither, and every skipped run logs a `NOTICE`.

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
| Deep-linking the email to one specific account | The reconnect flow resumes a specific account from the page's account list (`useReconnectableQrAccounts`); there is no per-account URL today. The button targets the page. The **admin** email has no button at all: the page lists the reader's own accounts, so an admin could never reach the affected one through it. |
| Flipping `is_active` **to true** for a disconnected account | `is_active = false` is what makes the account appear in the reconnectable list and what stops the stale Baileys session from delivering webhooks. The watcher therefore sets it to **false** when it flags a dead session, matching what the webhook does. |
| Alerting on the webhook alone | The webhook can be lost, and it cannot distinguish a flap from a death. The poll is the authority (§3). |

---

## 13. Failure modes

| Failure | Behaviour |
|---|---|
| Evolution API unreachable | The account is skipped: no episode opened, no episode cleared, no alert. An unverifiable state is not evidence. |
| The webhook never fires | Irrelevant. The cron polls Evolution directly and opens the episode itself. |
| The watch function dies after claiming but before sending | The claim goes stale after 30 minutes and the next run reclaims it. The retry carries the same provider idempotency key, so it resolves to the same email and the owner is not told twice. |
| The watch function dies after sending but before marking | Same as above: the retry is the same email at the provider, and the mark then closes the episode. |
| The sender dies after sending but before marking, and the retry comes more than 24 hours later | The provider honours an idempotency key for 24 hours. Beyond that window a second copy could be delivered. Only reachable when the watcher itself has been down for a day. |
| The owner email fails but the admin email succeeds | The two are claimed independently. The owner's marker stays absent; the owner is retried once its 30-minute claim becomes stale, with the original payload and idempotency key. The admins are not emailed twice. |
| The owner profile cannot be loaded | The owner email is skipped and the failure is recorded, but the admin email still goes out: the two sides are independent. |
| The account reconnects between the poll and the email | The episode is cleared on reconnect; the next run sees a healthy state and sends nothing. The email may still arrive — acceptable, and it is why the email says what happened rather than claiming the account is still down. A mark that lands after the clear writes nothing, so it cannot silence the next outage. |
| Two cron runs overlap | The row lock plus the conditional claim make both safe: only one claim wins. |
| The account was disconnected deliberately | Skipped via `whatsapp_user_disconnected_at`, and the marker is re-checked under the row lock in both writing RPCs. |
| The phone number changed (mismatch) | No episode is opened (§2.3). |
| A stored claim timestamp is malformed | Treated as stale: the claim is retaken instead of the account being silenced forever. |

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
- `supabase/functions/whatsapp-disconnect-watch/{index.ts,run.ts,run.test.ts,dispatch.ts,dispatch.test.ts,stateReader.ts,stateReader.test.ts}`
- `supabase/functions/send-whatsapp-disconnect-alert/{index.ts,handler.ts,handler.test.ts,resend.ts,resend.test.ts}`
- `supabase/functions/_shared/errorContext.ts`
- `src/lib/reconnectTarget.ts` and its tests
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
