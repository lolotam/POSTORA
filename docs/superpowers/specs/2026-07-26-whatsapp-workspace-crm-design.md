# WhatsApp Workspace CRM — Design

**Date:** 2026-07-26
**Branch:** `feat/whatsapp-workspace-crm`
**Baseline commit:** `deefc7d8` (`feat(whatsapp): add sales pipelines kanban and visual flowchart builder from wacrm & chatwoot blueprint`)

## Goal

Turn the prototype landed in `deefc7d8` into shippable functionality: real WhatsApp
workspaces with email invitations, a shared inbox that authorizes access instead of
assuming it, a pipeline board that actually moves deals, and deal→chat links that
survive a refresh.

## Verified starting state

Every claim below was checked against the repo and the production database on
2026-07-26, not inferred from the commit message.

### 1. The migration cannot apply

`supabase/migrations/20260726000001_supercharge_postora_wacrm_chatwoot.sql:53` runs:

```sql
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES auth.users(id),
```

`public.conversations` does not exist. No migration in `supabase/migrations/` ever
creates it, and it is absent from the production database. `ALTER TABLE` has no
`IF EXISTS` guard here, so the statement aborts the migration.

The WhatsApp conversation projection is **`messaging_cache`** (keyed by
`social_account_id` + `conversation_id`), created in
`20260408075144_bbc04d2a-6e52-47fa-a9fe-ccb387c79d07.sql`. The migration was written
against a table borrowed from the Chatwoot blueprint that Postora never had.

### 2. The migration was never applied

Production contains none of the seven tables the migration defines — no `pipelines`,
`pipeline_stages`, `deals`, `whatsapp_flows`, `conversation_notes`, `csat_surveys`,
or `business_hours`. Production also has no `supabase_migrations.schema_migrations`
table at all: this self-hosted stack has migrations applied by hand, not tracked by
the Supabase CLI.

**Consequence:** there is no drift to reconcile. The file can be rewritten in place
rather than superseded by a forward-fixing migration.

### 3. Four edge-function actions leak across tenants

`supabase/functions/messaging-api/index.ts` authenticates the caller (lines 91–116)
and then builds a service-role `adminClient` (line 118) that bypasses RLS. Actions
that fetch an account through the `getAccountToken()` helper (line 123) are safe,
because that helper re-filters `.eq("user_id", user.id)` and throws otherwise.

These four actions query `adminClient` filtered **only** by the caller-supplied
`social_account_id`:

| Action | Lines | Exposure |
|---|---|---|
| `whatsapp_get_analytics` | 1038–1071 | `select *` on `messaging_cache` — leaks participant names, phone numbers, message previews. (Its second query, on `whatsapp_message_analytics`, *is* scoped by `user_id`.) |
| `whatsapp_list_conversations` | 1071–1101 | Full conversation list for any account UUID |
| `whatsapp_get_messages` | 1101–1132 | Message bodies and media URLs from `whatsapp_messages` |
| `whatsapp_mark_read` | 1132–1147 | **Write.** Zeroes `unread_count` on another tenant's cache |

The remaining twelve `whatsapp_*` actions route through `getAccountToken()` and are
not affected. Facebook and Instagram actions are likewise unaffected and must keep
their existing owner-only authorization.

### 4. The navigation contract test is already red

`src/components/whatsapp/__tests__/waNav.test.ts` fails two assertions against
`deefc7d8`. The two failures pull in **opposite directions**:

- `whatsappNavItems` gained `pipelines` — the test's expected list must **add** it,
  because the Pipelines page is being kept and rebuilt.
- `whatsappAutomationTabs` gained `visual-flow` — the tab must be **removed** from
  the source, because the flow builder is not shippable.

`npm test` is red on the baseline. That must be fixed first so later reviews can
distinguish new breakage from inherited breakage.

### 5. The flow builder is scaffolding

`src/pages/whatsapp/VisualFlowBuilder.tsx` (183 lines) renders an `@xyflow/react`
canvas but cannot load, persist, validate, activate, or execute a flow. Nothing
reads or writes `whatsapp_flows`. `@xyflow/react` stays a dependency regardless —
`src/components/canvas/` uses it for the post composer.

### 6. Deals are linked by loose strings

`deals.contact_phone TEXT` has no foreign key to `whatsapp_contacts` and no link to
`messaging_cache`. A deal cannot reliably open its conversation, and a renumbered
contact silently orphans its deals.

### 7. Agents are user-owned, not shared

`whatsapp_agents` (from `20260413234250_...`) and
`whatsapp_conversation_assignments` are keyed by `user_id`. There is no concept of a
second person having access to someone else's inbox, which is the entire premise of
a shared inbox.

## Architecture

### Tenancy boundary

Workspace tenancy is added **only** to WhatsApp and CRM resources. Posts, media,
social profiles, subscriptions, and every other Postora domain keep their existing
`user_id` ownership untouched. This keeps the blast radius small and avoids a
platform-wide migration.

```
workspaces
  └── workspace_members (workspace_id, user_id, role)   -- owner | admin | agent | viewer
  └── workspace_invitations (workspace_id, email, token_hash, expires_at)

workspace_id added to:
  social_accounts (WhatsApp rows only)   whatsapp_contacts
  messaging_cache (WhatsApp rows only)   whatsapp_agents
  whatsapp_conversation_assignments

workspace-scoped, new:
  whatsapp_pipelines → whatsapp_pipeline_stages → whatsapp_deals
```

Every existing user is backfilled with exactly one personal workspace where they hold
`owner`. Nothing changes for a single-user account: they see no switcher, and their
data lands in their personal workspace.

### Reads via RLS, sensitive writes via RPC

- **Reads** are governed by RLS predicates of the form
  `workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())`.
  This is the durable boundary and does not depend on application code being correct.
- **Sensitive mutations** — accepting an invitation, moving a deal between stages —
  go through `SECURITY DEFINER` RPCs so they are atomic and can enforce rules RLS
  cannot express (single-use token consumption, last-owner protection, stage
  reordering under concurrency).

Membership lookup inside RLS predicates must not itself be RLS-recursive; the
membership subquery is wrapped in a `SECURITY DEFINER` helper to avoid infinite
policy recursion on `workspace_members`.

### Invitations

The raw token is generated once, emailed via the existing Resend infrastructure, and
**never stored**. Only its SHA-256 hash is persisted. Acceptance hashes the presented
token and looks up the hash, so a database read cannot mint an invitation. Tokens are
single-use and expire. Failures are non-enumerating: an invalid, expired, consumed, or
foreign token all return the same response, so the endpoint cannot be used to probe
which workspaces or emails exist.

Only `owner` and `admin` may invite, revoke, change roles, or remove members. A
workspace's final `owner` cannot be demoted or removed.

### Conversation identity

`messaging_cache.id` becomes the canonical conversation key. Existing
`whatsapp_conversation_assignments` rows, which currently store the external
`conversation_id` string, are backfilled to reference `messaging_cache.id`. Deals link
to `whatsapp_contacts.id` (required) and optionally `messaging_cache.id`, which is what
makes a deal card able to open the exact chat.

### Deferred — explicitly out of scope

Flow engine, internal conversation notes, CSAT surveys, SLA rules, business hours, and
website chat are **not** part of this work. The `whatsapp_flows`, `conversation_notes`,
`csat_surveys`, and `business_hours` tables are dropped from the migration rather than
shipped as unused schema. Each is a legitimate later phase with its own design.

## Risks

| Risk | Mitigation |
|---|---|
| Production has no migration tracking; deploys are manual | Migration must be idempotent and verified on a disposable database before it is applied by hand |
| Adding `workspace_id` to `messaging_cache` touches the hot inbox path | Backfill in the same transaction; index `(workspace_id, social_account_id, last_message_at)` |
| RLS recursion on `workspace_members` | `SECURITY DEFINER` membership helper |
| Regenerated `types.ts` is a large diff that can mask real changes | Regenerate from the local migrated database, review the CRM-related hunks specifically |
| The four leaking actions are live today | Task 3 is the highest-priority change; it can ship independently of the UI work |
