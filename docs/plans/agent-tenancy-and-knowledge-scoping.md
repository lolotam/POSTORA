# Plan: per-account agent tenancy, knowledge scoping, and the cross-user exposures

Status: **plan, awaiting approval**. Nothing in PR1/PR2/PR3 below has been implemented.
Author: investigation by Claude, adversarially reviewed by Codex over two debate rounds.
Date: 2026-08-28.

Required reading for any implementer of this plan: `ARCHITECTURE.md` (layering, Edge Function
shape, additive-migration rule at §migrations, deploy split at §deployment).

---

## 1. What was actually wrong

The original report was "different users see each other's agent settings and knowledge files."
Investigation against the live self-hosted database found **four distinct defects**, only two of
which are genuine cross-user leaks. They are listed here in the order they should be fixed, which is
*not* the order they were reported.

### D1 — `ai-knowledge` storage bucket is public (genuine cross-user exposure, CONFIRMED LIVE)

`storage.buckets.public = true` for `ai-knowledge`, plus a policy `"Public can view ai-knowledge
files"` whose predicate is only `bucket_id = 'ai-knowledge'` — no owner check. A public bucket serves
`/object/public/...` without consulting RLS at all, so the per-owner SELECT policy is decorative.

Verified with an unauthenticated request:

```
GET https://api.postora.cloud/storage/v1/object/public/ai-knowledge/media/<owner>/knowledge-graph/graph.html
→ 200, 3167 bytes
```

The repo migration `supabase/migrations/20260712010000_ai_knowledge_bucket.sql` creates this bucket
**private**. Production has drifted, almost certainly when the knowledge-graph HTML export feature
needed a browser-loadable URL (`ai-knowledge-ingest/index.ts:331,341` construct exactly that public
URL). The exported `graph.html` is derived from *all* of a user's knowledge entities and relations,
so this discloses derived private knowledge even where source documents are protected.

### D2 — every uploaded knowledge file is on a public Cloudinary URL (genuine, larger than D1)

`ai_knowledge_sources.file_path` values are public Cloudinary `raw/upload` URLs whose path embeds the
owner's email address and user id:

```
https://res.cloudinary.com/<cloud>/raw/upload/v.../media/<owner_email>/ai-knowledge/postora_<date>_<user_id>_<n>.md
```

These are business knowledge bases — company profiles, price lists, internal templates. Locking down
D1 does not touch this.

**Constraint discovered during review:** ingestion *re-fetches* the file over unauthenticated HTTP
rather than using the bytes it already had (`ai-knowledge-ingest/index.ts:250,256`;
`ai-knowledge-excel-worker/index.ts:35`). Flipping Cloudinary to private delivery without changing
both download helpers breaks new and repeat ingestion with 401/403.

### D3 — React Query cache leaks the previous user's config across a login switch (genuine)

`useAiAgentConfig.ts:73` keys its query `["ai-agent-config", platform]` with no user id;
`useAiAgentTools.ts:69` uses a bare `["ai-agent-tools"]`. The `QueryClient` is module-level with
`staleTime: 5min` / `gcTime: 10min` (`App.tsx:21`), `signOut` (`useAuth.tsx:125`) never calls
`queryClient.clear()`, and logout does a client-side `navigate("/")` (`DashboardLayout.tsx:219`) with
no page reload.

Consequence: user A signs out, user B signs in in the same tab, and B is shown A's persona, business
profile and instructions for up to five minutes. Worse, `AiAgentManager` copies the cached config
into local form state — **if B saves before B's real config arrives, A's text is persisted into B's
row**, converting a display leak into durable contamination.

`useAiKnowledge` is *not* affected: its keys already include `user.id`.

### D4 — agent config and knowledge are not scoped per connected account (the user's real complaint)

`ai_agent_configs` is `UNIQUE (user_id, platform)` with no `social_account_id` column.
`ai_knowledge_sources` / `ai_knowledge_chunks` carry `user_id` alone. Retrieval RPCs filter on
`p_user_id` only.

So one login managing several brands gets **one** agent per platform and **one** shared knowledge
base. Production: one login owns 9 Instagram accounts, 6 Facebook pages and 6 Threads accounts for
different client brands, all sharing a single config per platform. A side effect: `profile_text`
sources named `Business profile (facebook)` are retrievable by the WhatsApp agent, because retrieval
has no platform or account filter either.

**Not a cross-user leak.** RLS is `auth.uid() = user_id` on every `ai_*` table; `messaging-api`
derives the caller strictly from the JWT `sub`; each login's config rows hold genuinely distinct
content.

---

## 2. Design decisions (settled in debate)

**Asymmetric scoping.** Config and knowledge get different shapes, because they are different kinds
of object:

| Object | Shape | Why |
|---|---|---|
| `ai_agent_configs` | hard `NOT NULL social_account_id` | Persona and instructions are brand voice. A newly connected account must never silently inherit another brand's voice — in an automated public-reply system that failure is worse than showing "configuration required". |
| `ai_knowledge_sources` | stays user-owned; new join table `ai_knowledge_source_accounts (source_id, social_account_id, user_id)` | One business operating three platform accounts has one knowledge base. Hard per-account scoping would force three uploads and 3× embedding cost. |
| `ai_knowledge_chunks` | unchanged | Already carries `source_id`; authorization joins through the source. Denormalizing the account onto every chunk adds consistency work and improves nothing. |
| `ai_threads`, `ai_conversation_modes`, `ai_agent_logs` | unchanged | `conversation_id` is **already account-namespaced** — FB/IG DMs use `${account.id}_${senderId}`, comments `${account.id}:comment:...`, WhatsApp `wa_${phoneNumberId}_${phone}`. Existing `(user_id, platform, conversation_id)` uniqueness is sufficient. |
| `ai_knowledge_entities`, `ai_knowledge_relations` | structurally unchanged | A source linked to three accounts legitimately produces one shared entity; relations retain provenance via `source_chunk_id`. **But `match_ai_knowledge_graph_relations` must still be account-filtered** — see trap 1. |

**No migration UI is needed.** Every config row in production maps to exactly one active account, or
is empty/orphaned. The three logins with multiple accounts on a messaging platform have no config
rows to disambiguate. The backfill is deterministic; it should assert cardinality and **fail closed**
if production changes between now and deployment.

**Backfill knowledge links to *all* of that user's active accounts**, which preserves today's
retrieval behaviour exactly and guarantees zero regression. New uploads require at least one
explicitly selected account.

**Fail-closed retrieval.** A source linked to zero accounts is excluded — the `EXISTS` predicate is
simply false.

---

## 3. The work, in three PRs plus one security PR

### PR1 — stop the two genuine cross-user leaks (hours)

No `ai_*` schema change.

1. Clear the React Query cache **on user-identity transition**, not on event name. Supabase emits
   `INITIAL_SESSION`, `SIGNED_IN` (also on tab refocus) and `TOKEN_REFRESHED` routinely; clearing on
   those causes a refetch storm. Track the previous user id and clear only when it actually changes:

   ```ts
   const previousUserId = lastUserIdRef.current;      // undefined = not yet initialised
   const nextUserId = session?.user.id ?? null;
   const shouldClear =
     event !== "INITIAL_SESSION" &&
     previousUserId !== undefined &&
     previousUserId !== nextUserId &&
     (event === "SIGNED_IN" || event === "SIGNED_OUT");
   lastUserIdRef.current = nextUserId;
   ```

   Clear synchronously at that boundary, before rendering the new identity.
2. Add `user.id` to `useAiAgentConfig` and `useAiAgentTools` query keys (defence in depth — the cache
   clear is the real fix, the keys stop a same-session mixup).
3. Make the `ai-knowledge` bucket private, drop the blanket public SELECT policy, and switch the
   graph export to **short-TTL signed URLs** (15–60 min) minted by the already-authenticated
   `export_graph` action. Store the *object path* durably, not a URL. A separate "public exports"
   bucket is not acceptable: URL secrecy is not authorization.
   Note the frontend currently treats `html_url` / `vault_url` as browser-ready links
   (`AiKnowledgeManager.tsx:331`) — that must change in the same PR.

### PR-SEC — private Cloudinary delivery for knowledge assets (2–4 days + controlled migration)

Its own PR, after PR1 and before PR2. Not a `file_path` rewrite:

1. Store a durable private-asset reference (Cloudinary asset/public id + delivery type), never a
   signed URL.
2. Ship a **shared server-side private-asset loader** that mints an authenticated delivery URL
   internally, and make both download sites use it (`ai-knowledge-ingest`, `ai-knowledge-excel-worker`).
3. Dual-read: support legacy public URLs *and* new private references before moving any data.
4. New uploads use private delivery.
5. Copy/convert existing assets, verify, update the row, then invalidate the public original.
6. Remove legacy public-URL support in a later cleanup.

Chunks stay valid, so no re-embedding is required. Live reply generation reads chunks, not source
URLs, so already-indexed agents are unaffected.

### PR2 — per-account config and knowledge (the user's complaint)

Schema, RPCs, edge functions, and the account selector. **Four seams must be inside PR2**, or it
ships something that is actively wrong rather than merely incomplete:

1. **Profile-text source identity.** `ingest_profile_text` finds its source by
   `(user_id, type, "Business profile (${platform})")` (`ai-knowledge-ingest/index.ts:704,712`). Two
   Facebook accounts would overwrite one source even with the join table present.
2. **Both retrieval paths.** The initial RAG lookup *and* the `search_knowledge` tool callback
   (`ai-agent-reply/index.ts:549,624`, `tools.ts:77`) must be account-scoped.
3. **Shared-scope tabs.** `AiAgentManager` embeds `AutoReplyManager` and `DatabaseConnectorsManager`,
   whose backing data stays user-wide until PR3. Either label them "shared across all accounts" or
   hide them, or the page lies about what it scopes.
4. **WhatsApp catalog.** `sync_catalog` reuses one user-wide source named `WhatsApp catalog`
   (`ai-knowledge-ingest/index.ts:778,802`). Create an account-dedicated catalog source immediately,
   resolved through the join table — do not disable the feature. Legacy catalogs: link to the sole
   WhatsApp account if there is one; leave unlinked and require one sync per number if there are
   several.

Plus: source creation must become an **atomic RPC** (derive caller from `auth.uid()`, validate every
supplied account belongs to them, insert source + all links, set `status='pending'`, commit) invoked
*before* ingestion is enqueued. The Excel queue claimant must additionally require at least one
account link. This prevents the invisible orphan — an uploaded file the user can see that silently
answers nothing.

Retrieval predicate for `match_ai_knowledge_chunks` (and the `_bge_m3` twin, substituting
`embedding_bge_m3`):

```sql
FROM public.ai_knowledge_chunks AS c
JOIN public.ai_knowledge_sources AS s
  ON s.id = c.source_id AND s.user_id = p_user_id
WHERE c.user_id = p_user_id
  AND c.embedding IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.ai_knowledge_source_accounts AS link
    JOIN public.social_accounts AS account
      ON account.id = link.social_account_id AND account.user_id = p_user_id
    WHERE link.source_id = c.source_id
      AND link.social_account_id = p_social_account_id
  )
ORDER BY c.embedding <=> query_embedding
LIMIT match_count;
```

Indexes: unique `(source_id, social_account_id)`, plus retrieval index `(social_account_id, source_id)`.
The join table should enforce same-user integrity structurally (composite FKs to `(source_id,user_id)`
and `(social_account_id,user_id)`, or a trigger) rather than relying on RLS alone.

Also in PR2: the authenticated test sandbox hardcodes `social_account_id: "test"` and a conversation
id of `test_${platform}_${user.id}` (`ai-agent-reply/index.ts:420,434`). Once the test UI selects an
account, that synthetic id must include the account id or two same-platform accounts collide.

### PR3 — the long tail

`ai_agent_tools`, `whatsapp_auto_replies` / `messenger_auto_replies` and their usage rows, comment
automation filters, and the daily-cap semantics question below.

**Correction carried from the debate:** an earlier concern that one brand could exhaust another's
daily cap is *wrong* for the current implementation — comment counting is restricted by an account-ID
conversation prefix and DM counting by the exact account-namespaced conversation id
(`ai-agent-reply/index.ts:181,191,193`). The real pre-existing oddity is that `daily_message_cap = 50`
means 50 replies *per customer conversation* for DMs, not 50 per account per day. If the UI describes
it as an account-wide ceiling, that is a pre-existing product bug, not a PR2 regression.

---

## 4. Traps for the implementer

Put these verbatim in any implementation brief. Each one passes a single-account test suite.

1. **Do not fix only the first vector lookup.** There are three retrieval paths: initial RAG, the
   `search_knowledge` tool, and graph expansion. Account-filter all three. Graph expansion must filter
   by *relation provenance* — a shared entity can otherwise pull relations from an unlinked source.
2. **Do not trust `social_account_id` because the request is service-role authenticated.**
   `ai-agent-reply` accepts internal request fields and service role bypasses RLS. Resolve the account
   by id *and* expected owner, derive platform and owner from that row, and enforce same-owner links
   at the database level.
3. **Do not leave old logical identities behind.** Updating the config SELECT while leaving
   `onConflict: "user_id,platform"` (`messaging-api/index.ts:481`) makes multi-account saves fail once
   the old constraint is dropped. Same class of bug as the profile-text filename key.

**Tests must use two same-platform accounts under one user, and at least one unlinked source.**
One-account fixtures cannot prove this fix.

---

## 5. Deploy order for PR2 (expand → deploy → contract → frontend)

The frontend auto-deploys on merge to `main`; edge functions deploy separately via the runtime
checkout. That split makes ordering load-bearing.

1. Preflight: re-run the cardinality/backfill assertions, capture affected rows.
2. **Expansion migration while old code is still live** — nullable `social_account_id`, deterministic
   backfill, per-account unique index *retaining* the legacy `(user_id, platform)` uniqueness, create
   and backfill `ai_knowledge_source_accounts`, add account-scoped RPC overloads *without* dropping
   the old signatures, add RLS/constraints/indexes. Must remain compatible with the old
   `messaging-api`.
3. Deploy every changed edge function **and** `_shared` module from the PR branch, verify hashes,
   restart the functions service once so no mixed-version module set loads. The new `messaging-api`
   must temporarily accept a request with no `social_account_id` by deriving the sole active account.
4. Smoke-test the new runtime against both the old frontend contract and account-aware requests:
   config read, config write, initial RAG, tool RAG, graph RAG, profile ingestion, Excel ingestion.
5. **Contract migration** — re-run the backfill to catch writes during the expansion window, assert
   zero NULLs, enforce `NOT NULL`, drop the legacy unique constraint. Keep legacy RPC signatures for a
   later cleanup.
6. Real webhook/reply smoke test: two same-platform accounts must resolve different configs and grants.
7. Merge to `main` → Dokploy deploys the account-selector frontend.
8. Verify live UI, repeat the two-account reply test.

**The single most dangerous wrong-order step** is deploying the account-aware edge functions *before*
the expansion migration. In that window `ai-agent-reply` queries a nonexistent column and calls
nonexistent RPC signatures; missing config is treated as `agent_not_configured` and RAG failures
deliberately degrade to answering without knowledge — so agents silently stop, or answer with no
knowledge base, with no loud error.

---

## 6. Deployment note

Local files are CRLF; the deployed functions volume is LF. Strip CR when copying, or hashes will not
match even when content is identical. (Verified: `whatsapp-oauth/index.ts` with CR stripped hashes
identical to the deployed file — there is no repo/production drift today.)
