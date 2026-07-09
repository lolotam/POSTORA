# WhatsApp Mini-App

Postora's WhatsApp Business module is a standalone mini-app at `/messaging/whatsapp`. It replaces the shared dashboard shell with its own WhatsApp-branded layout (`src/components/whatsapp/WhatsAppLayout.tsx`) and gives every section its own route. Access is gated by the `feature_msg_whatsapp` feature flag; users without the flag are redirected to `/dashboard`.

- **Setup and platform configuration:** [setup-guide.md](./setup-guide.md)
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
| `/agents` | `Agents.tsx` | Agent management and conversation assignment. |
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

## Deployment note

Edge functions on the self-hosted Supabase stack are **not** auto-deployed from this repo. After changing anything under `supabase/functions/`, follow [`docs/runbooks/deploy-edge-function.md`](../runbooks/deploy-edge-function.md). The frontend deploys automatically when `main` is pushed (Dokploy).
