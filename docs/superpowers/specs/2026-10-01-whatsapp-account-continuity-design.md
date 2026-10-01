# WhatsApp account continuity — design

**Status:** Draft for owner review. Nothing is implemented.
**Date:** 2026-10-01
**Tracks:** #250. The owner chose all four solutions (A, B, C and D).

## 1. Problem

Every QR "Connect WhatsApp" inserts a new `social_accounts` row, even for a number that already has a row. On activation, `activate_evolution_qr_account` (`20260824000000_evolution_qr_activation_merges_duplicate_numbers.sql`) retires the older row. It moves only `whatsapp_messages`, `messaging_cache` and `whatsapp_scheduled_messages`. Everything the owner configured stays on the retired row: the AI agent, procedures, connectors, knowledge, the store webhook and the automation handlers.

The live incident on 2026-10-01 went like this:
1. The owner re-paired the same number.
2. The WooCommerce webhook kept delivering to the binding, which still pointed at the retired row.
3. The COD opener failed with `Direct QR instance is not configured`.
4. Nothing told the owner. The failure reached only `system_logs`.

Switching connection type (QR ↔ Meta Cloud/coexistence) or switching to a different number has the same effect, because the new connection is a different row.

## 2. Goals

1. Re-pairing the same number by QR never needs anything moved (A).
2. If a duplicate row is still created and retired, the setup follows the surviving row automatically (B).
3. When the owner moves to a different connection type or number, Postora offers to bring the setup across in one click (C).
4. Nothing fails silently:
   - The owner sees what is attached before disconnecting.
   - A store event for a disconnected account produces a visible alert in Postora (D).

**Non-goals:** merging two live numbers into one inbox, moving history or log tables, and Meta-side re-subscription changes.

## 3. What counts as "setup"

The move covers **setup** only. History, logs and caches stay with the row that produced them, because they record what happened on that connection.

| Item | Where | Move? | Unique / FK notes |
|---|---|---|---|
| AI agent config, including procedures | `ai_agent_configs` | yes | unique `social_account_id` → collision rule (§6) |
| Connectors (account-scoped) | `ai_agent_tools` | yes | unique `(user_id, social_account_id, name)` → collision rule; FK has no ON DELETE |
| Connector sharing links | `ai_agent_tool_accounts` | yes | PK `(tool_id, social_account_id)` → skip if already present |
| Knowledge source links | `ai_knowledge_source_accounts` | yes | PK `(source_id, social_account_id)` → skip if already present |
| Website setup jobs | `ai_website_setup_jobs` | yes | unique `(source_id, social_account_id)` → skip if present |
| Agent test cases | `ai_agent_test_cases` | yes | none |
| Agent test runs | `ai_agent_test_runs` | no (history) | — |
| Store webhook binding | `store_webhook_bindings` | yes | `store_events` composite FK, see §5.1 |
| Back-in-stock waitlist | `stock_waitlist` | yes | unique `(social_account_id, connector_id, phone, product_id)` → skip duplicates |
| Message templates | `whatsapp_message_templates` | **only same connection type** | no FK. Meta templates belong to a WABA, so moving them to a QR row is meaningless |
| Lead forms | `lead_forms` | yes | no FK |
| Partner API key links / partner webhooks | `partner_api_key_accounts`, `partner_webhooks` | yes | composite `(id, workspace_id)` FK; same workspace required (§5.3) |
| Scheduled messages | `whatsapp_scheduled_messages` | yes (the RPC already moves these) | — |
| Automation handlers | `social_accounts.account_metadata.{automation_handler, comment_automation_handler, media_understanding}` | yes, copied key by key | on the row itself. `AutomationHandlerCard.tsx:71` already documents this loss |
| n8n trigger subscriptions | `app_settings` rows keyed `n8n_webhook_<userId>_%`, `value.social_account_id` | yes, rewrite the JSON value | no FK; nothing cascades |
| Messages, inbox cache, store events, usage counters, logs, analytics | various | **no** | history |

Not moved: `whatsapp_evolution_instances` is session state. It belongs to the row that owns the live session.

## 4. Solution A — Reconnect in place (QR)

**UI.** The QR account card in `WhatsAppSetup.tsx` gains a **Reconnect** button, shown for a QR row that is inactive or whose session is `close`. Today the reconnect list (`useReconnectableWhatsApp.ts`) excludes `evolution_qr`. The button opens the existing `WhatsAppQrScanner` against **the same `social_account_id`**.

**Bridge.** Add a new action, `reconnect_qr { social_account_id }`, to `whatsapp-evolution-bridge`:
1. Check ownership with `findOwnedAccount`. The row must be `evolution_qr`, and must not be `retired_` or `pending_`.
2. Make Evolution instance creation idempotent:
   - Fetch the instance by its existing `instance_name` (`postora_<id>`).
   - If it exists, call `connect()`. Otherwise call `create`. This is needed because disconnect ran a best-effort `deleteInstance`, and `instance_name` is UNIQUE.
   - Keep the `whatsapp_evolution_instances` row and refresh its QR fields.
3. Return the QR. Activation then runs through the existing `get_qr_status` → `syncEvolutionAccountConnection` → `activate_evolution_qr_account` path.
   - The RPC already re-pairs into the same row: when the number matches it just sets `is_active = true` (`:76-79`).
   - The webhook path can't activate it, because `findAccount` filters on `is_active`. The poll is the activation path, as it is today.

**Different number scanned.** The RPC keeps the row's identity and the caller sets `account_metadata.number_mismatch` (`evolutionQrAccount.ts:207-220`). A must surface this: the scanner shows *"You scanned +965…, but this connection is +965…"*, with two actions:
- **Log out and scan the right phone**: logout, then re-QR.
- **Connect it as a new account**: falls through to the normal connect, and C then offers the setup move.

The mismatched session must never stay silently active.

**History import.** `last_sync_at` is left as it is. Reconnecting the same number must not re-import history, because the messages are already there. The existing "Sync past chats" action remains available.

## 5. Solutions B and C — one mover

B and C use **one** database function, so one harness suite covers both callers.

```
move_whatsapp_account_setup(p_from uuid, p_to uuid, p_policy text, p_choices jsonb default null)
  returns jsonb   -- { moved: {table: n, ...}, skipped: [{item, reason}], conflicts: [...] }
```

Its access rules:
- `SECURITY DEFINER`, `search_path = public`.
- `REVOKE` from `public`, `anon` and `authenticated` (all three; see the revoke memory). `GRANT` to `service_role` only.
- Both rows must be `platform = 'whatsapp'` and belong to the same user, or it raises.
- One transaction, with an advisory lock on `(user_id, 'setup-move')`.

### 5.1 Store bindings and `store_events`

`store_events_binding_identity_fk` references `store_webhook_bindings(id, user_id, social_account_id, connector_id)` with no ON UPDATE rule. A binding with events therefore cannot change account. A new migration re-creates that FK as `ON UPDATE CASCADE`, so a binding's events follow it, and the move becomes a plain `UPDATE`.

The binding **id** never changes. The WooCommerce delivery URL is addressed by it, so the store keeps working with no edits. That was proven in the manual repair on 2026-10-01.

### 5.2 Caller B — automatic, inside activation

A new migration redefines `activate_evolution_qr_account` (the applied one is never edited). In the duplicate branch, after the existing message moves, it calls `move_whatsapp_account_setup(v_duplicate_id, p_account_id, 'survivor_wins')`.

The survivor was a `pending_` row until moments before, so collisions are nearly impossible. When one does happen, the survivor's item is kept and the old item stays on the retired row. C's banner then offers it.

### 5.3 Caller C — "Bring over my setup"

**When it is offered.** A banner appears on the WhatsApp setup page and on AI agent settings when all of these hold:
- The active account is missing at least one §3 item that the other row has.
- Another of the owner's WhatsApp rows is inactive or retired and has setup, from §3.

**What it shows:**
> "**xsellpoint (old)** has an AI agent, 1 WooCommerce connector, a store webhook and 5 knowledge sources. Move them to **xsellpoint**?"

It has a per-item checklist. Conflicting items show both sides with a keep-which choice.

**Edge function.** A new action on `whatsapp-oauth` or the bridge, `move_setup { from, to, choices }`, checks ownership of both rows and calls the RPC with `p_policy = 'per_item'`.

**Old account still active.** The owner may run two numbers for one business. In that case the default is **copy**, not move. That is a follow-up: v1 offers moves from inactive/retired rows only, and says so in the UI.

**Workspace.** Both rows must be in the same workspace. If they are not, the banner explains why it can't move them.

## 6. Collision rule — AWAITING OWNER CONFIRMATION

The question was asked on 2026-10-01 and got no answer. Proposed defaults:
- **B (automatic):** survivor wins. The old item stays on the retired row, and C offers it.
- **C (interactive):** per item. The owner picks which config to keep, and connectors with the same name ask "replace / keep both (renamed) / skip". Items with no conflict move without asking.

## 7. Solution D — never silent

**D1. Pre-disconnect summary**, on **both** disconnect paths:
- `WhatsAppSetup.tsx` disconnect dialog (`:757-780`), which sets `is_active = false`.
- The Profiles page `useDisconnectAccountFromProfile` (`useSocialProfiles.tsx:176-195`). This **hard-deletes** the row and cascades the setup away. The dialog must say that the setup will be **deleted**, not kept, and point to Disconnect on the WhatsApp page instead.

Both read a new `get_whatsapp_account_setup_summary(p_account_id)`. It returns counts per §3 item and is owner-scoped. C reuses it.

**D2. A store event for a disconnected account is skipped visibly.**
- `process-store-events/deps.ts` `accountRow` adds `is_active` and `platform_user_id`.
- `accountSkipReason` gains `account_disconnected`, for an inactive or `retired_` row.
- This also fixes a real bug: a disconnected Meta row still holds its token, so today its COD template **still sends** after the owner disconnected.
- `store-webhook` keeps accepting and storing the delivery, so nothing is lost. It answers with `ignored: account_disconnected`, which WooCommerce shows in its delivery log.

**D3. Owner alert.** A `social_accounts` flag, `account_metadata.undelivered_store_events_since`, is set when D2 skips. It feeds:
- a red banner modelled on `TokenReauthBanner` (`src/components/dashboard/TokenReauthBanner.tsx`): *"Store orders are arriving for a disconnected WhatsApp account (xsellpoint). Reconnect it or move its setup."* It links to A and C;
- an email via the `send-token-expiry-notifications` pattern (Resend, with snooze).

`admin_notifications` is not used, because it has no target-user column. The banner clears when the account is reconnected or its binding moves.

## 8. Delivery order

Each step is its own PR, with migrations applied before merge (the merge deploys the code).
1. **D**: summary RPC, `account_disconnected` skip, banner and email. This gives visibility first and fixes the Meta send-after-disconnect bug.
2. **A**: `reconnect_qr` plus the Reconnect button and mismatch handling.
3. **B + C**: the FK `ON UPDATE CASCADE` migration, `move_whatsapp_account_setup`, the redefined `activate_evolution_qr_account`, and the C banner with its checklist.

## 9. Testing

- **DB harness (PG17, Contabo):** a suite for `move_whatsapp_account_setup` covering:
  - every §3 row;
  - collisions under both policies;
  - a binding with `store_events` (cascade);
  - a cross-workspace refusal;
  - a non-owner refusal;
  - `EXECUTE` denied to anon and authenticated.

  Mutation checks: remove the FK cascade, the ownership check and the revoke.
- **Activation:** re-pairing a duplicate moves the setup; the same-number reconnect is a no-op; a mismatched number keeps the identity and sets the flag.
- **Deno:**
  - `reconnect_qr`: idempotent create/connect, refusal on retired and pending rows.
  - The store worker's `account_disconnected` skip, for QR and Meta.
  - The `move_setup` ownership checks.
- **Vitest:**
  - The disconnect dialogs on both paths show the summary.
  - Banner visibility.
  - The C checklist and its conflict choices.
- **Live check:** reconnect the owner's QR number; place a COD order; disconnect and confirm the banner; reconnect.

## 10. Separate issues (not in this work)

1. `whatsapp-oauth` never writes the `connection_mode` **column**, so coexistence rows read as `cloud_api` (`whatsapp-oauth/index.ts:374-401`).
2. Nothing cleans up `pending_` rows; an unscanned QR leaves an inactive row forever.
3. The `ai_agent_tools` account FK has no ON DELETE, so a Profiles-page delete fails whenever an account-scoped connector exists.
4. A stale comment in `whatsapp-evolution-bridge/index.ts:310` calls the webhook the primary activation path.
