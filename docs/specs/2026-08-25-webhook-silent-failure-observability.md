# Spec — Make inbound-webhook failures visible

**Date:** 2026-08-25 (rev 3, after two Codex rejections)
**Origin:** `docs/investigations/2026-08-24-autoverse-instagram-n8n-trigger-no-events.md`
**Branch:** `feat/webhook-observability`

## Problem

A Business-plan user reported that Instagram DMs never reached their n8n trigger.
Diagnosis took an hour of `docker logs` archaeology and found two independent causes,
**both silent at every layer**:

1. Meta delivered the DM for IG account `17841401514313845`;
   `findAccountForRecipient` matched no `social_accounts` row, so
   `facebook-instagram-webhook` logged one `console.warn` and dropped it.
2. The user had **zero** `n8n_webhook_%` rows — the workflow was never activated —
   and no screen in Postora shows registered triggers.

Neither is observable by the user, by support, or by an admin.

## Goal

Convert each silent failure into a visible signal at the layer where the person who can
fix it will see it. **No change to delivery, matching, or dispatch behaviour.**

## Three distinct silent states (do not collapse these)

| State | Owner | Remedy |
|---|---|---|
| Meta delivered, no **active** account matched | user | connect / reactivate the right account |
| Account matched, no n8n subscription matched | user | Save + Activate the workflow |
| Subscription matched, delivery to n8n failed | user's n8n | already visible as `failure_count` |

R1 covers the first, R2 the second. The third is **out of scope** — see Deferred.

## Non-goals

- Changing how events are matched, dispatched, or retried.
- Storing message content, media URLs, profile names, **or any sender identifier**.
- Delivery-attempt telemetry (see Deferred).
- Any Meta-side configuration change.

## Requirements

### R1 — Record unroutable inbound webhook events

**Table** `public.webhook_unmatched_observations` — a **daily rollup**:

```
platform, recipient_id, event_kind, reason, observed_on (date)   -- all NOT NULL
  -> unique (platform, recipient_id, event_kind, reason, observed_on)
first_seen_at, last_seen_at, attempts, last_summary jsonb,
social_account_id (nullable), user_id (nullable)
```

Every unique-key column is `NOT NULL`; a nullable column in a unique key does not
deduplicate (Codex nit).

**The metric is `attempts`, not distinct events.** Codex round 2 was right that a unique
key deduplicates *rows*, not *events*: three unmatched messages in one entry produce
`attempts = 3`, and a Meta redelivery of that entry pushes it to 6. Rather than add a
seven-day event-id claim table — which would reintroduce exactly the cardinality problem
the rollup exists to solve — **the retry-vs-volume claim is withdrawn**. `attempts`
means "unroutable delivery attempts observed today", redeliveries included, and the
column name says so. What an operator needs from this table is *which recipient is
unroutable*, not a precise event count.

Rollup still earns its place: it bounds cardinality to distinct recipients × kinds ×
reasons × days regardless of traffic.

**Two reasons, distinguished:**

- `account_inactive` — a `social_accounts` row exists for this recipient but has
  `is_active = false`. Both resolvers filter `is_active = true`
  (`facebook-instagram-webhook/index.ts:39`, `whatsapp-webhook/index.ts:171`), so today a
  disconnected account is indistinguishable from a stranger. A **diagnostic-only** second
  lookup without that filter classifies it, records `social_account_id` and `user_id`, and
  **does not route the event**.
- `unknown_recipient` — no row at all, even inactive. The incident's case.

**Write sites and their per-branch filtering (Codex O5).** The branches are not uniform
and the spec must not pretend they are:

| Site | Event kind | Echo / self-authored |
|---|---|---|
| `facebook-instagram-webhook:154` (message) | `message` | Echoes filtered at `:151`, **before** the branch — never recorded |
| `facebook-instagram-webhook:239` (comment) | `comment` | `isOwnComment` at `:252` needs an account. With `account_inactive` the diagnostic account allows the check; with `unknown_recipient` it is **structurally impossible**, so a self-authored comment is recorded — correctly, since that is the incident's signal |
| `whatsapp-webhook:339` (live message) | `message` | The `break` sits **before** `shouldDispatchInboundMessage` at `:344`. The observation is therefore taken **after** evaluating `msg.is_echo`, so echoes are not recorded. Routing order is unchanged |
| `whatsapp-webhook:137` (non-message fields) | `unknown` | Covers `history`, `smb_message_echoes`, `smb_app_state_sync` — not inbound messages. `change.field` goes in the summary |

`threads-webhook` is **excluded**: Threads comments arrive by polling
(`threads-poll-replies` -> `_shared/threadsCommentIngest.ts`); there is no
unmatched-recipient branch to instrument.

**Ack safety.** The outer catch at `facebook-instagram-webhook/index.ts:293` returns
**500**, which makes Meta retry. Recording goes through the existing `runInBackground`
(`_shared/background.ts`), which already swallows errors. Note its degraded path awaits up
to 2s per call (`background.ts:41`), so **all observations for one request are batched into
a single background invocation** rather than one per event.

**Writer.** `public.record_unmatched_webhook_observations(...)`, `SECURITY DEFINER`,
`set search_path = public, pg_temp`.

- Takes `pg_advisory_xact_lock(hashtext(p_platform || p_observed_on))` first. Codex O2 is
  correct that a counting CTE is not race-free under `READ COMMITTED` — one atomic
  statement does not serialize the predicate. The lock makes the cap exact per
  (platform, day) at the cost of serializing only the unmatched path.
- Then upserts, incrementing `attempts`, suppressing *new* recipients past
  `WEBHOOK_UNMATCHED_DAILY_CAP` (2000) while still allowing updates to existing rows.
- Grants: `revoke execute … from public, anon` **followed by
  `grant execute … to service_role`** — revoking from `PUBLIC` also strips what
  `service_role` inherited through it, and service-role is the only intended caller.
  Because the call is best-effort inside `runInBackground`, that failure would be silent.

**Retention:** daily `pg_cron` purge of rows older than 7 days.

**Privacy.** `last_summary` holds `entry_keys`, `messaging_kinds`, `change_fields`,
`change_field`, `entry_time` — **no `sender_ids`**. Codex O4 is right: rev 2 cited the
existing `produced no inbound message` log as precedent while proposing something
stricter than it does. That log stores *key names* only, explicitly dropping `sender`
and `recipient` (`facebook-instagram-webhook/index.ts:283`). Dropping sender ids entirely
is simpler than sanitizing a user-visible projection, and it makes the user-facing RLS
policy safe by construction. `recipient_id` is length-capped at 64.

**Visibility:**

- Admin — count plus recent grouped rows on the **existing** `AdminObservability` page.
  No new page, no new route.
- User — rows where `user_id = auth.uid()`, i.e. only `account_inactive`. Safe now that
  no third-party identifier is stored. `unknown_recipient` rows have no `user_id` and are
  admin-only, because there is no user they could belong to.

### R2 — Show the user their registered triggers (both registries)

`public.list_my_webhook_subscriptions()`, `SECURITY DEFINER`:

- `set search_path = public, pg_temp`; returns zero rows when `auth.uid()` is null
- explicit projection; **`webhook_secret` / `secret` never selected**
- `app_settings` matched on an **escaped** key prefix **and** re-checked with
  `value->>'user_id' = auth.uid()::text`
- `revoke execute from public, anon`; `grant execute to authenticated`
- **UNIONs owner-scoped `whatsapp_webhooks`** with a `registry` discriminator, because
  `loadDestinations` (`_shared/n8nMessagingDispatch.ts:331-341`) reads both; an
  app_settings-only card would tell a user with a legacy WhatsApp destination they have none

`app_settings` RLS is **not** relaxed: its rows hold `webhook_secret`, and RLS is
row-level, so no policy can hide a column.

UI: a "Webhook Subscriptions" card on `/api-keys`. Empty state: *"No triggers registered.
Test-mode listening in the n8n editor does not register one — Save and Activate the
workflow."* `failure_count >= 10` renders as auto-disabled.

### R3 — Per-account webhook identity and last inbound event

`public.social_account_inbound_activity()` — `SECURITY INVOKER`, returning
`social_account_id, last_event_at, events_7d`.

**It must UNION two sources.** Codex O6: WhatsApp inbound lands in `whatsapp_messages`
(`whatsapp-webhook/index.ts:365`), not `social_inbox_events`, so a
`social_inbox_events`-only query would report "Never" for every WhatsApp account — a
diagnostic that is not merely unhelpful but actively wrong. Both tables already carry
`user_id`-scoped RLS.

UI on `/connection-health`:

- **Webhook identity** — `account_metadata.ig_igid`, then `platform_user_id`, then
  `account_metadata.ig_user_id`. All **three**, in the resolver's order
  (`facebook-instagram-webhook/index.ts:32-51`); rev 2 omitted the third. With a copy button.
- **Last inbound event** — relative time, or "Never received an inbound event".
- **Inactive accounts appear, and read as disconnected.** Removing the
  `.eq("is_active", true)` filter at `ConnectionHealth.tsx:140` is necessary but not
  sufficient: `getTokenHealth` (`:60`) never looks at `is_active`, so a disconnected
  account with a valid token would render "healthy" and offer Refresh. A `disconnected`
  status overrides token health and offers **Reconnect**.

### R4 — Confirm Instagram identity at connect time

One-time dialog after a successful Instagram connect: username **and** webhook identity,
stating that automations fire only for DMs and comments received by *this* account.

**Composition path (Codex O7).** Rev 2 named a hook as a mount point, which it is not —
`useOAuthRedirectHandler` returns nothing, its Instagram picker branch returns early at
`:125-133`, and `instagram` is absent from the `platformMessages` map at `:138`. So:

1. `useOAuthRedirectHandler` gains a returned `instagramConfirm` state carrying
   `{ socialAccountId, username, webhookIdentity }`, set on **both** Instagram flows
   (direct login and the via-Facebook picker).
2. `useProfileOAuth` (`:57`) re-exports it.
3. `Profiles.tsx` — a real page that already consumes `useProfileOAuth` — mounts the dialog.

Shown once per connect via the existing `sessionStorage` dedupe pattern (`:157`).

### R5 — n8n node: distinguish test-listen from activated

In `F:\N8N\Postora-n8n-community-node` (separate repo, never vendored here): a `notice`
property on `PostoraTrigger` — *"Test mode only listens while this editor tab is open.
Save and Activate the workflow to receive live events."*

**Constraint:** not first. n8n builds the triggers side panel from the first property whose
`displayName` is "Events" regardless of `@version`; that is `PostoraTrigger.node.ts:153`
(a second one lives at `:301`). README updated; version bump plus GitHub release per the
`n8n-node-release` skill.

## Deferred

**Delivery telemetry** (`last_delivery_at` / `last_status_code`). `updateDestination`
(`_shared/n8nMessagingDispatch.ts:458-471`) spreads a stale `settingValue` snapshot back
over the row — a read-modify-write race — loses the non-2xx status after
`deliverToDestination` throws, and ignores its own update error. Correcting that means
distinguishing attempt from success with atomic writes: its own change, its own tests.
`failure_count` already carries the signal that matters.

## Acceptance criteria

| # | Criterion |
|---|---|
| A1 | An unroutable entry carrying N events records one rollup row with `attempts = N`; a redelivery adds N more. The column measures attempts, and no test asserts retry-suppression. |
| A2 | With a DB client that throws, the webhook still returns **200** and does not enter the 500 catch. |
| A3 | A non-admin cannot select `unknown_recipient` rows; a user can select their own `account_inactive` rows; another user cannot; no row exposes a sender identifier. |
| A4 | `list_my_webhook_subscriptions()` returns only the caller's rows across **both** registries, never a secret; anon execute revoked; a second user sees none of the first's. |
| A5 | `/api-keys` with zero registrations renders the Save-and-Activate empty state. |
| A6 | `/connection-health` renders "Never received an inbound event"; an `is_active=false` account is listed as **Disconnected** with Reconnect, not "healthy" with Refresh. |
| A7 | Connecting Instagram opens the dialog exactly once from `Profiles.tsx`, showing username plus webhook identity, for **both** Instagram flows. |
| A8 | The n8n triggers side panel still lists Postora Trigger's events after the notice is added. |
| A9 | Per-branch filtering matches the table in R1: FB/IG echoes never recorded; WhatsApp echoes never recorded; WhatsApp non-message fields recorded as `unknown` with `change_field`; self-authored comments recorded only under `unknown_recipient`. |
| A10 | Under concurrent writers, the daily cap holds **exactly**: beyond the cap no new recipient row is inserted, while existing rows still increment. |
| A11 | A WhatsApp account with rows in `whatsapp_messages` shows a real last-event time, not "Never". |
| A12 | `bun run test` green; `npx tsc --noEmit` clean; `test-guard` plus `clean-code-guard` clean. |

## Deployment

Migrations do **not** auto-apply; edge functions do **not** deploy from git; the frontend
auto-deploys on merge to `main`. Strict order:

1. Apply migrations on Contabo via `ssh-contabo-mcp`.
2. **`NOTIFY pgrst, 'reload schema';`** — self-hosted PostgREST caches the schema; a new
   RPC is invisible until reloaded, and the frontend would fail on arrival.
3. RPC smoke test **over PostgREST HTTP with two real user JWTs** (Codex O8 — a JWT is
   not exercised by psql; `set role` plus `request.jwt.claims` is for the RLS unit tests,
   not for this).
4. Service-role smoke test of the writer function, proving the `service_role` grant.
5. Copy changed functions to the functions volume, SHA256-verify,
   `docker compose up -d --no-deps functions`.
6. Fault-injection smoke: POST a correctly signed payload whose `recipient_id` exceeds 64
   chars so the DB constraint rejects the insert, and confirm the ack is still **200**.
7. Only then merge to `main`.

**Rollback:** frontend first, edge-function files second, and **leave the table and RPCs
in place** — they are additive. Dropping an RPC before the frontend rollback recreates the
missing-RPC window.
