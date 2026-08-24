# Plan — Make inbound-webhook failures visible

**Rev 3**, after two Codex rejections. Spec:
`docs/specs/2026-08-25-webhook-silent-failure-observability.md`
Branch: `feat/webhook-observability` (cut from `main` at `4f7fb8e3`)

Every new module names its production (non-test) call site, per ARCHITECTURE.md §1
"Zero Dead Modules".

---

## Step 1 — Migration: rollup table, writer, retention

**File:** `supabase/migrations/20260825090000_webhook_unmatched_observations.sql`

`public.webhook_unmatched_observations` — every unique-key column `NOT NULL`:

| column | notes |
|---|---|
| `id` | uuid pk |
| `platform` | not null, check in (`facebook`,`instagram`,`whatsapp`) |
| `recipient_id` | not null, `check (length(recipient_id) <= 64)` |
| `event_kind` | not null, check in (`message`,`comment`,`unknown`) |
| `reason` | not null, check in (`unknown_recipient`,`account_inactive`) |
| `observed_on` | not null date, default `current_date` |
| `first_seen_at` / `last_seen_at` | timestamptz not null |
| `attempts` | integer not null default 1 |
| `last_summary` | jsonb not null default `'{}'` |
| `social_account_id` | uuid null, FK `social_accounts(id) on delete set null` |
| `user_id` | uuid null, FK `auth.users(id) on delete cascade` |

`unique (platform, recipient_id, event_kind, reason, observed_on)`; indexes on
`(observed_on desc, platform)` and `(user_id, observed_on desc) where user_id is not null`.

**RLS — asymmetric on purpose:**

```sql
create policy "Admins view unmatched observations" ... using (public.has_role(auth.uid(),'admin'));
create policy "Users view own unmatched observations" ... using (user_id = auth.uid());
```

Safe for users only because `last_summary` carries no sender identifier (spec R1 Privacy).

**Writer** `public.record_unmatched_webhook_observations(p_platform, p_observations jsonb)`
— batched, one call per request:

1. `perform pg_advisory_xact_lock(hashtext(p_platform || current_date::text));`
   Codex O2: a counting CTE is not race-free under `READ COMMITTED`. The lock serializes
   only the unmatched path and makes A10 exact.
2. Count today's distinct recipients for the platform.
3. `insert … on conflict (…) do update set attempts = … + excluded.attempts,
   last_seen_at = now(), last_summary = excluded.last_summary`, filtering out *new*
   recipients past `WEBHOOK_UNMATCHED_DAILY_CAP = 2000` while still updating existing rows.
4. `SECURITY DEFINER`, `set search_path = public, pg_temp`,
   `revoke execute from public, anon`, then **`grant execute to service_role`**.

**Retention:** cron `purge-webhook-unmatched-observations` at `17 3 * * *`, deleting
`observed_on < current_date - 7`, using the `DO $$ … cron.unschedule … EXCEPTION`
idempotency pattern from `20260823090000_threads_reply_poller_cron.sql`.

**Verify (`ssh-contabo-mcp`, real psql):** constraints and both policies; batch upsert
increments `attempts` by N; **two concurrent sessions** cannot both cross the cap;
`set role authenticated` + `request.jwt.claims` proves cross-user denial; service_role
can execute; anon cannot.

---

## Step 2 — Migration: read functions

**File:** `supabase/migrations/20260825090100_webhook_observability_functions.sql`

**`list_my_webhook_subscriptions()`** — `SECURITY DEFINER`,
`set search_path = public, pg_temp`, empty when `auth.uid() is null`. Returns
`registry, webhook_id, webhook_url, events, platform, social_account_id, is_active,
failure_count, created_at`. Two UNIONed arms:

- `'n8n'` — `app_settings` where key matches the escaped prefix
  (`like 'n8n\_webhook\_' || auth.uid()::text || '\_%' escape '\'`) **and**
  `value->>'user_id' = auth.uid()::text`; `webhook_secret` never in the select list.
- `'legacy'` — `whatsapp_webhooks where user_id = auth.uid()`; `secret` never selected.

`revoke execute from public, anon; grant execute to authenticated;`

**`social_account_inbound_activity()`** — `SECURITY INVOKER`. **UNIONs
`social_inbox_events` and `whatsapp_messages`** (Codex O6 — WhatsApp inbound never reaches
`social_inbox_events`, so a single-source query reports "Never" for every WhatsApp
account). Returns `social_account_id, last_event_at, events_7d`.

**Verify:** both over **PostgREST HTTP with two real JWTs** — cross-user isolation, anon
denial, and no `webhook_secret`/`secret` column in the response.

---

## Step 3 — Edge functions

### 3a. `_shared/unmatchedWebhookObservation.ts` (new)

- `buildObservation({ platform, recipientId, eventKind, entry, change, account })` — pure;
  summary is `entry_keys`, `messaging_kinds`, `change_fields`, `change_field`,
  `entry_time`. **No sender identifiers.**
- `flushObservations(adminClient, platform, observations)` — one RPC call for the whole
  request, so the degraded `runInBackground` path (`background.ts:41`, up to 2s) is paid
  once rather than per event.

**Call sites:** `facebook-instagram-webhook/index.ts:154`, `:239`;
`whatsapp-webhook/index.ts:137`, `:339`.

### 3b. `facebook-instagram-webhook/index.ts`

- Add `findAnyAccountForRecipient` — the same three-column resolution **without**
  `.eq("is_active", true)`. Diagnostic only; classifies `reason`, never routes. The active
  lookup at `:39` is untouched.
- Collect observations per request; one `runInBackground("unmatched-observations", …)`
  after the entry loop, before the 200. The existing `console.warn`s stay.
- Response path and the 500 catch at `:293` untouched.

### 3c. `whatsapp-webhook/index.ts`

- `:137` — non-message fields; `event_kind = 'unknown'`, `change_field` in the summary.
- `:339` — the `break` precedes the echo filter at `:344`, so evaluate
  `shouldDispatchInboundMessage({ isEcho: msg.is_echo })` **before recording**. Routing
  order is unchanged; only the observation is gated.
- Same diagnostic lookup, without `.eq("is_active", true)` (`:171`).

**Deploy:** copy to the functions volume via `ssh-contabo-mcp`, SHA256-verify,
`docker compose up -d --no-deps functions`.

---

## Step 4 — Generated DB types

Extend `src/integrations/supabase/types.ts` with the table and the three functions
(ARCHITECTURE §23).

---

## Step 5 — Feature module (ARCHITECTURE §2/§3)

`src/features/webhook-observability/` — the first `src/features/` module. Layout follows
§3 and Codex's nit:

```
domain/webhookIdentity.ts             pure: ig_igid -> platform_user_id -> ig_user_id
infrastructure/webhookSubscriptions.ts  rpc adapter
infrastructure/inboundActivity.ts       rpc adapter
infrastructure/unmatchedObservations.ts admin query adapter
ui/hooks/useWebhookSubscriptions.ts
ui/hooks/useInboundActivity.ts
ui/hooks/useUnmatchedObservations.ts
ui/WebhookSubscriptionsCard.tsx
ui/InstagramConnectConfirmDialog.tsx
index.ts
```

**Named call sites:** `WebhookSubscriptionsCard` -> `src/pages/ApiKeys.tsx`;
`useInboundActivity` + `webhookIdentity` -> `src/pages/ConnectionHealth.tsx`;
`useUnmatchedObservations` -> `src/pages/admin/AdminObservability.tsx` (exists — no new
route); `InstagramConnectConfirmDialog` -> `src/pages/Profiles.tsx`.

---

## Step 6 — UI

- **`/api-keys`** — mount `WebhookSubscriptionsCard`, grouped by `registry`.
- **`/connection-health`** — add `platform_user_id` + `account_metadata` to the select at
  `:138` (neither is fetched today), drop `.eq("is_active", true)` at `:140`, add a
  `disconnected` status that **overrides** `getTokenHealth` (`:60`) and offers Reconnect,
  render identity + copy + last-inbound-event.
- **`AdminObservability.tsx`** — an unmatched-observations count and recent grouped rows.
- **Instagram connect** — `useOAuthRedirectHandler` returns `instagramConfirm` for both
  Instagram flows (direct at `:70`, picker at `:125`); `useProfileOAuth` (`:57`)
  re-exports; `Profiles.tsx` mounts the dialog.

---

## Step 7 — Tests

**Deno** (`_shared/unmatchedWebhookObservation.test.ts`): summary contains no sender id;
`reason` resolution; batching produces one RPC call for N observations; a throwing client
does not propagate.

**Deno, handler-level** (`facebook-instagram-webhook`, `whatsapp-webhook`): with a
throwing DB client the handler returns **200** and does not enter the 500 catch (A2);
per-branch filtering matches the R1 table (A9) — FB/IG echo, WhatsApp echo, WhatsApp
`history` field, self-authored comment under each reason.

**SQL, real Postgres** via `ssh-contabo-mcp` on a throwaway DB in the prod container:
both RLS policies via `set role` + `request.jwt.claims`; the cap under **two concurrent
sessions** (A10); retention delete; service_role execute.

**PostgREST HTTP, real JWTs:** cross-user isolation and secret omission for
`list_my_webhook_subscriptions` (A4) — not psql, which never exercises the JWT path.

**Vitest:** `webhookIdentity` (all three fallbacks, missing metadata);
`WebhookSubscriptionsCard` loading/error/empty/populated/auto-disabled (A5);
ConnectionHealth disconnected-vs-healthy rendering and "Never" (A6);
`InstagramConnectConfirmDialog` opens once per connect for both flows (A7);
the admin panel's empty and populated states. **No `userEvent`** (clipboard) — `fireEvent`.

Gates: `test-guard`, `clean-code-guard`, `bun run test`, `npx tsc --noEmit`.

---

## Step 8 — n8n node (separate repo)

`F:\N8N\Postora-n8n-community-node` @ v1.8.0: add the `notice` **after** the first
`displayName: "Events"` property (`PostoraTrigger.node.ts:153`), update README,
`npx tsc --noEmit` + `npm test` + `npm run build`, bump, GitHub release. Verify the
side panel still renders (A8).

---

## Step 9 — Land

PR -> CodexBot -> corrections -> merge, following the spec's deployment order
(migrate, PostgREST reload, JWT smoke over HTTP, service-role smoke, function deploy with
SHA verify, fault-injection 200 smoke, merge) and its rollback order.

---

## Risks

| Risk | Mitigation |
|---|---|
| Diagnostic write flips Meta's ack to 500 | batched `runInBackground` + handler-level 200 test (A2) |
| `attempts` misread as an event count | column named `attempts`; retry claim withdrawn in the spec |
| Stranger-id spam grows cardinality | advisory-locked exact daily cap (A10) + 7-day purge + 64-char cap |
| RPC leaks other users' rows or secrets | escaped prefix + `user_id` recheck + explicit projection + anon revoke, proven over PostgREST with real JWTs |
| Writer unreachable after revoke | explicit `grant execute to service_role` + service-role smoke test |
| Card under-reports legacy WhatsApp destinations | RPC UNIONs `whatsapp_webhooks`, matching `loadDestinations` |
| "Never" shown for every WhatsApp account | activity RPC UNIONs `whatsapp_messages` (A11) |
| Disconnected account renders healthy | `disconnected` overrides `getTokenHealth` (A6) |
| Frontend deploys before RPCs exist | PostgREST schema reload + smoke test before merge |
