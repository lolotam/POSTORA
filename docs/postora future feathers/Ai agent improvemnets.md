# AI Agent Improvements

> **Postora product roadmap — future features, grounded in current code state.**
> Last updated: 2026-08-25 · Owner: Postora core team
> Everything in this document sits under the "AI Agent Improvements" umbrella: the goal is that
> every one of Postora's five cores eventually has an AI agent doing the repetitive part of the job.

---

## 0. How to read this document

Section 1 is a **verified snapshot** of where each core actually stands today — checked against the
codebase on 2026-08-25, not against memory or marketing copy. Section 2 is the **single master
priority list** across all cores. Sections 3–8 break each core down. Section 9 is the full
implementation plan for the **YouTube Comment Reply Manager**.

### Ranking criteria

Every item is scored on three axes, and priority is the product of them:

| Axis | Question |
|---|---|
| **Value** | How many users feel this, how often, and does it unlock revenue or retention? |
| **Effort** | Engineering weeks, including migrations, backfills and UI. |
| **External risk** | Does it depend on a platform review, a restricted scope, a quota, or a partner? |

Priority bands:

- **P0** — Do next. High value, unblocked, and other work depends on it.
- **P1** — Do this quarter. High value, but either costlier or waiting on an external review.
- **P2** — Do when P0/P1 land. Real value, not urgent.
- **P3** — Directional. Revisit once the platform matures.

---

## 1. Where we stand today (verified snapshot)

### Core 1 — Autoposting (Postora + n8n)

**Status: mature. This is the most complete core.**

- **10 platforms** publish through `supabase/functions/process-post/index.ts`:
  Bluesky, Facebook, Instagram (both Page-linked and Business Login), LinkedIn, Pinterest,
  Reddit, Threads, TikTok, Twitter/X, YouTube.
- Scheduling runs through `process-scheduled-posts` (cron) and writes per-platform results to
  `platform_posts`.
- The n8n community node `n8n-nodes-postora` is at **v1.8.0**. `PostoraTrigger` v4 is the single
  trigger node (Event Category → Message/Comment Platforms → Account). Post → Create supports
  Media Source = None / URL / Binary Data / **Media File ID**.
- AI content generation already exists: `generate-caption`, `generate-hashtags`, `generate-image`,
  `generate-video`, `suggest-best-times`, `remove-background`, `upscale-image`, `transcode-video`.

**Known weak points:**
- `process-post/index.ts` is a **7,202-line monolith**. Every new platform makes it worse, and
  a bug in one platform handler ships in the same file as the other nine.
- `suggest-best-times` has no historical performance data of its own to learn from (see Core 2).

### Core 2 — Analytics

**Status: functional but shallow. Biggest structural gap in the product.**

- Per-platform pages exist: `src/pages/analytics/{Facebook,Instagram,Threads,TikTok}Analytics.tsx`,
  plus `src/pages/AdAnalytics.tsx` and `src/pages/whatsapp/Analytics.tsx`.
- Edge functions: `threads-insights`, `tiktok-analytics`, `ad-analytics`, `send-weekly-analytics`.

**The structural problem:** analytics are **live-fetched from the platform API on every page load**.
There is no historical time-series store for social insights. The only persistence that exists is
`tiktok_api_analytics_cache` and `whatsapp_message_analytics`. (`observability_metrics` and
`observability_health_snapshots` are infrastructure telemetry, not social analytics.)

Consequences today:
- No trend lines, no period-over-period comparison, no "your reach dropped 30% this week".
- Every page load burns platform API quota.
- Platforms only retain insights for a limited window — **data older than that window is gone forever
  and cannot be backfilled.** Every day without a collector is a day of history permanently lost.
- No AI layer can reason about performance, because there is no dataset to reason over.
- Bluesky, LinkedIn, Pinterest, Reddit, Twitter and YouTube have **no analytics pages at all**.

### Core 3 — Messaging centre + AI agent for DMs

**Status: the most advanced AI surface in the product.**

- Channels: **WhatsApp** (Cloud API + Evolution QR / coexistence), **Facebook Messenger**,
  **Instagram DM**. Backed by `messaging-api`, `whatsapp-*` functions, `messaging_cache`.
- Full workspace UI under `src/pages/whatsapp/`: Conversations, Contacts, Broadcasts, Templates,
  Catalog, Pipelines, Quick Replies, Auto Replies, Scheduled, Agents, Analytics, Automation.
- **AI agent** (`ai-agent-reply`, 758 lines) with:
  - RAG over `ai_knowledge_sources` / `ai_knowledge_chunks`, ingested by `ai-knowledge-ingest` and
    `ai-knowledge-excel-worker`. Dual embedding providers (`_shared/knowledgeEmbeddings.ts`):
    Gemini `gemini-embedding-001` @1536 dims into `embedding` (default), or Ollama bge-m3 @1024
    into `embedding_bge_m3` — selected by `EMBEDDING_PROVIDER`, with the dimension/column pairing
    enforced at config resolution.
  - Multi-provider model routing (`ai_providers` / `ai_models`), 25s chat timeout, provider fallback.
  - Tools: `search_knowledge`, `escalate_to_human`, `notify_admin`.
  - Admin tools: `list_connected_accounts`, `search_posts`, `get_posting_summary`,
    `create_scheduled_post`.
  - Safety gates: 24h WhatsApp service window, per-thread cooldown, daily reply cap,
    "human assigned and online" suppression.
  - Handler routing per account: `automation_handler` ∈ `internal` | `n8n` | `off` (default `internal`).

**Known weak points:**
- `HISTORY_LIMIT = 4` — the agent only sees the **last 4 turns**. Anything earlier in the
  conversation is invisible to it. This was lowered deliberately for cost, but it is the single
  biggest quality ceiling on the agent today.
- `MAX_INBOUND_CHARS = 2000` truncates long customer messages.
- Tools are read-mostly. The agent cannot look up an order, check stock, book a slot, or take
  payment — the actions that would actually close a support loop.
- No agent-quality metrics: no containment rate, no CSAT, no "did the AI actually resolve it".

### Core 4 — Comment manager + AI comment automation

**Status: works for 3 platforms, architecturally the least finished core.**

- `comment-manager` (269 lines) serves **Facebook Pages and Instagram only**:
  `get_page_comments`, `get_ig_comments`, `reply_comment`, `hide_comment`, `delete_comment`.
- `src/components/comments/CommentManagerPanel.tsx` is typed `platform: "facebook" | "instagram"` —
  the UI union is the hard limit on platform coverage.
- `_shared/commentActions.ts` is the platform-agnostic action layer and supports
  **Facebook, Instagram and Threads** (reply / hide; delete on FB+IG).
- **Threads** comments arrive by Postora's own polling (`threads-poll-replies`, cron every 2 min)
  through `_shared/threadsCommentIngest.ts` — Meta's Threads webhooks never delivered `replies`.
- AI automation: `_shared/commentAutomation.ts` (173 lines) runs auto-reply rules
  (`_shared/autoReplyRules.ts`) then the AI agent, keyed per `(post, commenter)` by
  `_shared/commentConversation.ts`. Gated per account by
  `comment_automation_handler` ∈ `off` | `internal` | `n8n` (**default `off`**).
  Comments authored by the connected account are never dispatched — that is what breaks reply loops.

**Known weak points:**
- **`comment_inbox_cache` is a dead table.** It exists in migrations and in
  `src/integrations/supabase/types.ts`, but **nothing in `src/` or `supabase/functions/` reads or
  writes it.** Every comment view is a live Graph poll. There is no comment history, no search,
  no unread state, no sentiment persistence, and no way to answer "what did people say last month".
- Facebook/Instagram comments are polled on page load, not webhook-driven — so a comment can exist
  in the UI with no corresponding `social_inbox_events` row.
- **No YouTube, LinkedIn, TikTok, Reddit, Pinterest or Bluesky comment support.**

### Core 5 — Marketing API (Meta Ads)

**Status: earliest core. Read is decent, write is minimal.**

- `ad-analytics` (154 lines) — read: `get_ad_accounts`, `get_campaigns`, `get_adsets`, `get_ads`,
  `get_account_insights`. Pulls impressions, reach, clicks, spend, CPC, CPM, CTR, actions,
  `cost_per_action_type`.
- `ad-manager` (157 lines) — write: `create_campaign`, `update_campaign_status`, `create_adset`,
  `delete_campaign`.

**What is missing is most of the funnel:**
- **No ad creative creation** — you can build a campaign and an ad set, but you cannot create the
  actual ad. The object chain stops one level short of shipping.
- No custom audiences, no lookalikes, no saved audiences.
- No boost-post / promote-existing-post flow (the single most requested SMB ads feature).
- No Conversions API (CAPI) / pixel / dataset events.
- No budget rules, no automated optimisation, no creative testing.
- Meta only. No Google Ads, TikTok Ads, LinkedIn Ads.

---

## 2. Master priority list (all cores, ranked)

| # | Priority | Item | Core | Effort | External dependency |
|---|---|---|---|---|---|
| 1 | **P0** | Social analytics warehouse + scheduled collector | 2 | L | None |
| 2 | **P0** | Comment inbox persistence + webhook-first ingest (revive `comment_inbox_cache`) | 4 | M | Meta webhook fields |
| 3 | **P0** | AI agent long-context memory (rolling summary, replace `HISTORY_LIMIT=4`) | 3 | M | None |
| 4 | **P0** | YouTube comment manager — **Phase A: read-only** | 4 | S | None (existing scope) |
| 5 | **P0** | Meta ad creative + ad creation, and boost-post flow | 5 | M | Meta App Review (`ads_management`) |
| 6 | **P1** | YouTube comment manager — **Phase B: reply / moderate / delete** | 4 | M | `youtube.force-ssl` + Google OAuth verification |
| 7 | **P1** | Unified Social Inbox (DMs + comments + mentions in one queue) | 3+4 | L | None |
| 8 | **P1** | AI comment triage: sentiment, intent, auto-hide spam, priority routing | 4 | M | None |
| 9 | **P1** | Analytics AI insights layer (anomalies, weekly narrative, recommendations) | 2 | M | Depends on #1 |
| 10 | **P1** | Agent action tools: order lookup, CRM write, booking, payment link | 3 | L | Per-integration |
| 11 | **P1** | Meta custom + lookalike audiences | 5 | M | Meta App Review |
| 12 | **P1** | Conversions API (CAPI) / pixel events | 5 | M | Meta App Review |
| 13 | **P1** | `process-post` refactor: 7,202-line monolith → per-platform modules | 1 | L | None |
| 14 | **P1** | Comment parity: LinkedIn + TikTok comment manager | 4 | M | LinkedIn/TikTok API review |
| 15 | **P1** | Agent quality metrics: containment, escalation, CSAT, cost-per-resolution | 3 | M | None |
| 16 | **P2** | Multilingual agent with auto language detection + per-language tone | 3 | S | None |
| 17 | **P2** | Analytics parity pages: LinkedIn, YouTube, Pinterest, Bluesky, Reddit, Twitter | 2 | M | Per-platform API |
| 18 | **P2** | Agent prompt A/B testing + versioned prompt rollback | 3 | M | None |
| 19 | **P2** | Voice-note transcription + voice reply in inbox (`transcribe-media` exists) | 3 | S | None |
| 20 | **P2** | Ads agent: automated budget rules + creative fatigue detection | 5 | M | Depends on #5, #1 |
| 21 | **P2** | Content performance loop: feed warehouse data back into caption/image generation | 1+2 | M | Depends on #1 |
| 22 | **P2** | Social listening / keyword + mention monitoring across platforms | 4 | M | Per-platform API |
| 23 | **P2** | Competitor benchmarking dashboard | 2 | M | Public-data only |
| 24 | **P2** | Approval workflows: draft → review → publish, with roles | 1 | M | None |
| 25 | **P2** | Predictive best-time-to-post trained on the account's own warehouse history | 1+2 | M | Depends on #1 |
| 26 | **P3** | Agent template marketplace (industry-preset agents + knowledge packs) | 3 | M | None |
| 27 | **P3** | Google Ads + TikTok Ads + LinkedIn Ads connectors | 5 | L | 3× platform review |
| 28 | **P3** | Influencer / UGC discovery and outreach agent | — | L | Per-platform API |
| 29 | **P3** | White-label / agency multi-tenant mode | — | L | None |
| 30 | **P3** | Native mobile app with push for inbox + approvals | — | XL | App Store review |

Effort key: **S** ≈ ≤1 week · **M** ≈ 2–4 weeks · **L** ≈ 1–2 months · **XL** ≈ 3 months+

---

## 3. Core 1 — Autoposting: future features

### 3.1 Split `process-post` into per-platform modules — **P1**
7,202 lines in one file is now the main source of regression risk in the most business-critical
function in the product. Extract each `postToX` handler into
`_shared/platforms/<platform>.ts` behind a shared `PlatformHandler` interface, keep the dispatcher
thin, and give each platform its own test file. This is a prerequisite for adding platform #11
without the file becoming unmaintainable.

### 3.2 Approval workflows — **P2**
Draft → reviewer → scheduled. Agencies and multi-person teams cannot use Postora for client work
without it. Reuse the existing role model (`user_roles`) and add a `post_approvals` table.

### 3.3 Performance-informed content generation — **P2**
Once the analytics warehouse (#1) exists, feed the account's own top-performing posts back into
`generate-caption` / `generate-hashtags` as few-shot examples. "Write like the posts that actually
worked for *this* account" is a materially better product than "write a caption".

### 3.4 Predictive best-time-to-post — **P2**
`suggest-best-times` currently cannot learn. With a warehouse it can be trained per account, per
platform, per content type.

### 3.5 Auto-repurposing agent — **P3**
One long-form asset (a YouTube video, a blog post) fanned out into platform-native variants:
Reels cut, Threads thread, LinkedIn carousel, Pinterest pin. Leans on existing
`transcribe-media`, `transcode-video`, `generate-image`.

---

## 4. Core 2 — Analytics: future features

### 4.1 Analytics warehouse + scheduled collector — **P0, highest structural priority**

This is the single highest-leverage item in the roadmap, and it is **time-sensitive**: platform
insight windows are finite, so history not collected today is unrecoverable.

**Proposed shape:**

```sql
-- one row per (account, object, metric, day)
create table public.social_analytics_daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  workspace_id uuid,
  social_account_id uuid not null,
  platform text not null,
  object_type text not null,       -- 'account' | 'post' | 'story' | 'video'
  object_id text,                  -- platform post id, null for account-level
  metric text not null,            -- 'reach' | 'impressions' | 'likes' | 'saves' | ...
  value numeric not null,
  collected_for date not null,     -- the day the metric describes
  collected_at timestamptz default now(),
  unique (social_account_id, object_type, object_id, metric, collected_for)
);
```

A single `collect-social-analytics` cron function walks active accounts, pulls the per-platform
insight edges, and upserts on the unique key so re-runs are idempotent. The existing per-platform
analytics pages then read from Postgres instead of the platform API — which also removes the
per-page-load quota burn.

**Unblocks:** #9 (AI insights), #21 (content loop), #23 (benchmarking), #25 (best-time prediction).

### 4.2 AI analytics agent — **P1**
On top of the warehouse: weekly narrative summaries ("Reach fell 22% — driven by three Reels
underperforming your 90-day median"), anomaly detection, and concrete recommendations. This is the
most visible "AI" feature you can ship to a non-technical user, and it is cheap *once the data
exists* — and impossible before then.

### 4.3 Analytics parity for the remaining platforms — **P2**
LinkedIn, YouTube, Pinterest, Bluesky, Reddit, Twitter all publish through Postora but report
nothing back. Users notice the asymmetry.

### 4.4 Cross-platform unified dashboard + export — **P2**
One view across all connected accounts, plus scheduled PDF/CSV reports — the feature agencies buy.
`send-weekly-analytics` is the seed to build on.

### 4.5 Competitor benchmarking — **P2**
Public-data-only comparison against 3–5 tracked competitor handles per workspace.

---

## 5. Core 3 — Messaging + AI agent: future features

### 5.1 Long-context memory — **P0**
Replace the flat `HISTORY_LIMIT = 4` with a two-tier scheme:
1. **Recent turns verbatim** (keep ~6–8).
2. **Rolling conversation summary** persisted on `ai_threads`, updated every N turns by a cheap
   model, injected as a single system block.

Also add a **contact memory** layer: durable facts about a customer (name, language, order history,
preferences) that survive across conversations, stored per `(account, participant)`. Today the agent
re-meets every customer as a stranger every 5 turns.

Raise `MAX_INBOUND_CHARS` above 2000, or summarise long inbound messages instead of truncating them.

### 5.2 Action tools that close the loop — **P1**
The current tool set can search knowledge, escalate, and notify. It cannot *do* anything for the
customer. Highest-value additions, in order:
1. `lookup_order` / `check_order_status` (e-commerce webhook or `ecommerce-whatsapp-api`).
2. `check_availability` + `book_appointment` (calendar integration).
3. `create_payment_link` (Stripe — `stripe-checkout` already exists).
4. `update_contact` / `add_label` / `move_pipeline_stage` (the CRM surfaces already in the UI).
5. `send_catalog_item` (the WhatsApp catalog is already built).

Each tool must be permission-gated per account through the existing `ai_agent_tools` table.

### 5.3 Agent quality metrics — **P1**
`ai_agent_logs` records outcomes but there is no analytics surface over it. Ship:
containment rate (resolved without human), escalation rate and reason, first-response time,
cost per conversation, and a thumbs-up/down signal per reply that feeds prompt iteration.
**You cannot improve the agent without measuring it.**

### 5.4 Multilingual agent — **P2**
Auto-detect the customer's language and reply in it, with per-language tone settings. Postora's
user base is heavily Arabic/English bilingual; this is a small change with disproportionate value.

### 5.5 Prompt versioning + A/B testing — **P2**
Version agent configs, run two prompts against a traffic split, compare containment. Pair with 5.3.

### 5.6 Voice notes — **P2**
WhatsApp is voice-first for many users. `transcribe-media` already exists — wire it into inbound
handling so the agent can read voice notes, and optionally add TTS replies.

### 5.7 Additional channels — **P2/P3**
Telegram (easy, no review), Email-to-inbox (`send-inbox-email` / `fetch-email-content` exist),
Web chat widget, Threads DM, TikTok DM.

---

## 6. Core 4 — Comment manager + AI comment automation: future features

### 6.1 Comment persistence + webhook-first ingest — **P0**

`comment_inbox_cache` exists and is unused. Either revive it or replace it with a schema that
matches what the product now needs, and make ingest the *source of truth* rather than a live poll:

- Webhook path for Facebook/Instagram (extend `facebook-instagram-webhook` comment fields).
- Poller path for Threads (already exists) and, later, YouTube.
- Both funnel into one `ingestComment()` helper — the same shape `threadsCommentIngest.ts` already
  proves out, including its duplicate-suppression and first-pass seeding logic.

**Unlocks:** comment history and search, unread/handled state, persisted sentiment, per-post comment
analytics, "top commenters", and an audit trail of every AI reply — none of which are possible while
comments live only in a transient Graph response.

### 6.2 AI comment triage — **P1**
Before the agent replies, classify: sentiment, intent (question / complaint / praise / spam / lead),
urgency, and language. Then route:
- **Spam / abuse →** auto-hide, no reply.
- **Lead →** reply publicly *and* open a DM (where the platform allows it — the comment-to-DM flow
  is the highest-converting funnel on Instagram).
- **Complaint →** escalate to human, do not auto-reply.
- **Question →** AI agent with knowledge base.
- **Praise →** short acknowledgement, rate-limited.

### 6.3 Unified Social Inbox — **P1**
One queue for DMs + comments + mentions across every platform, with assignment, labels, SLA timers
and saved views. Today DMs live in `/whatsapp/Conversations` and comments live in a separate panel,
which means a team working both is switching context all day. This is the flagship feature that
makes Postora a support tool, not just a publisher.

### 6.4 Platform parity — **P0 → P1**
- **YouTube** — see §9 for the full plan. *(Phase A is P0.)*
- **LinkedIn** — comments on organisation posts. Requires Community Management API access.
- **TikTok** — comment list/reply/hide. Requires TikTok API scope review.
- **Reddit / Pinterest / Bluesky** — lower demand, straightforward APIs.

### 6.5 Comment analytics — **P2**
Volume over time, sentiment trend, response rate, median response time, AI-vs-human reply split,
top commenters. Depends on 6.1.

### 6.6 Bulk moderation + keyword rules — **P2**
Select-many hide/delete, plus a per-account banned-keyword list that auto-hides matching comments
before any AI cost is incurred.

---

## 7. Core 5 — Marketing API: future features

### 7.1 Complete the ad object chain — **P0**
`create_campaign` → `create_adset` → **`create_ad_creative` → `create_ad`**. Right now a user can
build the scaffolding of a campaign and then cannot ship it. This is the highest-value gap in the
core because the current feature is functionally incomplete without it.

### 7.2 Boost post — **P0**
Promote an existing organic post straight from the post history view. For SMBs this is *the* ads
feature; everything else is secondary. It also joins Core 1 and Core 5 into one flow:
publish → see performance → boost the winner.

### 7.3 Audiences — **P1**
Custom audiences (from customer lists, engagement, or website traffic) and lookalikes.
Note the compliance requirement: customer-list uploads must be SHA-256 hashed client-side, and
consent must be recorded.

### 7.4 Conversions API — **P1**
Server-side event forwarding for purchases, leads, and conversations. Increasingly the difference
between ads that optimise and ads that do not, as browser-side pixels degrade.

### 7.5 Ads AI agent — **P2**
On top of 7.1 + the analytics warehouse: budget reallocation rules, creative fatigue detection
(CTR decay vs frequency), audience overlap warnings, and a plain-language weekly performance memo.
Generate ad creative variants with the existing `generate-image` / `generate-caption` pipeline.

### 7.6 Additional ad platforms — **P3**
Google Ads, TikTok Ads, LinkedIn Ads. Each is its own review process and its own object model;
do not start until Meta is genuinely complete.

---

## 8. Cross-cutting / infrastructure

These are not one of the five cores, but several cores are blocked or degraded without them.

| Item | Priority | Why |
|---|---|---|
| Media CDN read path | P1 | `src/lib/openinary.ts` exports `buildOpeninaryTransform` / `isOpeninaryUrl`, and **no non-test file in `src/` imports either**. The media grid therefore loads every original at full size. Real, measurable page-weight cost for a fix that is already written. |
| Token health + auto-reconnect UX | P1 | Expired tokens silently break posting, analytics, comments and the agent at once. `refresh-tokens` + `check-connection-health` exist; the recovery UX does not. |
| Cost controls per workspace | P1 | AI spend has per-account caps but no workspace budget ceiling or forecast. |
| Rate limiting beyond `n8n-api` | P2 | The multi-hop `X-Forwarded-For` → `inet` bug that silently disabled counting **is fixed**: `n8n-api/requestGuards.ts:57` `clientIpFromHeaders` sanitizes the header, insert errors are now logged instead of swallowed, and `requestGuards.test.ts` + `rateLimitEnforcement.test.ts` cover it. Remaining gap: `n8n-api` is the *only* function with request-based rate limiting. Other `api_logs` writers (`generate-caption:230`, `generate-image:664`) hardcode `ip_address: '0.0.0.0'` and are unmetered. |
| Test coverage on `process-post` | P2 | The largest and most critical file has the least protection. |
| Audit log / activity feed | P2 | Required for agency and enterprise buyers. |

---

## 9. YouTube Comment Reply Manager — implementation plan

### 9.1 The headline constraint: OAuth scope

**This is the first thing to resolve, before any code is written.**

Postora's YouTube connection currently requests exactly two scopes
(`supabase/functions/youtube-oauth/index.ts`):

```
https://www.googleapis.com/auth/youtube.readonly
https://www.googleapis.com/auth/youtube.upload
```

The comment write operations each require **`https://www.googleapis.com/auth/youtube.force-ssl`**
("See, edit, and permanently delete your YouTube videos, ratings, comments and captions"):

| Operation | API method | Scope needed |
|---|---|---|
| List comment threads on a video | `commentThreads.list` | `youtube.readonly` ✅ **already have** |
| List replies to a comment | `comments.list` | `youtube.readonly` ✅ **already have** |
| Reply to a comment | `comments.insert` | `youtube.force-ssl` ❌ |
| Hide (moderate) a comment | `comments.setModerationStatus` | `youtube.force-ssl` ❌ |
| Mark as spam | `comments.markAsSpam` | `youtube.force-ssl` ❌ |
| Delete a comment | `comments.delete` | `youtube.force-ssl` ❌ |

**Good news, verified:** `youtube.force-ssl` is a **sensitive** scope, **not a restricted** scope.
Google's restricted-scope list covers Gmail, Drive, Fit, Chat, Data Portability, Photos Ambient and
Health — no YouTube Data API scope appears on it. That means:

- ✅ Google OAuth **app verification / review** is required (branding, privacy policy, a demo video,
  a scope-justification writeup).
- ✅ **No CASA third-party security assessment**, and no annual recertification burden.

Confirm the classification again at submission time — Google moves scopes between tiers.

**Migration cost that is easy to underestimate:** adding a scope means **every existing YouTube
connection must re-consent**. Plan for a "reconnect to enable comment management" banner and a
graceful degrade — accounts that have not re-consented keep posting normally and see the comment
tab in read-only mode.

### 9.2 The second constraint: quota

YouTube Data API v3 default allocation is **10,000 units/day per project**, shared across all
Postora users. Verified costs:

| Method | Units |
|---|---|
| `commentThreads.list` | 1 |
| `comments.list` | 1 |
| `videos.list` | 1 |
| `comments.insert` | **50** |
| `comments.setModerationStatus` | **50** |
| `comments.delete` | **50** |
| `search.list` | 1 (but capped at **100 calls/day** by default) |

The implications are concrete:

- **Never use `search.list`** to find a channel's videos — the 100/day cap would be exhausted by a
  handful of accounts. Use `channels.list` → `contentDetails.relatedPlaylists.uploads` →
  `playlistItems.list` (1 unit each).
- **Writes are 50× reads.** 10,000 units = at most **200 AI replies per day across the entire
  platform**, before any polling. This makes a per-account daily reply cap non-optional, and it is
  the strongest argument for AI *triage* (§6.2) — only reply where a reply is worth 50 units.
- **Polling must be far coarser than Threads' 2-minute cron.** A 15-minute cadence over N accounts
  × M recent videos costs `N × M × 4 × 24` units/day. At 50 accounts × 5 videos that is 24,000
  units — already over budget. So:
  - Poll only videos published or commented on in the last 7 days.
  - Tier the cadence: hourly for active channels, daily for quiet ones.
  - Track `etag` / `updated_at` and skip unchanged threads.
  - Apply for a **quota extension** from Google in parallel with OAuth verification — it is a
    separate form and takes weeks.

### 9.3 Architecture — reuse what already works

The Threads comment pipeline already solved this exact problem (a platform with no usable comment
webhook), so mirror it rather than inventing a second pattern.

```
                      ┌─────────────────────────────┐
   cron (tiered) ────▶│  youtube-poll-comments      │   NEW edge function
                      │  channels.list → uploads    │
                      │  playlistItems.list         │
                      │  commentThreads.list        │
                      └──────────────┬──────────────┘
                                     │
                      ┌──────────────▼───────────────┐
                      │ _shared/youtubeCommentIngest │  NEW, modelled on
                      │  dedupe · seed-on-first-pass │  threadsCommentIngest.ts
                      └──────────────┬───────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
    comment_inbox_cache      social_inbox_events    _shared/commentAutomation.ts
      (§6.1 persistence)        (observability)       (UNCHANGED — platform-agnostic)
                                                              │
                                                              ▼
                                                   _shared/commentActions.ts
                                                     + youtube branch  ◀── NEW
```

**Key insight: `commentAutomation.ts` needs no changes at all.** It is already platform-agnostic —
it resolves rules, checks for a prior reply, dispatches to `ai-agent-reply`, and delivers through
`commentActions.ts`. YouTube gets AI comment automation *for free* the moment `commentActions.ts`
learns a `youtube` branch. This is exactly how Threads got an agent.

### 9.4 Work breakdown

**Phase A — read-only (P0, ~1 week, no external dependency)**

Ships value immediately using the `youtube.readonly` scope Postora already holds, and de-risks
Phase B by proving the ingest and quota model before the OAuth review starts.

1. `supabase/functions/youtube-comments/index.ts` — actions `get_channel_videos`,
   `get_video_comments`. Uses the uploads-playlist path, never `search.list`.
2. Widen `CommentManagerPanel`'s union from `"facebook" | "instagram"` to include `"youtube"`,
   with the reply/hide/delete controls disabled and a "Reconnect to enable replies" prompt.
3. Quota accounting: a per-project daily unit counter with a hard stop and an admin alert, so a
   runaway loop cannot burn the whole platform's allocation.

**Phase B — write (P1, ~2–3 weeks + review latency)**

4. Add `youtube.force-ssl` to `youtube-oauth`'s scope list; store which scopes each connection
   actually granted so the UI can degrade per account rather than per platform.
5. Submit for Google OAuth verification (demo video, privacy policy, scope justification) **and**
   file the quota-extension request the same week. Expect **2–6 weeks** of latency — start it
   the day Phase A merges.
6. Extend `_shared/commentActions.ts` with the `youtube` branch:
   - `replyToComment` → `POST /youtube/v3/comments?part=snippet` with
     `snippet.parentId` + `snippet.textOriginal`.
   - `hideComment` → `POST /youtube/v3/comments/setModerationStatus`
     (`moderationStatus=rejected` to hide, `published` to unhide). Note the semantic difference
     from Meta: YouTube "rejected" is closer to *removed from public view* than Meta's `is_hidden`,
     so the UI copy must not say "hidden" without qualification.
   - `deleteComment` → `DELETE /youtube/v3/comments`. **Only comments on your own channel** can be
     deleted; comments authored by others on your videos are moderated, not deleted.
7. Reconnect banner + migration UX for existing YouTube connections.

**Phase C — automation (P1, ~1 week after B)**

8. `youtube-poll-comments` cron + `_shared/youtubeCommentIngest.ts`, with tiered cadence, 7-day
   video window, and etag-based skip.
9. Enable `comment_automation_handler` for YouTube accounts — no changes to `commentAutomation.ts`.
10. Add YouTube to the n8n node's Comment Platforms selector on `PostoraTrigger` v4, and to the
    Comment resource's platform list (**node repo: `F:\N8N\Postora-n8n-community-node`** — never
    vendored into this repo). Ship as a node minor version.

### 9.5 Platform semantics that differ from Meta — do not assume parity

| Behaviour | Meta (FB/IG) | YouTube |
|---|---|---|
| Hide a comment | `is_hidden` / `hide` — reversible, comment stays visible to its author | `moderationStatus=rejected` — reversible, different visibility semantics |
| Delete someone else's comment | Allowed on your own Page/media | **Not allowed** — moderate instead |
| Reply nesting | Comment → reply (2 levels) | Comment thread → replies (2 levels); a reply-to-a-reply is flattened onto the thread |
| New-comment notification | Webhook | **No webhook — polling only** |
| Own-comment loop guard | Filter by page/IG user id | Filter by the channel's own `authorChannelId` — **must be implemented or the agent will reply to itself** |
| Write cost | Effectively free | 50 quota units each |

### 9.6 Definition of done

- A user with a connected YouTube channel sees their recent videos and comment threads in the
  Comment Manager alongside Facebook and Instagram.
- After reconnecting, they can reply, moderate and delete from the same UI.
- `comment_automation_handler = internal` produces AI replies on YouTube comments, subject to the
  same rules, cooldowns and daily caps as Meta comments — and the agent never replies to itself.
- Quota usage is visible to admins, capped, and alerts before exhaustion.
- The n8n node emits YouTube comment events on `PostoraTrigger`.

---

## 10. Suggested sequencing

**Quarter 1 — build the foundations everything else needs**
1. Analytics warehouse + collector (#1) — *start immediately; lost history is unrecoverable.*
2. Comment persistence + webhook ingest (#2).
3. Agent long-context memory (#3).
4. YouTube comment manager Phase A (#4), **and file the Google OAuth verification + quota
   extension the same week** so the review clock runs in the background.
5. Meta ad creative + boost post (#5).

**Quarter 2 — build the differentiators on those foundations**
6. YouTube Phase B + C (#6) as verification clears.
7. Unified Social Inbox (#7).
8. AI comment triage (#8).
9. Analytics AI insights (#9).
10. Agent action tools (#10) + agent quality metrics (#15).

**Quarter 3 — depth and reach**
11. Audiences + CAPI (#11, #12).
12. `process-post` refactor (#13).
13. LinkedIn/TikTok comment parity (#14).
14. The P2 band.

### The one-line strategic read

Postora's five cores are at very different maturity levels — **Core 1 is mature, Core 3 is deep,
Core 4 is half-built, Core 2 is shallow, Core 5 is incomplete.** The two items that unblock the
most downstream value are the **analytics warehouse** and **comment persistence**, because both are
data-layer gaps that make every AI feature above them impossible. Build the data layer first; the
AI features on top of it are comparatively cheap.

---

## Sources for external-platform claims

- [YouTube Data API — quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)
- [YouTube Data API — OAuth 2.0 scopes](https://developers.google.com/youtube/v3/guides/auth/installed-apps)
- [Google — restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Google Cloud — restricted scopes list](https://support.google.com/cloud/answer/13464325)
