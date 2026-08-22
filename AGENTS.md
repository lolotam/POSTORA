> **⚠️ Self-hosted migration notice (2026-06):** This project now runs on a **self-hosted Supabase** at `https://api.postora.cloud`. Any reference below to `efruibswazzuuupgyzmf`, `efruibswazzuuupgyzmf.supabase.co`, or `supabase.postora.cloud` is **historical only** and does not reflect runtime configuration. Runtime URLs come from `VITE_SUPABASE_URL` / `SUPABASE_URL`.

# Postora - AI Coding Assistant Context

This document provides comprehensive context for AI coding assistants (Codex, GPT, Gemini) to understand and work with the Postora codebase.

---

## 📐 Required reading before you touch code

**Before editing anything under `src/**` or `supabase/functions/**` you MUST read `ARCHITECTURE.md`.** It defines layering, dependency direction, Edge Function shape, and the security rules new code has to follow. It is not auto-loaded — open it deliberately.

The four agent documents and what each one owns:

| File | Owns |
|---|---|
| `CLAUDE.md` | **Task Execution Workflow (authoritative)**, project facts, DB schema, MCP routing, deploy rules |
| `AGENTS.md` | The same project context, mirrored for Codex |
| `ARCHITECTURE.md` | Architecture rules — layering, dependency direction, Edge Function and security shape |
| `PROJECT_AGENT.md` | Known hotspots, agent stop conditions, decision hierarchy, completion summary |

Supporting evidence lives in `POSTORA_CLEAN_ARCHITECTURE_AUDIT.md`.

**A fact belongs in exactly one of these files.** If you need to state something that already lives in another, link to it instead of copying it — these documents have already drifted from each other once.

On conflict between `ARCHITECTURE.md` and the Task Execution Workflow below, **the workflow wins**.

### Delegating to another agent (Codex / Grok / OpenCode / Antigravity)

Nothing auto-loads `ARCHITECTURE.md` for a delegated implementer. **Every delegation brief must name `ARCHITECTURE.md` as required reading**, alongside the specific rule sections that apply to the task. A brief that omits it will produce code that violates the layering rules and fails the guard pass.

---

## Project Overview

**Postora** is a social media management platform that allows users to:
- Connect and manage multiple social media accounts (Facebook, Instagram, TikTok, YouTube, Pinterest)
- Create and schedule posts across platforms with platform-specific settings
- Use AI to generate captions, hashtags, and images
- Secure accounts with 2FA and backup codes
- Manage user profiles and subscriptions
- Access an admin dashboard for platform management
- Stay updated with "What's New" blog posts and notifications

**Live URL**: https://postora.cloud

---

## Task Execution Workflow (MANDATORY)

Follow these steps for every task, in order.

### Before starting any task
1. **Recall prior history** — search the `mem0` MCP (`search_memories` with `user_id="HP"`, `app_id="lolotam-postora"`) for previous fixes/debugging of the same feature or bug. Old solutions and gotchas are stored there — use them before re-deriving.
2. **Brainstorm first** — run the `brainstorming` skill before any creative/implementation work to pin down intent, requirements, and design.
3. **Confirm root cause with evidence** before writing any fix. No speculative patches — reproduce, inspect DB state / logs / code paths, and state the proven cause first.

### While working
4. **Backend access** — the Supabase stack (Postgres + edge functions) is self-hosted on the Contabo server documented in the [Supabase Project (Self-hosted)](#supabase-project-self-hosted) section below. The SSH MCP for this project is **`ssh-contabo-mcp`** (host access); Dokploy operations use **`dokploy-contaboo-mcp`**. Never use the musalam/Abdelaziz/curemed MCPs for Postora.

### n8n community node workflow

> **Canonical source: `CLAUDE.md` → "n8n community node workflow".** Do not maintain a second copy of these rules here — this section previously drifted out of sync with it — it pinned an outdated node version and still instructed agents to sync a vendored copy that had already been deleted on purpose.

The two rules most often got wrong, restated only because getting them wrong is destructive:

- **The node lives in exactly ONE local directory:** `F:\N8N\Postora-n8n-community-node` (the GitHub-connected repo, npm package `n8n-nodes-postora`). The vendored copy that used to sit under this repo was **deleted on 2026-08-22 — do not recreate it and do not sync node changes into this repo.** Ignore any older instruction to "apply changes twice".
- **Backend changes only** (`supabase/functions/**`) are committed in this repo. The node's own source, tests, `package.json`, `README.md` and `dist/` are committed in the node repo, never here.

For the release process, deployment model, and current node capabilities, read `CLAUDE.md`.

### After the task, before committing
5. **Guard pass (always)** — run `clean-code-guard` on changed production code and `test-guard` on changed/added tests.
6. **Commit locally, always** — commit scoped to the task's files only (`git commit -- <files>`). Never commit `b64.txt`, logs, backups, `.env*`, or any secret files.

### Deployment
7. **Edge functions** — if any file under `supabase/functions/*` changed, redeploy via `ssh-contabo-mcp`: copy the changed files into the functions volume, verify SHA256 hashes, then `docker compose up -d --no-deps functions` from the stack dir. See `docs/runbooks/deploy-edge-function.md` for exact paths. Frontend deploys automatically when `main` is pushed (Dokploy).

### Wrap-up (always)
8. **Save to memory** — store a task summary in `mem0` (`add_memory`): the issue, root cause, how it was solved, and files changed — so future sessions can retrieve the fix history.
9. **Final report** — end every task with a full summary: what the issue was, what was done, files changed, test/validation results, and any deploy/follow-up actions required.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18 + TypeScript + Vite |
| **Styling** | Tailwind CSS + shadcn/ui |
| **Backend** | Supabase (PostgreSQL + Edge Functions) |
| **Auth** | Supabase Auth (Email, Google, Facebook OAuth) |
| **Storage** | Supabase Storage |
| **Automation** | n8n webhooks for posting |

---

## Project Structure

```
postora/
├── src/
│   ├── components/       # Reusable UI components
│   ├── hooks/            # Custom React hooks
│   ├── pages/            # Page components
│   │   └── admin/        # Admin dashboard pages
│   ├── integrations/     # Supabase client setup
│   └── lib/              # Utility functions
├── supabase/
│   ├── functions/        # Edge Functions (Deno)
│   └── migrations/       # Database migrations
└── public/               # Static assets
```

---

## Database Schema

### Core Tables

#### `profiles`
User profile data, created automatically on signup.
```sql
- id: UUID (PK, references auth.users)
- email: TEXT (unique)
- full_name: TEXT
- avatar_url: TEXT
- api_key: UUID (unique, auto-generated)
- created_at, updated_at: TIMESTAMPTZ
```

#### `social_accounts`
Connected social media accounts.
```sql
- id: UUID (PK)
- user_id: UUID (FK → auth.users)
- platform: TEXT ('facebook', 'instagram', 'tiktok', 'twitter', 'linkedin')
- platform_user_id: TEXT (external platform ID)
- platform_username: TEXT
- access_token: TEXT
- refresh_token: TEXT
- token_expires_at: TIMESTAMPTZ
- account_metadata: JSONB
- avatar_url: TEXT
- is_active: BOOLEAN
- social_profile_id: UUID (FK → social_profiles)
- connected_at, updated_at: TIMESTAMPTZ
```

#### `social_profiles`
Grouping profiles for managing multiple account sets.
```sql
- id: UUID (PK)
- user_id: UUID (FK → auth.users)
- name: TEXT
- share_token: TEXT
- is_public: BOOLEAN
- created_at, updated_at: TIMESTAMPTZ
```

#### `posts`
User posts for scheduling/publishing.
```sql
- id: UUID (PK)
- user_id: UUID (FK)
- caption: TEXT
- platforms: TEXT[]
- media_file_ids: UUID[]
- status: TEXT ('pending', 'processing', 'completed', 'failed')
- scheduled_at: TIMESTAMPTZ
- posted_at: TIMESTAMPTZ
- metadata: JSONB
- created_at: TIMESTAMPTZ
```

#### `platform_posts`
Results per platform for each post.
```sql
- id: UUID (PK)
- post_id: UUID (FK → posts)
- social_account_id: UUID (FK → social_accounts)
- platform: TEXT
- platform_post_id: TEXT
- platform_post_url: TEXT
- status: TEXT ('pending', 'success', 'failed')
- error_message: TEXT
- response_data: JSONB
- posted_at, created_at: TIMESTAMPTZ
```

#### `media_files`
Uploaded media files.
```sql
- id: UUID (PK)
- user_id: UUID (FK)
- file_path: TEXT
- file_type: TEXT ('image', 'video')
- file_size: INTEGER
- mime_type: TEXT
- storage_bucket: TEXT
- metadata: JSONB
- created_at: TIMESTAMPTZ
```

### Admin/Subscription Tables

#### `user_roles`
User role assignments.
```sql
- id: UUID (PK)
- user_id: UUID (FK → auth.users)
- role: app_role ENUM ('user', 'admin', 'subscriber')
- created_at, updated_at: TIMESTAMPTZ
```

#### `subscription_plans`
Available subscription plans (managed by admin).
```sql
- id: UUID (PK)
- name: TEXT
- slug: TEXT (unique)
- price_monthly: DECIMAL
- price_yearly: DECIMAL
- features: JSONB (array of feature strings)
- profile_limit: INTEGER (-1 = unlimited)
- is_popular: BOOLEAN
- is_active: BOOLEAN
- sort_order: INTEGER
- created_at, updated_at: TIMESTAMPTZ
```

#### `user_subscriptions`
User subscription records.
```sql
- id: UUID (PK)
- user_id: UUID (FK)
- plan_id: UUID (FK → subscription_plans)
- status: TEXT ('active', 'cancelled', 'expired', 'past_due')
- current_period_start: TIMESTAMPTZ
- current_period_end: TIMESTAMPTZ
- cancel_at_period_end: BOOLEAN
- stripe_subscription_id: TEXT
- stripe_customer_id: TEXT
- coupon_id: UUID (FK → coupons)
- created_at, updated_at: TIMESTAMPTZ
```

#### `coupons`
Discount coupons for subscriptions.
```sql
- id: UUID (PK)
- code: TEXT (unique)
- discount_percent: INTEGER
- discount_amount: DECIMAL
- valid_from, valid_until: TIMESTAMPTZ
- max_uses: INTEGER
- current_uses: INTEGER
- is_active: BOOLEAN
- created_at: TIMESTAMPTZ
```

#### `support_messages`
User support tickets.
```sql
- id: UUID (PK)
- user_id: UUID (FK)
- subject: TEXT
- message: TEXT
- status: TEXT ('open', 'in_progress', 'resolved', 'closed')
- admin_reply: TEXT
- replied_at: TIMESTAMPTZ
- replied_by: UUID (FK)
- created_at, updated_at: TIMESTAMPTZ
```

#### `app_settings`
Global application settings.
```sql
- id: UUID (PK)
- key: TEXT (unique)
- value: JSONB
- description: TEXT
- updated_by: UUID (FK)
- created_at, updated_at: TIMESTAMPTZ
```

#### `api_logs`
API request logging.
```sql
- id: UUID (PK)
- user_id: UUID (FK)
- endpoint: TEXT
- method: TEXT
- status_code: INTEGER
- ip_address: INET
- user_agent: TEXT
- request_data: JSONB
- response_data: JSONB
- created_at: TIMESTAMPTZ
```

#### `backup_codes`
2FA backup recovery codes (hashed).
```sql
- id: UUID (PK)
- user_id: UUID (FK → auth.users)
- code_hash: TEXT (SHA-256 hashed, original never stored)
- used_at: TIMESTAMPTZ (null if unused)
- created_at: TIMESTAMPTZ
```

#### `admin_notifications`
System-wide notifications from admins.
```sql
- id: UUID (PK)
- title: TEXT
- message: TEXT
- created_by: UUID (FK → auth.users)
- created_at: TIMESTAMPTZ
```

#### `user_notification_reads`
Tracks which admin notifications users have read.
```sql
- id: UUID (PK)
- user_id: UUID (FK → auth.users)
- notification_id: UUID (FK → admin_notifications)
- read_at: TIMESTAMPTZ
```

#### `blog_posts`
"What's New" feature updates and announcements.
```sql
- id: UUID (PK)
- title: TEXT
- content: TEXT
- excerpt: TEXT
- cover_image_url: TEXT
- status: TEXT ('draft', 'published')
- author_id: UUID (FK → auth.users)
- created_at, updated_at: TIMESTAMPTZ
```

#### `user_blog_post_reads`
Tracks which blog posts users have read.
```sql
- id: UUID (PK)
- user_id: UUID (FK → auth.users)
- blog_post_id: UUID (FK → blog_posts)
- read_at: TIMESTAMPTZ
```

---

## Edge Functions

All edge functions are in `supabase/functions/` and deployed to Supabase.

| Function | Purpose |
|----------|---------|
| `facebook-oauth` | Handle Facebook/Instagram OAuth flow and page selection |
| `tiktok-oauth` | TikTok OAuth authorization and token exchange |
| `youtube-oauth` | YouTube OAuth with channel selection |
| `pinterest-oauth` | Pinterest OAuth flow |
| `pinterest-boards` | Fetch user's Pinterest boards |
| `process-post` | Process and publish posts to platforms |
| `process-scheduled-posts` | Cron job for scheduled posts |
| `n8n-api` | API endpoint for n8n automation |
| `generate-caption` | AI caption generation |
| `generate-hashtags` | AI hashtag suggestions |
| `generate-image` | AI image generation |
| `suggest-best-times` | Suggest optimal posting times |
| `refresh-tokens` | Refresh expired OAuth tokens |
| `check-connection-health` | Verify social account connections |
| `tiktok-webhook` | TikTok webhook handler |

---

## Key Hooks

| Hook | Location | Purpose |
|------|----------|---------|
| `useAuth` | `src/hooks/useAuth.tsx` | Authentication state and methods |
| `useUserRole` | `src/hooks/useUserRole.tsx` | Get user role (admin/subscriber/user) |
| `useSocialProfiles` | `src/hooks/useSocialProfiles.tsx` | CRUD for social profiles |
| `useSocialAccounts` | `src/hooks/useSocialAccounts.tsx` | Connected social accounts |
| `usePosts` | `src/hooks/usePosts.tsx` | Post management |
| `useSubscriptionPlans` | `src/hooks/useSubscriptionPlans.tsx` | Fetch subscription plans |
| `useAdminNotifications` | `src/hooks/useNotifications.tsx` | Fetch admin notifications with read status |
| `useBlogPosts` | `src/hooks/useNotifications.tsx` | Fetch blog posts with read tracking |
| `useMarkBlogPostRead` | `src/hooks/useNotifications.tsx` | Mark blog post as read |

---

## Pages

### Public Pages
- `/` - Landing page
- `/auth` - Login/Signup
- `/pricing` - Subscription plans
- `/privacy` - Privacy policy
- `/terms` - Terms of service

### Dashboard Pages (Authenticated)
- `/dashboard` - Main dashboard
- `/post` - Create new post
- `/calendar` - Post scheduling calendar
- `/history` - Post history
- `/profiles` - Manage social profiles & accounts
- `/media` - Media library
- `/templates` - Post templates
- `/analytics` - Analytics dashboard
- `/settings` - User settings
- `/api-keys` - API key management
- `/connection-health` - Connection status

### Admin Pages (Admin role only)
- `/admin` - Admin dashboard overview
- `/admin/users` - User management
- `/admin/subscriptions` - Subscription management
- `/admin/plans` - Plans builder
- `/admin/coupons` - Coupon management
- `/admin/messages` - Support messages (with user profile info)
- `/admin/notifications` - Admin notifications manager
- `/admin/blog` - Blog posts manager (What's New)
- `/admin/settings` - App settings

---

## Recent Features

### TikTok UX Compliance (CreatePost.tsx)
TikTok tab includes all required UX elements for API audit:
- **Creator info display** - Shows connected TikTok username
- **Privacy level dropdown** - No default value (user must select)
- **Interaction toggles** - Comments, Duet, Stitch (all default off, Duet/Stitch disabled for photos)
- **Commercial content disclosure** - "Your brand" and "Branded content" toggles
- **Legal consent checkbox** - Required before posting
- **Processing notice** - Informs users about post processing time

### Two-Factor Authentication (Settings.tsx)
- **QR code generation** - 512px optimized for camera scanning
- **Download QR button** - 1024px PNG for easy scanning on other devices
- **Factor management** - View all TOTP factors with verified/unverified status badges
- **Refresh button** - Reload factor list
- **Backup codes** - 10 one-time codes, SHA-256 hashed in database
- **Copy/download codes** - One-time display with save options

### Notification System
- **Admin notifications** - Inbox tab with read/unread status
- **Blog posts** - "What's New" tab with unread indicators
- **Combined badge** - Bell icon shows total unread count
- **Read tracking** - Persistent tracking via database tables

---

## Database Functions

```sql
-- Check if user has a specific role
has_role(user_id UUID, role app_role) → BOOLEAN

-- Get user's primary role
get_user_role(user_id UUID) → app_role

-- Auto-update updated_at timestamp
update_updated_at_column() → TRIGGER

-- Create profile on user signup
handle_new_user() → TRIGGER

-- Create default role on user signup
handle_new_user_role() → TRIGGER
```

---

## Environment Variables

### Frontend (`.env`)
```
VITE_SUPABASE_URL=https://api.postora.cloud
VITE_SUPABASE_PUBLISHABLE_KEY=[anon-key]
VITE_SUPABASE_PROJECT_ID=efruibswazzuuupgyzmf
```

### Edge Functions (Supabase Secrets)
```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
FACEBOOK_APP_ID
FACEBOOK_APP_SECRET
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
PINTEREST_APP_ID
PINTEREST_APP_SECRET
OPENAI_API_KEY
```

---

## Supabase Project (Self-hosted)

- **API URL**: `https://api.postora.cloud` (Kong Gateway routing auth/rest/storage/functions)
- **Studio Dashboard**: Accessible via `https://api.postora.cloud` (or direct Studio container setup)
- **Dokploy Stack**: `postorasupabase-supabase-j8axyh` on VPS Contabo `86.48.2.205`
- **Internal / Project ID**: `efruibswazzuuupgyzmf` (historical ref used in CLI/container paths)

---

## Common Tasks

### Deploy Edge Function
Self-hosted — do **not** use `npx supabase functions deploy` (that targets Supabase Cloud and fails here). Follow the procedure in **Task Execution Workflow → step 7** above, or see `docs/runbooks/deploy-edge-function.md` for exact paths and SHA256 verification.

### Run Locally
```bash
npm install
npm run dev
```

### Check Logs
Use Supabase MCP tools or view the self-hosted dashboard.

---

## Admin User

The following email is configured as admin with full access:
- `dr.vet.waleedtam@gmail.com`

Admins bypass all subscription limits and see no upgrade prompts.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- Dirty `graphify-out/` files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
