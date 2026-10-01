# WhatsApp account continuity — design

**Status:** Revision 2, after the Codex review (gpt-6-sol, high, 2026-10-01). Nothing is implemented.
**Date:** 2026-10-01
**Tracks:** #250. The owner chose all four solutions (A, B, C and D).
**Review log:** §11.

## 1. Problem

Every QR "Connect WhatsApp" inserts a new `social_accounts` row, even for a number that already has a row. On activation, `activate_evolution_qr_account` (`20260824000000_evolution_qr_activation_merges_duplicate_numbers.sql`) retires the older row. It moves only `whatsapp_messages`, `messaging_cache` and `whatsapp_scheduled_messages` (`:119-139`). Everything the owner configured stays on the retired row: the AI agent, procedures, connectors, knowledge, the store webhook and the automation handlers.

The live incident on 2026-10-01:
1. The owner re-paired the same number.
2. The WooCommerce webhook kept delivering to the binding, which still pointed at the retired row.
3. The COD opener failed with `Direct QR instance is not configured`.
4. Nothing told the owner. The failure reached only `system_logs`.

Switching connection type (QR ↔ Meta Cloud/coexistence) or switching to a different number has the same effect, because the new connection is a different row.

## 2. Goals and non-goals

**Goals:**
1. Re-pairing the same number by QR never needs anything moved (A).
2. If a duplicate row is still created and retired, the setup follows the surviving row automatically, or the owner is told why it did not (B).
3. When the owner moves to a different connection type or number, Postora offers to bring the setup across (C).
4. Nothing fails silently, and a store order for a disconnected account is held rather than lost (D).

**Non-goals:**
- Moving history: messages are already handled; store events, logs and usage are not moved.
- Copying setup between two *active* accounts (v1 offers moves from inactive or retired rows only).
- Lead forms.
- Meta-side re-subscription changes.

## 3. Setup inventory

The move covers **setup** only. History stays with the row that produced it.

| Item | Where | Move rule | Notes |
|---|---|---|---|
| AI agent config, including procedures | `ai_agent_configs` | **group S** (see §5.2) | unique `social_account_id` |
| Connectors (account-scoped) | `ai_agent_tools` | group S | unique `(user_id, social_account_id, name)`; FK with no ON DELETE |
| Connector sharing links | `ai_agent_tool_accounts` | group S | PK `(tool_id, social_account_id)`; an existing link is a no-op |
| Store webhook binding | `store_webhook_bindings` | group S | unique `connector_id`; the binding **id** never changes (it is in the WooCommerce URL) |
| Knowledge source links | `ai_knowledge_source_accounts` | independent | PK `(source_id, social_account_id)`; an existing link is a no-op |
| Agent test cases | `ai_agent_test_cases` | independent | the destination's 100-case cap (`20260927100000_agent_test_limits.sql:43`): move up to the cap, report the rest |
| Back-in-stock waitlist | `stock_waitlist` | group S, **same normalized number only** | it holds customer consent to be messaged from *that* number. On a number change it stays, and C shows the count left behind |
| Message templates | `whatsapp_message_templates` | **same `account_metadata.waba_id` only** | Meta templates belong to a WABA (`meta_template_id`). Otherwise they stay, shown as "recreate on the new account" |
| Partner API: primary account | `partner_api_keys.social_account_id` (NOT NULL; the default account for calls with no account id, `partner-api/v1/authenticated.ts:288`) | B: moved. C: explicit checkbox | same workspace required |
| Partner API: key links and webhooks | `partner_api_key_accounts`, `partner_webhooks` | B: moved. C: explicit checkbox | composite `(id, workspace_id)` FKs |
| Automation handlers | `social_accounts.account_metadata.{automation_handler, comment_automation_handler, media_understanding}` | independent; copied key by key, never overwriting a key the destination has set | `AutomationHandlerCard.tsx:71` documents this loss today |
| n8n trigger subscriptions | `app_settings` rows `n8n_webhook_<userId>_%`, `value.social_account_id` | independent; rewrite the JSON value | no FK, so nothing cascades |
| Scheduled messages | `whatsapp_scheduled_messages` | already moved by activation; C moves them too | — |

**Not moved, and why:**
- `ai_website_setup_jobs`: processing state and leases.
- `ai_agent_test_runs`, `store_events` (§5.3), `whatsapp_messages`/`messaging_cache` (except as activation already does), usage counters, logs: history.
- `whatsapp_evolution_instances`: session state.
- `lead_forms`: Meta page lead forms, not WhatsApp setup.

## 4. Solution A — Reconnect in place (QR)

**Finding the row.** `WhatsAppSetup` only receives active accounts (`useSocialAccounts.tsx:46`), and `useReconnectableWhatsApp.ts:31` excludes QR. A new owner-scoped query, `useReconnectableQrAccounts`, lists `evolution_qr` rows that are inactive or whose instance is `close`, excluding `pending_%` and `retired_%`. It has loading, empty and error states. Each row gets a **Reconnect** button, which opens `WhatsAppQrScanner` bound to that `social_account_id`.

**Bridge action `reconnect_qr { social_account_id }`** (`whatsapp-evolution-bridge`) follows this recovery contract:
1. Ownership via `findOwnedAccount`. The row must be `evolution_qr` and must not be `pending_` or `retired_`. Otherwise it returns 409 with a reason.
2. Fetch the remote instance by the stored `instance_name` (`postora_<id>`, UNIQUE in `whatsapp_evolution_instances`):
   - **missing** → `create` with the same name;
   - **present and `open`** → `logout`, then `connect` (never reuse an unknown live session);
   - **present and not open** → `connect`.
3. Re-apply the webhook configuration, using the same call as `resubscribe_webhook`.
4. Refresh the QR fields on the existing instance row and return the QR.
5. **Failure:**
   - Any Evolution error returns 502 `reconnect_failed`. Nothing on `social_accounts` changes.
   - The call is safe to repeat: steps 2–4 are idempotent.
6. Leave `last_sync_at` as it is. Reconnecting the same number must not re-import history.

Activation continues through `get_qr_status` → `syncEvolutionAccountConnection` → `activate_evolution_qr_account`. The webhook cannot activate an inactive row (`whatsapp-evolution-webhook/index.ts:66-82` filters `is_active`).

**Number mismatch is a blocked state, not a warning.** Today a different number scanned onto an established row sets `number_mismatch` **and** `is_active = true` (`evolutionQrAccount.ts:193,207,241`), and the scanner treats `open` as success. The fix has three parts:
- **RPC:** the redefined `activate_evolution_qr_account` (§5.4) returns `'mismatch'` without touching `is_active` when the row is established and the scanned number differs.
- **Shared sync:** `syncEvolutionAccountConnection` handles `'mismatch'`:
  - it logs out the instance;
  - it keeps `is_active = false` and sets `account_metadata.number_mismatch`;
  - it returns state `number_mismatch`, so no history import starts (`bridge:341`) and nothing is sent.
- **Scanner:** it shows *"You scanned +965…, but this connection is +965…"*, with **Scan the right phone** (a new `reconnect_qr`) or **Connect as a new account** (the normal connect; C then offers the move).
- **Tests:** both the webhook and the poll paths.

## 5. Solutions B and C — one mover

### 5.1 The function

```
move_whatsapp_account_setup(p_from uuid, p_to uuid, p_mode text, p_choices jsonb default null)
  returns jsonb   -- { status: 'moved'|'deferred'|'noop', moved: {...}, left: [{item, reason}], conflicts: [...] }
```

**Access:**
- `SECURITY DEFINER`, `search_path = public`.
- `REVOKE ALL` from `PUBLIC`, `anon` and `authenticated`. `GRANT` to `service_role` only.

**Checks inside the function** (service-role callers bypass RLS):
- both rows are `platform = 'whatsapp'`;
- they belong to the same `user_id` and the **same `workspace_id`**;
- `p_from <> p_to`;
- neither row is `pending_%`.

Otherwise it raises `22023`.

**Lock order.** This is the only order, used by every path:
1. `pg_advisory_xact_lock(hashtextextended(user_id || ':wa-setup', 0))`;
2. any per-number activation lock;
3. `SELECT … FOR UPDATE` on both `social_accounts` rows, ordered by `id`.

The redefined activation (§5.4) takes lock 1 first as well, so B and C serialize per user and cannot deadlock. Advisory transaction locks are re-entrant within a session, so the mover called from inside activation re-acquires lock 1 harmlessly.

**Idempotent.** A repeated call with nothing left to move returns `{status:'noop'}`. Links use `ON CONFLICT DO NOTHING`, and a prior choice is never reversed. One transaction: any error rolls back the whole move.

### 5.2 Group S: the WooCommerce and agent dependency group

The store worker needs three things at once:
- the connector visible on the event's account (`process-store-events/deps.ts:213`);
- that account's agent config for procedures (`deps.ts:229`);
- the binding on the same account.

These rows therefore move **together or not at all**: the agent config, the account-scoped connectors with their links, the binding, and (if numbers match) the waitlist.

- **B (`p_mode = 'auto'`):**
  - If the destination already has an `ai_agent_configs` row, or a connector with the same name, group S is **deferred** as a whole: it stays on the source, and `status` becomes `'deferred'`.
  - A deferral sets `account_metadata.setup_move_pending = {from, at}` on the destination, which drives the C banner and the D3 alert.
  - Independent items still move.
- **C (`p_mode = 'interactive'`, with `p_choices`):** the owner picks per conflict.
  - **Agent config:** keep the destination's, or replace it with the source's. A replaced config is archived to `ai_agent_config_archive` before replacement, not deleted.
  - **Connectors with the same name:** replace, or skip. "Keep both" is not offered in v1.
  - The binding moves only if its connector moves. The UI greys it out otherwise and says why.
  - If the kept agent config has COD and review procedures switched off, the UI warns that the store webhook will start no flows.

### 5.3 Store bindings and `store_events`

`store_events_binding_identity_fk` pins `(binding_id, user_id, social_account_id, connector_id)` to the binding (`20260927130000_store_events_tenant_fk.sql:76-85`), so a binding with events cannot change account. Cascading the account onto events would relabel history and could retarget events mid-send (`worker.ts:631`). So:

- A **new migration** replaces that FK with `(binding_id, user_id, connector_id)` → `store_webhook_bindings (id, user_id, connector_id)` (a new unique key), `ON DELETE CASCADE`, no update action.
  - Events keep their own `social_account_id` as history.
  - Tenancy stays enforced by the binding FK on `user_id` and by `store_events`' existing account and user columns. The harness proves that a cross-user event is still refused.
- The mover re-points only events that have not started: `status = 'pending' AND claimed_at IS NULL`. Their `social_account_id` is set to the destination in the same transaction, so a held order goes out from the account that can now send it. Every other event keeps its original account.

### 5.4 Caller B: automatic, inside activation

A new migration redefines `activate_evolution_qr_account`. The applied one is never edited.
- It takes the §5.1 lock 1 first, then the existing per-number lock.
- It returns `'mismatch'` for an established row and a different number (§4), without activating.
- In the duplicate branch, after the existing message, cache and schedule moves, it calls `move_whatsapp_account_setup(v_duplicate_id, p_account_id, 'auto')`.

### 5.5 Caller C: "Bring over my setup"

**When the banner shows.** It is on the WhatsApp setup page and on AI agent settings when the active account either has `setup_move_pending` set, or the same user and workspace has another WhatsApp row that is inactive or `retired_`, carries any §3 item, and that row is either:
- the same normalized number. QR stores digits in `platform_user_id`; Meta exposes `account_metadata.display_phone_number` (`whatsappNumberOps.ts:44`); both are normalized to digits.
- or the most recently deactivated row, when the owner has exactly one active WhatsApp account.

**What it shows.** Built from `get_whatsapp_account_setup_summary` (§7):

> "**xsellpoint (old)** has an AI agent, 1 WooCommerce connector, a store webhook and 5 knowledge sources. Move them to **xsellpoint**?"

It has a per-item checklist with conflict choices (§5.2). Items that won't move get reasons, e.g. "3 waitlisted customers stay — they agreed to messages from +965 9795 0350" or "2 Meta templates must be recreated".

**Edge action.** `move_setup { from, to, choices }` is a new action on `whatsapp-evolution-bridge`:
- user-JWT only;
- `findOwnedAccount` for both rows;
- calls the RPC with the service role.

The banner can be dismissed per (from, to) pair, stored in `account_metadata.setup_move_dismissed`.

## 6. Collision rule (decided)

The owner did not answer on 2026-10-01; this follows the Codex review and the earlier proposal. The owner can override it at review.
- **B:** the survivor wins, **per dependency group**. A conflicting group S is deferred as a whole; it is never split. The owner is alerted (D3), and C resolves it.
- **C:** explicit per-conflict choice. Nothing is overwritten without a choice, and a replaced agent config is archived.

## 7. Solution D — never silent

**D1. Pre-disconnect summary.** A new `get_whatsapp_account_setup_summary(p_account_id)`:
- `SECURITY DEFINER`;
- checks `user_id = auth.uid()` (`42501` otherwise);
- `GRANT` to `authenticated`;
- returns counts per §3 item;
- reused by C.

It appears on both paths:
- **`WhatsAppSetup` disconnect dialog** (`WhatsAppSetup.tsx:757-780`): "This keeps the setup on the account. Reconnect it, or move the setup to a new connection."
- **Profiles-page remove** (`useSocialProfiles.tsx:176-195`): it **hard-deletes** the row. The dialog says so, recommends Disconnect on the WhatsApp page instead, and warns that the delete may be **refused** while connectors or partner dispatch intents exist (`20260831130000…sql:85`, `20260901120000…sql:85`). The UI shows that refusal as a clear error, not a raw database message.

**D2. A store order for a disconnected account is held, not lost.**
- **Receiver** (`store-webhook/handler.ts`): after the binding lookup, it reads the bound account's `is_active` and `platform_user_id`.
  - It still stores the event as today.
  - If the account is inactive or `retired_`, it answers `{ok:true, stored:n, warning:"account_disconnected"}`, which WooCommerce shows in its delivery log, and sets the D3 flag.
- **Worker** (`process-store-events`):
  - `accountRow` selects `is_active` and `platform_user_id`.
  - A new check runs before the send. If the account is inactive or retired, the event is **deferred**: `due_at += 15 min`, the claim is returned, and the attempt is not counted. This repeats until 24 h after `created_at`, after which it is marked `skipped` with `account_disconnected`.
  - If the owner reconnects (A) or moves the setup (C, which re-points pending events), the held order goes out.
  - This also fixes the current bug where a disconnected Meta row still sends (`deps.ts:141,326`).

**D3. Owner alert.** `account_metadata.undelivered_store_events = {since, count}` on the bound account is set by D2 (or `setup_move_pending` by B). It drives:
- a red banner modelled on `TokenReauthBanner`: *"Store orders are waiting for a disconnected WhatsApp account (xsellpoint). Reconnect it or move its setup."* It links to A and C, and clears when the account reconnects or the binding moves;
- one email per incident using the `send-token-expiry-notifications` pattern (Resend, `last_alert_sent_at`-style throttle, snooze). This is not `admin_notifications`, which has no target-user column.

## 8. Delivery

Three PRs, in this order. Each has its migrations applied by hand (as `supabase_admin`, then a PostgREST reload) **before** merge, because the merge deploys code:
- Edge functions auto-deploy from `origin/main` through the Dokploy reconciler within about 2 minutes. Verify with an unauthenticated boot probe (expect 401) on each changed function.
- The frontend deploys on merge.

1. **D:**
   - summary RPC;
   - receiver warning and worker deferral;
   - alert flag, banner and email;
   - both disconnect dialogs.
2. **A:**
   - `reconnect_qr`;
   - the inactive-QR query and Reconnect button;
   - the mismatch-blocked state. This includes the redefined activation RPC's `'mismatch'` return. The mover call is **not** wired yet.
3. **B + C:**
   - FK replacement migration;
   - `move_whatsapp_account_setup`;
   - the activation redefinition wiring the mover;
   - the `move_setup` action and the C banner.

## 9. Testing

- **DB harness (PG17, Contabo):**
  - **Mover:**
    - every §3 row;
    - group S deferral (config collision, connector-name collision);
    - interactive choices, including the config archive;
    - pending-event re-pointing (claimed, sent and failed events untouched);
    - waitlist and templates left behind on a number or WABA mismatch;
    - the test-case cap;
    - a repeated move returns `noop`;
    - a mid-move error rolls everything back.
  - **Refusals:** cross-user, cross-workspace, `pending_`, `p_from = p_to`.
  - **Grants:** `EXECUTE` denied to anon and authenticated, for the mover; the summary RPC refuses another user's account.
  - **FK replacement:** an event for another user's binding is refused.
  - **Concurrency:** two sessions (activation-with-merge vs a C move for the same user) complete without deadlock (`lock_timeout` set, both orders).
  - **Mutation checks:** remove the workspace check, the revoke, the group-S atomicity, and the pending-only re-point.
- **Deno:**
  - `reconnect_qr`: missing, open and closed remote instance; Evolution error → 502 with no row change; retired/pending → 409.
  - `syncEvolutionAccountConnection` mismatch: no activation, no import.
  - Receiver warning.
  - Worker deferral: until 24 h, then skipped; QR and Meta rows.
  - `move_setup` ownership.
- **Vitest:**
  - the reconnectable-QR list states;
  - the scanner mismatch screen;
  - both disconnect dialogs with summary counts and the delete-refused error;
  - banner visibility rules;
  - the C checklist with conflicts and greyed-out binding.
- **Live check:**
  - Reconnect the owner's QR number, then place a COD order: it sends.
  - Disconnect, then place an order: the banner and email appear and the order is held. Reconnect: the held order sends.

## 10. Separate issues (not in this work)

- #251: `whatsapp-oauth` never writes the `connection_mode` column.
- #252: unscanned QR `pending_` rows are never cleaned up.
- #253: the `ai_agent_tools` account FK has no ON DELETE (Profiles delete).
- #254: stale activation-path comment.

## 11. Review log

The Codex review (gpt-6-sol, high, read-only) made 13 findings. They are resolved as follows:

| # | Finding | Resolution |
|---|---|---|
| 1 | B inside activation can deadlock with a C move | single lock order, user lock first (§5.1, §5.4) and a concurrency test |
| 2 | `ON UPDATE CASCADE` relabels history and retargets in-flight events | FK replaced; events keep their account; only unstarted pending events are re-pointed (§5.3) |
| 3 | binding/connector/config can be split | group S moves atomically or is deferred (§5.2) |
| 4 | `partner_api_keys.social_account_id` missing | added (§3) |
| 5 | lead forms, website jobs, waitlist misclassified | lead forms and jobs removed; waitlist only for the same number (§3) |
| 6 | templates need the same WABA | rule changed to the same `waba_id` (§3) |
| 7 | the Reconnect button had no source row | new inactive-QR query (§4) |
| 8 | mismatch still activates | blocked state in the RPC and sync (§4) |
| 9 | instance re-create recovery contract | defined (§4) |
| 10 | C could not show B's conflicts; Meta↔QR matching | `setup_move_pending` drives the banner; normalized-number match (§5.5) |
| 11 | D2's response is impossible in the worker | receiver-time warning, worker-time deferral (§7) |
| 12 | Profiles delete may be refused | dialog and error handling (§7) |
| 13 | workspace check, summary RPC auth, deploy, tests | added (§5.1, §7, §8, §9) |

**Partly declined:** the claim that edge functions need a manual deploy. They auto-deploy from `origin/main` via the reconciler, as observed for PR #249 on 2026-10-01 and recorded in the project memory. The ARCHITECTURE.md note it cites is stale. §8 keeps a boot-probe verification step.
