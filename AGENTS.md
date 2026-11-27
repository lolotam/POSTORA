> **⚠️ Self-hosted migration notice (2026-06):** This project now runs on a **self-hosted Supabase** at `https://api.postora.cloud`. Any reference below to `efruibswazzuuupgyzmf`, `efruibswazzuuupgyzmf.supabase.co`, or `supabase.postora.cloud` is **historical only** and does not reflect runtime configuration. Runtime URLs come from `VITE_SUPABASE_URL` / `SUPABASE_URL`.

# Postora - AI Coding Assistant Context

This document provides comprehensive context for AI coding assistants (Codex, GPT, Gemini) to understand and work with the Postora codebase.

---

## 📐 Required reading before you touch code

**Before editing anything under `src/**` or `supabase/functions/**` you MUST read `ARCHITECTURE.md`.** It defines layering, dependency direction, Edge Function shape, and the security rules new code has to follow. It is not auto-loaded — open it deliberately.

There are four agent documents. **`ARCHITECTURE.md` §0 owns the map of which document owns what** — read it there rather than looking for a copy here.

**A fact belongs in exactly one of these files.** If you need to state something that already lives in another, link to it instead of copying it — these documents have already drifted from each other once.

On conflict between `ARCHITECTURE.md` and the Task Execution Workflow below, **the workflow wins**.

### Reviewing a pull request (Codex code review)

Codex reviews every PR through OpenAI's GitHub integration, configured in ChatGPT under
Codex → Settings → Code review. It runs on the ChatGPT seat, so there is no API key and no
workflow: a `.github/workflows/codex-review.yml` that shells out to the Codex CLI needs
`OPENAI_API_KEY`, which this project does not have. One was added on 2026-08-28 and removed
the same day — it reported a green "review" check on every PR while doing nothing, which is
worse than no check at all.

Ask for a review on demand by commenting `@codex review` on the PR, or `@codex security review`
for the security-focused pass. Automatic review of every new PR is a toggle in the same
settings page.

**What a reviewer should hold this repo to**, in rough order of how much damage each one has
actually caused here:

1. **Edge Functions run under the service role, so RLS is not enforcing tenancy.** Every
   ownership check has to be structural — in the SQL, or in a composite foreign key — never
   left to the caller. A function that is safe only because its callers happen to check first
   is one refactor from being unsafe.
2. **A migration always lands before the code that depends on it.** Ask of every schema change:
   what is deployed *right now*, and does this statement still hold for it? A `SET NOT NULL`
   shipped alongside its own preparation blocked first-time agent saves for 52 accounts.
3. **Never let a failed read look like an empty one.** A discarded `error` beside a `maybeSingle()`
   is how a statement timeout became a blank form that overwrote a live persona, and how an
   ambiguous read deleted an indexed knowledge source.
4. **Every early return that refuses work must write a log row.** Two silent exits in
   `ai-agent-reply` turned hours of no replies into an afternoon of blind debugging.
5. **Permission-shaped state must be monotonic.** Adding a permission must never narrow access;
   removing one must never widen it.

### Delegating to another agent (Codex / Grok / OpenCode / Antigravity)

Nothing auto-loads `ARCHITECTURE.md` for a delegated implementer. **Every delegation brief must name `ARCHITECTURE.md` as required reading**, alongside the specific rule sections that apply to the task.

No tooling checks this. The architecture hook only prints a reminder on `Edit`/`Write` inside this session and never blocks anything, so a brief that omits the rules produces work that nothing catches until human review.

---

## Delivery tiers (Light / Medium / Heavy Implementation Pipeline)

Owner rule from Waleed, 2026-11-19 (reference: PosPay PP-195, `lolotam/PayPos.systems#1085`). The decision record with his words is `docs/decisions/2026-11-19-delivery-tiers.md`. It applies to every task in this project, side tasks and follow-up issues included. Existing project gates and rules stay in force unless a tier below explicitly replaces them. Production, server, secrets and HOLD decisions stay Waleed's.

1. **Tier card before every new task.** Ask Waleed with an `AskUserQuestion` card, in Arabic, with 3 options and the recommended one first, marked «(المقترح)»: the tier, the recommendation, a one-line reason, and an exception option (for example an extra review or step on top). Do not start before the answer. Put the tier and the exception in the delegation brief and in the PR body. Fix rounds inside a running task need no new card.
2. **LIGHT**: docs, specs, plans, ADRs, roadmap or status files, i18n, small CSS/UI changes up to about 150 lines. Never money, permissions/auth, database/migrations, API, or a new dependency. The manager or the cheapest implementer does it. The PR merges as soon as CI is green, without waiting for review bots. No separate staging deploy; it ships with the next deploy.
3. **MEDIUM**: at most 3 review rounds. Local review (`/code-review`) plus the project's review bots (CodeRabbit, MergePilot; skip a bot stuck for more than an hour and say so in the merge report). CI green on the exact head commit. After round 3, P2/P3 findings become issues and P0/P1 findings block the merge. Staging deploys go in daily batches.
4. **HEAVY**: migrations, money, permissions/auth, security, long background jobs. Claude Fable 5.2 (medium effort) writes the implementation plan, then Codex Astra 6.2 (medium effort) debates it for one round before implementation starts. Full review and CI under the same round cap. A PR that contains a migration, money or permissions/auth merges only after Waleed's card approval, once all other gates pass. Other Heavy work: the manager merges after all gates. Deploy to staging alone right after the merge; take a database snapshot first when there is a migration, and keep the receipt.
5. **Implementer fallback, fixed order.** Light: manager or GLM, then Claude Sonnet. Medium and Heavy: Kimi, then MiniMax, then GLM, then OpenCode GLM 5.3 Flash (`zai-coding-plan/glm-5.3-flash`, which replaced Grok on Waleed's instruction; never use the `vercel/zai/...` GLM ids, Vercel rejects them on the free tier), then Claude Sonnet (Heavy on Sonnet runs at high effort). After 2 failures or an exhausted quota, move to the next lane without asking. Only lanes this project has are used, in this order.

**Skills per tier (who runs what), Waleed 2026-11-20.** The implementer runs its own guard skills, which is cheaper and faster; the manager runs `/code-review` once, at the end, on the whole PR, with a model different from the one that wrote the code. `/code-review` is built into Claude Code, so an implementer on another CLI (OpenCode and the like) cannot run it, while the guard skills are available to it.
- **Light:** no skills.
- **Medium:** the implementer finishes the work and its tests, then runs `clean-code-guard` and `test-guard`; the manager runs `/code-review` once on the whole PR; then PR and CI.
- **Heavy:** the same, and the implementer also runs `waleed-security-reviewer` (three guard skills in total); the manager runs `/code-review` once on the whole PR; then PR and CI.
- The manager runs no skill after each stage, only the single final `/code-review`.
6. **Plan summary after every merge**, in three parts: «ما تم» (main tasks done, with PR numbers), «الباقي» (each remaining main task with its sub-tasks underneath and their status), «التوصية». Side tasks are folded into the plan under their main task, and any roadmap or status file is kept in sync. Every report ends with these headings exactly: «المطلوب منك»، «الخطوة الجاية اللي أنصح بيها»، «ملاحظة» (write «مفيش» when there is nothing).
7. **Opening sessions.** Every session the manager opens for work (implementer, reviewer, debater) is opened with `delegate_task`, because `delegate_task` notifies the manager automatically when the work finishes. If another tool is ever unavoidable, the brief must say "message me when done" with the manager thread's link. Never poll a running session (`task_status`, `sleep`, watchers): its completion wakes the manager. Waleed, 2026-11-20.

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

One rule is repeated here, and only because acting on the stale version is destructive rather than merely wrong:

- **The node lives in exactly ONE local directory**, outside this repository. The vendored copy that used to sit under this repo was **deleted on 2026-08-22 — do not recreate it and do not sync node changes into this repo.** Ignore any older instruction to "apply changes twice".

Everything else — the directory path, release process, deployment model, and current node capabilities — is in `CLAUDE.md`. Read it there.

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
| `youtube-channel-benchmark` | On-demand public YouTube channel benchmark (1-3 handles/IDs, no-store) |
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

## Cursor Cloud specific instructions

- Install from the repo root with `npm install`. In this multi-repo workspace that root is `/agent/repos/POSTORA`, not `/agent` (`npm install` in `/agent` fails with `EACCES` on `/agent/package-lock.json`). `npm ci` fails on the committed lockfile under npm 10.9 (`Missing: esbuild@0.28.2 from lock file`, an optional peer of a nested Vite). Do not rewrite `package-lock.json` only to make `npm ci` pass.
- The dev server is `npm run dev` on port **8080** (`host: "::"` in `vite.config.ts`). The Supabase client throws on startup unless `.env` sets `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Copy `.env.example` to `.env`. The publishable key is the public anon key (the same value as `VITE_SUPABASE_ANON_KEY`). Point the URL at `https://api.postora.cloud`. This environment does not run a local Supabase stack.
- Cloud agents must not sign up, create posts, deploy edge functions, or otherwise mutate production. A read-only check is enough: landing page, `/pricing` (plan names come from `subscription_plans`), and the `/auth` form left unsubmitted.
- These commands pass without secrets: `npm test` (Vitest injects placeholder Supabase env), `npm run typecheck`, and `npm run build`.
- `npm run lint` currently exits non-zero because of existing `no-explicit-any` findings, including under `supabase/functions`. That is existing code, not an environment failure.
