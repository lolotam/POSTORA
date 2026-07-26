# WhatsApp Mini-App

Postora's WhatsApp Business module is a standalone mini-app at `/messaging/whatsapp`. It replaces the shared dashboard shell with its own WhatsApp-branded layout (`src/components/whatsapp/WhatsAppLayout.tsx`) and gives every section its own route. Access is gated by the `feature_msg_whatsapp` feature flag; users without the flag are redirected to `/dashboard`.

- **Setup and platform configuration:** [setup-guide.md](./setup-guide.md)
- **Automation and AI-agent guide:** [automation-ai-agent-guide.md](./automation-ai-agent-guide.md)
- **Feature comparison vs MazBot:** [mazbot-comparison.md](./mazbot-comparison.md)

## Routes

All routes are children of `/messaging/whatsapp` and are registered in `src/components/AnimatedRoutes.tsx`. The nav registry (slugs, labels, icons, descriptions) lives in `src/components/whatsapp/waNav.ts`.

| Route | Page | Purpose |
|---|---|---|
| `/messaging/whatsapp` | `WhatsAppDashboard.tsx` | Connection status, quick stats, section cards. Also redirects legacy `?tab=<slug>` URLs to the matching route. |
| `/conversations` | `Conversations.tsx` | Live inbox (`MessagingInbox` with `platform="whatsapp"`). |
| `/contacts` | `Contacts.tsx` | Contacts, groups, CSV upload, tags. |
| `/templates` | `Templates.tsx` | Approved message templates. |
| `/analytics` | `Analytics.tsx` | Conversation and message analytics. |
| `/quick-replies` | `QuickReplies.tsx` | Reusable canned replies. |
| `/auto-replies` | `AutoReplies.tsx` | Keyword/availability-based auto replies. |
| `/broadcasts` | `Broadcasts.tsx` | Broadcast campaigns to opted-in contacts. |
| `/agents` | `Agents.tsx` | Workspace team management: members, invitations, roles. |
| `/pipelines` | `Pipelines.tsx` | Sales pipeline kanban: deals, stages, drag-and-drop. |
| `/profile` | `BusinessProfile.tsx` | WhatsApp business profile details. |
| `/webhooks` | `Webhooks.tsx` | Outbound webhook/automation endpoints. |
| `/scheduled` | `Scheduled.tsx` | Queued scheduled messages. |
| `/response-stats` | `ResponseStats.tsx` | Canned-response usage analytics. |
| `/catalog` | `Catalog.tsx` | Commerce catalog items. |
| `/setup` | `Setup.tsx` | Embedded Signup connect flow, diagnostics, admin setup guide. |
| `/docs` | `Docs.tsx` | In-app user guide (connection modes, 24-hour rule, troubleshooting). |

## Architecture

```
src/pages/whatsapp/*            thin route pages (header + content component)
src/components/whatsapp/        WhatsAppLayout, waNav registry, page header
src/components/messaging/       content components (inbox, managers, setup, diagnostics)
src/hooks/useWhatsApp*.ts       data hooks (one per section, roughly)
        │
        ▼
supabase/functions/
  messaging-api/                whatsapp_* actions (send, templates, contacts, agents, …)
  whatsapp-workspace/           workspace listing, members, invitations, roles
  whatsapp-oauth/               Embedded Signup token exchange + WABA subscribe + phone register
  whatsapp-webhook/             Meta webhook: verification, HMAC check, inbound message ingest
  whatsapp-profile/             business profile read/update
  whatsapp-broadcast/           broadcast sending
  whatsapp-scheduled-sender/    cron sender for scheduled messages
  whatsapp-config-test/         validates Embedded Signup Configuration IDs against Meta
        │
        ▼
Postgres: whatsapp_* tables (messages, contacts, templates, agents, broadcasts,
quick/auto replies, scheduled messages, webhooks, labels, analytics, …)
```

Connected numbers are rows in `social_accounts` with `platform = 'whatsapp'`; `account_metadata` holds `waba_id`, `phone_number_id`, `connection_mode` (`cloud_api` or `coexistence`), `registration_status`, and `subscribed`.

## Workspaces, roles and the CRM

WhatsApp and CRM resources are scoped to a **workspace**. Nothing else in Postora is —
posts, media, social profiles and subscriptions keep their existing per-user ownership.

Every user has exactly one personal workspace, created on demand by
`ensure_personal_workspace`. A single-user account sees no change: there is no
workspace switcher until they belong to two or more.

### Roles

| Role | May do |
|---|---|
| `owner` | Everything, including granting ownership and deleting the workspace |
| `admin` | Manage members, invitations, pipelines and stages; connect and disconnect numbers |
| `agent` | Work conversations and deals |
| `viewer` | Read only |

Two rules are enforced in both the API and the database: a workspace must always
retain at least one owner, and **only an owner may grant ownership or remove or
demote another owner**. Without the second rule an admin could promote itself and
then unseat the original owner.

### Invitations

Invitations are emailed via Resend and carry a single-use token. Only the token's
SHA-256 hash is stored — the raw value is never persisted, never returned in an API
response and never logged. Acceptance goes through `accept_workspace_invitation`,
which validates expiry, replay, revocation and email match atomically. Every failure
returns the same generic message, so the endpoint cannot be used to discover which
workspaces or invitations exist. Inviting straight to `owner` is rejected.

Team membership replaced the old agent self-registration. `whatsapp_agents` rows are
kept as an operational presence record (display name, status, current load) and are
surfaced read-only alongside each member.

### Pipelines and deals

`whatsapp_pipelines` → `whatsapp_pipeline_stages` → `whatsapp_deals`, all workspace
scoped. A workspace's first visit to `/pipelines` creates a default pipeline via
`create_default_whatsapp_pipeline`.

A stage's outcome comes from its `stage_type` (`open` / `won` / `lost`), never from
its display name, so renaming a column cannot change how deals are counted.

Deals require a `contact_id` foreign key — not a phone string — and may optionally
link a `conversation_cache_id`. Moving a deal calls the `move_whatsapp_deal` RPC
rather than updating `stage_id` directly: the RPC is transactional and renumbers
siblings under a lock, so concurrent moves cannot corrupt ordering.

The board supports drag-and-drop, but every card also carries a plain "Move to
stage" control. That control is the baseline — it is what works on touch and with a
keyboard — and drag is the enhancement.

### Chat deep links

Inbox selection is reflected in the URL as `?ws=&account=&chat=`, where `chat` is
`messaging_cache.id`. That id is stable, unlike the external conversation string, so
a deal card's link survives a refresh. An unknown or stale id selects nothing rather
than falling back to another conversation.

### Authorization

Every `whatsapp_*` action in `messaging-api` runs through
`requireWhatsAppWorkspaceAccess` with a minimum role: `viewer` for reads, `agent` for
sends and mark-read, `admin` for phone registration and template create/delete.
Reads are additionally constrained by the resolved `workspace_id`.

A missing account, a non-WhatsApp account and a non-member all return the same 404,
so account ids cannot be enumerated. Facebook and Instagram keep their existing
owner-only authorization and are not workspace scoped.

### Later phases

Flow builder, internal conversation notes, CSAT surveys, SLA rules, business hours
and website chat are **not implemented**. They were deliberately dropped from the
workspace migration rather than shipped as unused tables, and each needs its own
design.

## Deployment note

Edge functions on the self-hosted Supabase stack are **not** auto-deployed from this repo. After changing anything under `supabase/functions/`, follow [`docs/runbooks/deploy-edge-function.md`](../runbooks/deploy-edge-function.md). The frontend deploys automatically when `main` is pushed (Dokploy).
