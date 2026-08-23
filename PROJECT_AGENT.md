# PROJECT_AGENT.md — POSTORA Project Context for Coding Agents

Read `ARCHITECTURE.md` first — it contains the mandatory architectural rules. Read `CLAUDE.md` for the mandatory task workflow and deployment rules; on conflict, `CLAUDE.md` wins.

This document provides project-specific operating context.

## Product

POSTORA is a multi-platform social media operations platform supporting publishing, scheduling, analytics, messaging, AI-assisted content workflows, media management, subscriptions, quotas, admin operations, and automation integrations.

## Core stack

```text
Frontend:
React 18
TypeScript
Vite
Tailwind CSS
shadcn/ui + Radix
TanStack Query
Zustand / React Context
React Hook Form + Zod
Recharts
Framer Motion

Backend:
Self-hosted Supabase
PostgreSQL
Supabase Auth
Supabase Realtime
Supabase Storage
Deno Edge Functions

Infrastructure:
Docker
nginx
Dokploy
Cloudflare
Cloudinary

External integrations:
Meta / Facebook / Instagram / Threads
TikTok
YouTube / Google
Pinterest
LinkedIn
Twitter/X
Bluesky
Reddit
WhatsApp
Stripe
Resend
AI providers
n8n / Make
```

## Existing architecture

Legacy frontend organization:

```text
src/
├── pages/
├── components/
├── hooks/
├── contexts/
├── integrations/
├── lib/
├── services/
├── stores/
└── types/
```

Backend:

```text
supabase/
├── functions/
│   ├── _shared/
│   └── <edge-function>/
└── migrations/
```

The repository is in an incremental transition toward feature-oriented architecture. Do not perform a mass migration.

## Preferred direction

For substantial new functionality (note: `src/features/` **does not exist yet** as of 2026-08-22 — the first such feature creates it):

```text
src/features/<business-capability>/
├── domain/
├── application/
├── infrastructure/
├── ui/
└── index.ts
```

## High-risk areas

Treat these as production-critical:

- publishing
- scheduled publishing
- OAuth callbacks
- token refresh
- service-role operations
- RLS
- subscriptions and quotas
- Stripe
- webhooks
- public automation API
- media upload/transcoding
- admin authorization

Changes in these areas require explicit regression testing.

## Known architectural hotspots

### `src/pages/CreatePost.tsx`

Large composition/orchestration surface. Do not add more business/provider logic directly to the page when it can be placed in publishing application/domain modules.

### `src/hooks/usePostForm.tsx`

Currently combines significant form, persistence, media, editing, routing, Supabase, and workflow responsibilities.

When touching it, prefer extraction of pure rules and infrastructure operations rather than increasing its scope.

### `supabase/functions/process-post/index.ts`

Large legacy publishing Edge Function — **~7,200 lines** as of 2026-08-22, holding the full publishing implementation for all ten platforms.

Its header comment claims Edge Functions cannot import across files. That claim is false — the file already imports from `../_shared` — and it must not be used to justify more monolithic code.

New work should reduce or contain its responsibilities.

Do not use its existing size as justification to add more monolithic code.

### `_shared/platforms/types.ts`

Contains shared platform types but is currently coupled to Supabase through `SupabaseClient`.

New pure contracts should avoid infrastructure SDK types.

### `supabase/functions/n8n-api/index.ts`

Holds a **third** local copy of `PlatformMetadata`, alongside `process-post/index.ts` and `_shared/platforms/types.ts`. Locate them with `grep -rn "interface PlatformMetadata" supabase/functions` rather than by line number — the line numbers differ between branches.

A platform metadata field added in one place can silently not exist in the others. When changing platform metadata, check all three until they are consolidated (audit item P3).

## Existing patterns that should be preserved

Use and improve the existing:

- JWT-based authenticated identity extraction
- service-role separation
- sensitive-data redaction
- safe backend error responses
- request schema validation
- HTTP timeout helpers
- webhook target validation
- RLS enforcement
- structured system logging

## Compatibility philosophy

POSTORA is live software.

Prefer:

```text
additive migration
→ compatibility period
→ consumer migration
→ cleanup
```

over:

```text
breaking rename
→ fix callers afterward
```

## Architecture decision hierarchy

When uncertain, choose in this order:

1. security
2. correctness
3. production compatibility
4. data integrity
5. testability
6. clear dependency direction
7. maintainability
8. implementation convenience

## Agent stop conditions

Stop and investigate before writing code when:

- two different modules appear to own the same business rule,
- a request requires bypassing RLS,
- a proposed frontend fix changes a server-authoritative rule,
- a provider operation may be duplicated by retry,
- stored metadata appears to have multiple historical shapes,
- a migration may already have run in production,
- auth identity differs between JWT and request body,
- a change introduces a feature dependency cycle,
- a change requires placing service-role credentials in frontend code,
- a fix depends on parsing raw provider error text in the UI.

## Required completion summary

At the end of a coding task, report:

```text
Root cause:
Implementation:
Architecture impact:
Security/RLS impact:
Data/migration impact:
Tests:
Operational/deployment notes:
Remaining risks:
```

Do not claim a test passed unless it was actually run.
