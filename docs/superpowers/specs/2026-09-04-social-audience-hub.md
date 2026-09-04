# Design Specification: Social Audience Hub (Audience & Contacts)

**Date**: 2026-09-04 (revised twice on 2026-09-04: verified against the codebase, then one Codex debate round)
**Status**: Draft / Reviewed
**Feature**: Social Audience Hub — commenter capture across connected social accounts
**Target Path**: `/automation/audience`
**Feature flag**: `feature_audience_hub`
**Implementation plan**: `docs/superpowers/plans/2026-09-04-social-audience-hub.md`

> Every file path, table, column, route and function named in this document was checked against
> the repository on 2026-09-04. Where a dependency is not yet implemented it is marked
> **[not shipped]** with the document that proposes it.

---

## 1. Executive Summary & Core Concept

Postora records inbound public comments today but never turns the commenter into a durable record:

| Platform | Where a comment lands today | Commenter identity available |
|---|---|---|
| Facebook, Instagram | `social_inbox_events` (webhook `facebook-instagram-webhook`) | `author.id` (page-scoped / IG-scoped ID), `author.name` (FB) or `author.username` (IG) |
| Threads | `social_inbox_events` via `_shared/threadsCommentIngest.ts`, fed by the `threads-webhook` (replies) and the `threads-poll-replies` poller (pg_cron every 2 min) | replies: `author.username` only (`threads-webhook/replyEvents.ts` sets `id: null`); polled mentions: `author.id` from `mention.user.id` plus username |
| YouTube | Nothing. No comment ingestion exists (only `process-post` touches YouTube). | — |
| WhatsApp | `whatsapp_contacts` (workspace-scoped CRM with phone, email, company, notes, tags, avatar) and the `/messaging/whatsapp/contacts` page | phone number |

`social_inbox_events.platform` is constrained to `facebook | instagram | threads`
(`supabase/migrations/20260822120000_social_inbox_events_threads.sql`). Each row is an isolated
event; nothing aggregates the same commenter across posts.

The **Social Audience Hub** adds one table, `social_contacts`, that upserts a row per
`(owner, platform, platform identity)` every time a comment is ingested, and a page under
Automation that lists, filters, tags, and exports those rows.

### 1.1 Scope by platform

- **Phase 1 sources**: Facebook, Instagram, Threads — the three platforms whose comments already
  pass through `social_inbox_events`.
- **YouTube** — **[not shipped]**: joins when the YouTube comment path from
  `docs/superpowers/specs/2026-09-03-comment-workflow-funnels.md` §3.2 (Composio) lands.
- **WhatsApp** — not re-stored. `whatsapp_contacts` already is the WhatsApp contact list.
  The hub links to it (see §3.4) instead of duplicating phone contacts.

### 1.2 How this differs from the existing Leads CRM

`/leads-crm` (`src/pages/LeadsCRM.tsx`, hook `src/hooks/useLeadsCRM.ts`, flag `feature_leads_crm`)
shows **Meta Lead Ads form submissions** from the `leads` / `lead_forms` tables. The Audience Hub is
about **people who engaged publicly**. The two are not merged; the nav label is
"Audience & Contacts", never "Lead CRM", to avoid the collision.

### 1.3 Value

1. Zero-effort capture of every engaged commenter, with engagement counts and last activity.
2. Segmentation by platform, source (organic vs. workflow-triggered) and free-form tags.
3. Export: full CSV (Phase 2), Meta Custom Audience CSV and Google Sheets push through the
   existing Composio connector layer (Phase 3, see §5.2 for what has to change first).

---

## 2. Information Architecture & Navigation

### 2.1 Navigation placement

The Automation dropdown in `src/components/layout/DashboardLayout.tsx` (the `automationChildren`
array) currently contains:

- Overview — `/automation`
- Agent Setup — `/automation/agents`
- Unified Inboxes — `/messaging` (when any `feature_msg_*` flag is on)
- Comment Manager — `/comments` (when `feature_comment_manager` is on)

New entry, appended when `flags.audienceHub` is true:

- **Audience & Contacts** — `/automation/audience`

`/automation/comment-workflow` is proposed by the 2026-09-03 funnel spec and **[not shipped]**; this
spec does not depend on it for navigation.

Routes are registered in `src/components/AnimatedRoutes.tsx` next to the existing `/automation/*`
entries, wrapped in `ProtectedRoute` + `AnimatedPage` like `UnifiedAgentSetupPage`.

### 2.2 Page structure (`src/pages/automation/AudiencePage.tsx`)

The page is UI only. All reads and writes go through a feature module `src/features/audience/`
laid out as `domain / infrastructure / ui/hooks`, the shape `src/features/connectors/` uses. The
domain declares the row type itself; only infrastructure imports the generated Supabase types.
ARCHITECTURE.md §3 places React Query hooks in **ui** (feature hooks), forbids `application ->
direct Supabase client`, and forbids raw Supabase queries in pages and components.

1. **Header**
   - Title "Audience & Contacts" (the app has no i18n layer; English only).
   - Total count comes from the stats RPC below. The table is **not** added to
     `supabase_realtime`; realtime is already a dominant DB cost.
   - **Export** dropdown: `Full CSV` (Phase 2), `Meta Custom Audience CSV` (Phase 3).
   - **Sync to Google Sheets** (Phase 3).

2. **KPI bar** (one aggregate RPC, `get_social_contacts_stats()`):
   - Total contacts
   - Workflow leads (`source = 'workflow_lead'`)
   - Enriched contacts (`phone_number IS NOT NULL OR email IS NOT NULL`)
   - Top platform by contact count

3. **Filters**
   - Search over display name, username, phone, email through a `SECURITY INVOKER` RPC
     `search_social_contacts(p_query, p_platform, p_source, p_tags, p_limit, p_offset)` so the term
     is a bound parameter and never part of a PostgREST `or=` clause (see §3.7).
   - Platform: All | Facebook | Instagram | Threads (YouTube appears when its ingest ships).
   - Source: All | Organic | Workflow leads.
   - Tags: multi-select over the distinct tags of the caller's rows.

4. **Contacts table** (paged, 50 rows, ordered by `last_interacted_at DESC`)
   - Contact: display name (fallback username, fallback platform id), platform icon
     (`PlatformIcon`, `size="sm"`), handle.
   - Source badge: `Organic` or `Workflow`.
   - Phone / email as text, or "Not captured".
   - Engagement: `total_comments_count`, `last_interacted_at` relative.
   - Tags: read-only pills in the table; editing happens in the drawer.
   - Actions: **Open on WhatsApp** (only when `whatsapp_contact_id` is set, see §3.4),
     **Details**, **Delete** (single row).

5. **Contact details drawer** (`src/components/audience/ContactDetailsDrawer.tsx`)
   - Editable: display name, email, phone, company, notes, tags (add / remove).
   - Shows `last_comment_text` and counts.
   - "Link WhatsApp contact": picker over `whatsapp_contacts` (Phase 3).

**Deferred to Phase 3** (moved out of Phase 2 after review): the per-contact interaction timeline
(needs an author-id column on `social_inbox_events` or a `social_contact_events` table; the JSON
payload shape differs per platform), bulk delete with a selection model, and copy buttons.

**Avatar:** no ingest path delivers an avatar URL (see §4.1), so the table shows initials via
`AvatarFallback`. Fetching profile pictures from Graph is out of scope.

---

## 3. Data Model

### 3.1 Tenancy decision

`social_inbox_events`, `comment_inbox_cache`, `messenger_auto_replies`, `leads` and
`social_accounts` are all owned by `user_id`. `social_accounts.workspace_id` was **backfilled to the
owner's personal workspace** by `20260726000001_supercharge_postora_wacrm_chatwoot.sql` but remains
nullable; only the WhatsApp tables, `connector_connections` and the partner API make it mandatory.

Decision: **`social_contacts` is owned by `user_id`**, matching the comment domain it derives from,
with a nullable `workspace_id` copied from the social account at write time so a later move to
workspace tenancy is additive. RLS is `user_id = auth.uid()`.

Both foreign keys that could let an authenticated user attach someone else's row by guessing a
UUID are **composite and tenant-preserving**:

- `(social_account_id, user_id) REFERENCES social_accounts (id, user_id)` — the unique pair
  `social_accounts_id_user_id_key` already exists.
- `(whatsapp_contact_id, user_id) REFERENCES whatsapp_contacts (id, user_id)` — the migration adds
  `UNIQUE (id, user_id)` to `whatsapp_contacts` (its `user_id` is `NOT NULL`).

### 3.2 Table `public.social_contacts`

```sql
CREATE TABLE public.social_contacts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id         uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  social_account_id    uuid,
  platform             text NOT NULL CHECK (platform IN ('facebook', 'instagram', 'threads', 'youtube')),
  -- Page-scoped ID (FB), IG-scoped ID, Threads user id when Graph gives one, else the username.
  platform_user_id     text NOT NULL,
  identity_kind        text NOT NULL DEFAULT 'id' CHECK (identity_kind IN ('id', 'username')),

  display_name         text NOT NULL DEFAULT '',
  username             text,
  profile_url          text,

  email                text,
  phone_number         text,          -- digits only, country code first, same format as whatsapp_contacts.phone_number
  company              text,
  notes                text,

  source               text NOT NULL DEFAULT 'organic_comment'
                         CHECK (source IN ('organic_comment', 'workflow_lead')),
  tags                 text[] NOT NULL DEFAULT '{}',

  whatsapp_contact_id  uuid,

  total_comments_count integer NOT NULL DEFAULT 1 CHECK (total_comments_count >= 0),
  first_interacted_at  timestamptz NOT NULL DEFAULT now(),
  last_interacted_at   timestamptz NOT NULL DEFAULT now(),
  last_comment_text    text,
  last_post_id         text,

  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT social_contacts_identity_key UNIQUE (user_id, platform, platform_user_id),
  CONSTRAINT social_contacts_social_account_tenant_fk
    FOREIGN KEY (social_account_id, user_id) REFERENCES public.social_accounts (id, user_id)
      ON DELETE SET NULL (social_account_id),
  CONSTRAINT social_contacts_whatsapp_contact_tenant_fk
    FOREIGN KEY (whatsapp_contact_id, user_id) REFERENCES public.whatsapp_contacts (id, user_id)
      ON DELETE SET NULL (whatsapp_contact_id)
);
```

Differences from the first draft, and why:

- `whatsapp` and `direct_message` removed: WhatsApp contacts live in `whatsapp_contacts`; no DM
  enrichment path exists (see §4.3).
- `avatar_url` removed: nothing supplies it.
- `total_messages_count` removed: no message ingest writes here.
- `identity_kind` added: Threads replies deliver `author.id = null`, so the identity falls back to
  the username and the row must say so. §4.2 covers promotion when an id arrives later.
- `workflow_rule_id` **removed entirely** for now. `comment_automation_rules` **[not shipped]**
  does not exist; a bare uuid would allow phantom references and an index on nothing. The funnel
  migration adds the column, its FK and its index together (§4.4).
- `whatsapp_contact_id` added: the link to the existing WhatsApp CRM instead of a second phone book.
- `company` added to match the drawer's editable fields.
- Composite tenant FKs (§3.1).

A plain `ON DELETE SET NULL` on a composite FK would null **both** referencing columns, and `user_id`
must never become null — hence the column-list form above (PostgreSQL 15+; the stack runs 17.6).

### 3.3 Indexes

```sql
CREATE INDEX social_contacts_user_last_active_idx ON public.social_contacts (user_id, last_interacted_at DESC);
CREATE INDEX social_contacts_user_platform_idx    ON public.social_contacts (user_id, platform);
CREATE INDEX social_contacts_tags_gin_idx         ON public.social_contacts USING GIN (tags);
CREATE INDEX social_contacts_social_account_idx   ON public.social_contacts (social_account_id);
CREATE INDEX social_contacts_whatsapp_contact_idx ON public.social_contacts (whatsapp_contact_id) WHERE whatsapp_contact_id IS NOT NULL;
CREATE INDEX social_contacts_threads_username_idx ON public.social_contacts (user_id, username) WHERE platform = 'threads' AND identity_kind = 'username';
```

The last index serves the Threads identity promotion in §4.2. The unique constraint already covers
`(user_id, platform, platform_user_id)` lookups, so a separate `(user_id)` index is redundant.

### 3.4 Link to `whatsapp_contacts`

`whatsapp_contacts` is `workspace_id NOT NULL` with `UNIQUE (user_id, phone_number)`. When a
social contact gains a phone number, the drawer offers to link an existing WhatsApp contact
(same `user_id`, same digits-only phone). The link is a row reference only; nothing is copied.
"Open on WhatsApp" then navigates to `/messaging/whatsapp/contacts` (the existing page).
A deep link into a specific conversation needs a query parameter that page does not read today
and is Phase 3 work.

### 3.5 RLS and function privileges (ARCHITECTURE.md §23)

Per-operation policies, matching `leads` and `whatsapp_contacts`:

```sql
ALTER TABLE public.social_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own social contacts"   ON public.social_contacts FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can insert own social contacts" ON public.social_contacts FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own social contacts" ON public.social_contacts FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can delete own social contacts" ON public.social_contacts FOR DELETE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Admins can view all social contacts"  ON public.social_contacts FOR SELECT USING (public.has_role(auth.uid(), 'admin'::app_role));
```

Functions created by `supabase_admin` are executable by `anon` and `authenticated` by default
(`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon / authenticated` in the baseline).
Every function in this spec therefore starts with `REVOKE ALL ... FROM PUBLIC, anon, authenticated`
and grants back only what it needs.

The harness suite (`supabase/tests/social_contacts.sql`) must assert: owner read/write, cross-user
denial for SELECT/UPDATE/DELETE, `anon` cannot execute any of the functions, `authenticated` cannot
execute the writer, and `service_role` **can** (positive test via `SET ROLE service_role`).

### 3.6 Writer RPC `touch_social_contact`

```sql
CREATE OR REPLACE FUNCTION public.touch_social_contact(
  p_social_account_id uuid, p_platform text, p_author_id text, p_author_name text,
  p_author_username text, p_comment_text text, p_post_id text
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$ ... $$;
REVOKE ALL ON FUNCTION public.touch_social_contact(uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_social_contact(uuid, text, text, text, text, text, text) TO service_role;
```

- **Tenancy is derived, not supplied.** The function reads `user_id` and `workspace_id` from
  `social_accounts` by `p_social_account_id` and raises `social_account_not_found` if absent. The
  caller never passes a user id, so a bug in a webhook cannot write into another owner.
- `SECURITY INVOKER`: the only role allowed to execute is `service_role`, which bypasses RLS
  anyway; definer rights would add privilege without adding safety. The same shape is used by
  `reserve_media_understanding` in `20260825130000_media_understanding_quota.sql` (that one is
  definer; the atomic `INSERT ... ON CONFLICT ... + 1` pattern is what is being reused).
- Identity: `platform_user_id = coalesce(p_author_id, p_author_username)`; `identity_kind` is
  `'id'` when `p_author_id` is present. Both null → returns `NULL`, writes nothing.
- Threads promotion: when `p_platform = 'threads'`, `p_author_id` is present **and** no row already
  has that id, a row keyed by `identity_kind = 'username' AND platform_user_id = p_author_username`
  for the same owner is first re-keyed to the id (`platform_user_id = p_author_id, identity_kind =
  'id'`). Then the upsert increments it. If both a username row and an id row already exist, the
  id row is incremented and the username row left alone (documented limitation; a manual merge is
  Phase 3).
- Upsert: insert with `total_comments_count = 1`; on conflict increment the count, set
  `last_interacted_at = now()`, `last_comment_text`, `last_post_id`, refresh `social_account_id`,
  `workspace_id`, and overwrite `display_name` / `username` only with non-empty values.
  `source`, `tags`, `email`, `phone_number`, `company`, `notes` are never touched by ingest.

### 3.7 Read RPCs

```sql
CREATE OR REPLACE FUNCTION public.get_social_contacts_stats()
RETURNS TABLE (total bigint, workflow_leads bigint, enriched bigint, top_platform text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$ ... $$;

CREATE OR REPLACE FUNCTION public.search_social_contacts(
  p_query text, p_platform text, p_source text, p_tags text[], p_limit int, p_offset int
) RETURNS TABLE (row_count bigint, contact public.social_contacts)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$ ... $$;
```

Both are `SECURITY INVOKER` so RLS applies, revoked from `PUBLIC, anon` and granted to
`authenticated`. `search_social_contacts` filters with `ILIKE '%' || escaped || '%'` where the
escaping of `\`, `%`, `_` happens inside SQL (`replace` chain), so the frontend passes the raw term
as a bound argument. This replaces the first draft's client-built `or=(...ilike...)` clause, which
the existing WhatsApp contact search (`src/components/messaging/contacts/useContacts.ts`,
`escapeIlike`) already shows to be fragile. PostgREST returns set-returning functions as arrays;
the frontend reads `data[0]` for stats and maps rows for search.

---

## 4. Ingestion

### 4.1 Hook points (Phase 1)

One shared module, `supabase/functions/_shared/socialContactIngest.ts`, exports:

```ts
export interface SocialContactTouch {
  platform: "facebook" | "instagram" | "threads";
  author: { id: string | null; name: string | null; username: string | null };
  comment: { id: string; text: string };
  post: { id: string | null };
}
export type SocialContactTouchOutcome = "upserted" | "no_identity" | "failed";
export async function touchSocialContact(admin, socialAccountId: string, touch: SocialContactTouch): Promise<SocialContactTouchOutcome>;
```

Called from exactly two places, through the existing `runInBackground` helper so the webhook
response is never delayed:

- `supabase/functions/facebook-instagram-webhook/index.ts`, after the inbox insert succeeded and
  `isOwnComment(account, normalized.author)` passed, before `resolveCommentAutomationHandler`.
  `normalized` comes from `normalizeMetaCommentChange` in `commentEvents.ts`: Facebook supplies
  `author.id` + `author.name`; Instagram supplies `author.id` + `author.username`.
- `supabase/functions/_shared/threadsCommentIngest.ts`, after its `isOwnComment` check and
  **before** the `options.dispatch === false` seeding guard. That guard exists to stop automation
  replaying history; capturing who commented is not automation, and a poller's first pass over an
  account is exactly when the existing audience should be recorded. Own comments stay excluded.

No account select needs a new column: the RPC derives owner and workspace from the account id, so
the Threads webhook and poller (whose `ACCOUNT_SELECT` lacks `workspace_id`) need no change.

Ingest failures are logged with platform, account id and comment id only, never text, and never
fail the webhook.

**Durability (accepted risk):** `runInBackground` has no outbox. If the worker dies between the
`social_inbox_events` insert and the touch, that comment's contact is not retried. Because the
inbox row keeps the raw payload, a one-off SQL backfill from `social_inbox_events` can rebuild
counts; the migration ships that backfill as a comment block, and it also seeds contacts from the
inbox history already on disk when the feature first deploys.

### 4.2 Threads identity promotion

Covered in §3.6. Two harness cases: (a) username row exists, id arrives with the same username →
one row, re-keyed, count 2; (b) username row and id row both exist → id row incremented, username
row untouched, no error.

### 4.3 Contact enrichment

Manual only in Phases 1–2 (drawer edits). Automatic extraction of phone/email from DMs was in the
first draft; no such extractor exists, and Meta DMs are read on demand by `messaging-api` rather
than persisted by the webhook. Out of scope until a DM persistence path exists.

### 4.4 Workflow lead upgrade **[not shipped, depends on funnels]**

When the funnel engine records a `comment_automation_logs` row it calls
`mark_social_contact_lead(p_social_account_id, p_platform, p_author_id, p_author_username, p_rule_id)`
which sets `source = 'workflow_lead'`, `workflow_rule_id`, and appends `'workflow_lead'` to `tags`
if absent. The funnel migration adds `workflow_rule_id uuid REFERENCES comment_automation_rules(id)
ON DELETE SET NULL` plus its partial index at the same time. Specified here so the funnel plan can
include it; not part of Phase 1.

---

## 5. Export & Integrations (Phase 3)

### 5.1 CSV export (client-side)

Both exports are generated in the browser from RLS-scoped rows and saved with a copy of the
WhatsApp `downloadBlob` helper.

- **Full CSV** (Phase 2): every column except `metadata`.
- **Meta Custom Audience CSV**: only the identifier columns Meta accepts for a customer list.
  Column names and normalisation rules come from Meta's own reference, which is linked rather than
  copied: <https://www.facebook.com/business/help/2082575038703844>. Postora emits email, phone and
  name columns; rows with none of those are skipped. Whether a page-scoped ID column is accepted
  must be confirmed against that page before the exporter includes it.

### 5.2 Google Sheets sync (via Composio)

Verified state of the connector layer:

- Registry entry `google_sheets` in `supabase/functions/_shared/connectorRegistry.ts`
  (`auth_strategy: "composio_oauth"`, toolkit `googlesheets`, `toolkitVersion: "20260902_00"`).
- Allow-listed tools: `GOOGLESHEETS_BATCH_GET`, `GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW`,
  `GOOGLESHEETS_GET_SPREADSHEET_INFO`, `GOOGLESHEETS_BATCH_UPDATE`; only `BATCH_UPDATE` is
  marked mutating. **There is no append tool in the allow-list**, and there is no symbol named
  `COMPOSIO_AUTH_CONFIG_GOOGLE_SHEETS` anywhere in the repo.
- Connections live in `connector_connections` (workspace-scoped) and are resolved with
  `loadActiveConnection(client, connectionId, workspaceId)` from `_shared/composioConnections.ts`.
- Execution is `ComposioClient.executeTool({ slug, version, workspaceId, connectedAccountId, arguments, signal })`
  with the client from `composioClientFromEnv()`.

Required work before sync can exist:

1. Read Composio's toolkit listing for `googlesheets` at `toolkitVersion 20260902_00`, record the
   append tool's slug **and its argument schema**, and add it to the `google_sheets` allow-list and
   `mutating`. (`GOOGLESHEETS_APPEND_ROW` in the first draft was unverified.)
2. New edge function `audience-sheets-sync` (authenticated via `authenticateCaller`, errors via
   `errorSanitizer`, app errors as 200 `{ ok: false }` because Cloudflare masks origin 5xx). Body
   `{ connection_id, spreadsheet_id, sheet_name, contact_ids[] }`. Workspace is **derived from the
   connection row** (`connector_connections.workspace_id`) and the caller must satisfy
   `is_workspace_member(workspace_id, userId)`; multi-workspace users are therefore unambiguous.
   Appends one row per contact: `Date, Name, Platform, Handle, Phone, Email, Source, Last comment`.
3. UI: a dialog listing the caller's active `google_sheets` connections and a spreadsheet picker
   that uses `GOOGLESHEETS_GET_SPREADSHEET_INFO`. Sync is user-triggered on the current table page
   (up to 50 rows) or on an explicit selection once bulk selection lands.

### 5.3 WhatsApp

See §3.4. No Cloud API sends originate from the hub.

---

## 6. Security & Compliance

1. **Meta messaging windows**: the hub never sends messages; it stores public engagement only.
2. **YouTube ToS**: when YouTube ingest exists it stores public channel id and display name only.
3. **Deletion**: users can delete rows individually (Phase 2); bulk delete lands with the selection
   model in Phase 3. Removing a `social_accounts` row nulls `social_account_id` and keeps the contact.
4. **Service role**: the only service-role writer is `touch_social_contact`, which derives the owner
   from the account row (ARCHITECTURE.md §13, "never writes to another user's rows using service
   role without verified ownership").
5. **Logging**: comment text is stored in `last_comment_text`; it must never be logged.

---

## 7. Feature Flag & Phases

### 7.1 Flag

- Key `feature_audience_hub`, seeded into `app_settings` with
  `INSERT ... VALUES ('feature_audience_hub', 'false'::jsonb, '...') ON CONFLICT (key) DO NOTHING`
  (same shape as `20260424160800_…sql`).
- `src/hooks/useFeatureFlags.tsx` touch points: `FeatureFlags` interface (`audienceHub`),
  `DEFAULT_FLAGS`, `FLAG_KEYS`, `FLAG_KEY_MAP`, the label map, `ALL_FLAGS_ENABLED`, and the
  `globalFlagMap` read. Admins see every flag through `ALL_FLAGS_ENABLED`.

### 7.2 Phases

- **Phase 1 — Data & ingest** (ships independently of the funnel work)
  - Migration: table, composite FKs, indexes, RLS, trigger, writer RPC, stats and search RPCs,
    privilege revokes, flag seed, inbox-history seed. Harness suite.
  - `_shared/socialContactIngest.ts` + the two call sites.
  - Regenerated `src/integrations/supabase/types.ts`.
- **Phase 2 — UI**
  - `src/features/audience/` module, `AudiencePage.tsx`, drawer, nav + route, flag plumbing,
    Full CSV export.
- **Phase 3 — Integrations and deferred UI**
  - Meta Custom Audience CSV, Google Sheets sync (after the allow-list change), WhatsApp link
    picker and deep link, interaction timeline, bulk selection + delete, manual merge of a Threads
    username row into an id row.
- **After funnels ship**: `workflow_rule_id` column + FK + index and `mark_social_contact_lead`.

---

## 8. Open items

- Confirm with Composio's toolkit listing which `googlesheets` slug appends rows at
  `toolkitVersion 20260902_00`, and its argument schema.
- Confirm on Meta's customer-list page whether a page-scoped user id column is accepted.
- Decide whether the Comment Manager (`/comments`, reading `comment_inbox_cache`, which polls
  Graph) should also touch contacts. It does not pass through the webhook path, so contacts seen
  only there are not captured in Phase 1.
