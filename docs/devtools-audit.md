# Chrome DevTools audit — 2026-09-21

Browser-side audit of the authenticated app: which requests each route needs, what repeats, what
fails, and where the cause lives. Findings that were fixed are marked; the fixes are in the working
tree, uncommitted and undeployed.

## Environments

| Label | Front end | Backend | React StrictMode |
|---|---|---|---|
| **dev** | `vite` dev server, `http://localhost:8080` | **production** self-hosted Supabase, `https://api.postora.cloud` | on (doubles effects) |
| **preview** | `vite preview` of a production build, `http://localhost:4173` | same production Supabase | off |
| **prod** | `https://postora.cloud` | same | off — **not exercised; no measurement here comes from it** |

The repository has no local backend: `.env` points `VITE_SUPABASE_URL` at `https://api.postora.cloud`,
so every measurement below was taken against **production data**. Session: the admin account
`dr.vet.waleedtam@gmail.com` (199 posts, 413 media files, no `user_subscriptions` row), Chrome 152,
1 tab, default viewport, no network or CPU throttling.

Because dev runs under StrictMode, every duplicate claimed as real was re-counted on **preview**
before being reported. Where the two disagree, the preview number is the one quoted.

MCP capability check: `chrome-devtools` provided network listing with request/response bodies,
console messages with issue details, performance tracing, and Lighthouse. `supabase` MCP timed out on
every `execute_sql` call, so database facts were obtained through `ssh-contabo-mcp` + `psql` instead.

---

## A. Coverage

| Route / scenario | Status | Notes |
|---|---|---|
| `/dashboard` cold load (`ignoreCache`) | tested | dev + preview, before and after |
| `/dashboard` repeat visit, warm cache | tested | dev |
| `/dashboard` idle ~100 s, focused | tested | dev, before fixes |
| `/dashboard` idle ~4 min, focused | tested | dev, after fixes — the comparable counterpart to the before-fix idle run |
| `/dashboard` idle ~2 h, background tab | tested | preview, after fixes. Chrome throttles timers in a hidden tab to roughly one tick per minute, so absolute rates from this window understate a focused tab and are not used for before/after |
| `/dashboard` → `/post` client-side nav | tested | dev |
| `/post` initial render | tested | dev |
| `/post` → Library panel, incl. grid scroll | tested | dev, before and after |
| `/post` → Stock panel | **not tested** | |
| `/post` platform tabs, TikTok consent, scheduling | **not tested** | |
| Realtime subscription behaviour | tested | one multiplexed `wss://…/realtime/v1/websocket` confirmed open on `/dashboard` |
| `/media`, `/history`, `/calendar`, `/scheduled`, `/analytics/*`, `/messaging/*`, `/comments`, `/automation/*`, `/admin/*`, all `/docs/*` | **not tested** | every remaining `path=` entry in `src/components/AnimatedRoutes.tsx` |
| Publishing, message sending, paid AI generation, deletes | **not tested** | deliberately avoided; see "Production writes" |
| `postora.cloud` | **not observed** | |

Two routes were exercised. `src/components/AnimatedRoutes.tsx` declares 156 distinct `path=` entries (136 absolute, the rest nested under the WhatsApp layout), a large share of which are redirects and `/docs/*` pages. **No claim is made that the untested routes are clean.**
`useAIRateLimit`, `useAdminInbox`, `useSupportMessageNotifications`, `useSubscription` and the
WhatsApp inbox hooks all mount widely and are only partially characterised here.

### Production writes made during this audit

The audit ran against live data and the user authorised test scenarios.

- **Unintentional:** opening the media Library triggered 10 `PATCH media_files` writes, 9 of which
  destroyed metadata (finding F1). This is the bug, observed by triggering it.
- **Deliberate repair:** after F1 was fixed, those 9 rows were restored from a snapshot taken before
  the writes (`UPDATE … metadata = metadata || '{…}'` guarded by `NOT (metadata ? 'format')`,
  9 rows updated, verified). A further 8 non-destructive heal writes were made while verifying the fix.
- Nothing was published, sent, generated or deleted.

---

## B. Findings, most severe first

| ID | Route / scenario | Evidence | Root cause | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| **F1** | `/post` → Library; `/media` | `PATCH media_files` body `{"metadata":{"width":500,"height":500}}`; the same row's metadata one request earlier was `{"width":null,"format":"png","height":null,"duration":null,"original_filename":"app_logo"}` | the two `healMetadata` implementations (`src/components/post/MediaLibraryPicker.tsx`, `src/pages/MediaLibrary.tsx`) sent a bare `{width,height}`; PostgREST replaces a `jsonb` column wholesale | **Permanent data loss.** 9 rows lost `format`/`duration`/`original_filename` in one Library open; 47 rows across 2 users lack `format` (consistent with the clobber; 9 of them confirmed by capture) | merge via `mergeHealedDimensions` (`src/lib/mediaMetadata.ts`) | PATCH body now carries all five keys (dev, live); unit test; 9 rows repaired in production, 47 → 38 remaining; those 38 predate this session and their originals were never captured |
| **F2** | `/post` → Library | 10 `PATCH` interleaved with 8 repeats of `GET media_files?folder_path=eq./` (413 rows, 442 KB each) | each heal called `invalidateQueries` on the listing it had just read | ~3.5 MB re-downloaded and 8 redundant queries per Library open, growing with library size | patch the single row with `setQueriesData` instead of invalidating | 8 heals after the fix produced **0** listing refetches (dev, live) |
| **F3** | every authenticated route, idle | `POST functions/v1/messaging-api {"action":"list_conversations",…}` ×2 every 30 s with the bell closed; `x-kong-upstream-latency: 706 ms`; response `{"conversations":[]}` | `src/components/NotificationBell.tsx` (mounted in `DashboardLayout` on every route) calls `useConversations` for MESSENGER/INSTAGRAM/WHATSAPP with a hard-coded `refetchInterval: 30000`, never gated on the popover being open | 2 Meta Graph API round trips per 30 s per open tab, forever, to feed one unread badge | `useConversations` accepts `refetchInterval`; the bell passes 5 min closed, 30 s open | dev, focused tab, ~4 min idle after load: **2** `messaging-api` calls, both at mount, **0** afterwards — against 7 `support_messages`, 6 `admin_inbox_messages` and 4 `check-subscription` on their unchanged timers in the same window. Before the fix the same measurement ran at 5 `messaging-api` per 100 s |
| **F4** | every authenticated route | `GET rest/v1/posts?select=*&order=created_at.desc` → `content-range: 0-198/*`, **244 KB** | `src/components/layout/DashboardLayout.tsx` called `usePosts()` (no limit) only to compute a sidebar badge | the full post history downloaded on every authenticated route, growing per post | new `useScheduledPostCount()` — `select("id", {count:"exact", head:true})` with the filters pushed to the server | request is now `HEAD`, `content-range: */0`, zero-byte body; count matches the old client-side computation (0), and the mechanism returns 199 on an unfiltered control query |
| **F5** | every page load | `GET rest/v1/profiles?select=*` ×3 in dev, **×2 in preview** | `AuthProvider` fetches the profile from both `onAuthStateChange(INITIAL_SESSION)` and `getSession()` | a duplicate request on every load; `select=*` also transferred `api_key_hash`, `referral_code`, `referred_by`, `admin_notified_at` | dedupe with `profileRequestedForRef`; name the 13 columns the context exposes | preview after fix: **1** request, named columns. A `POST auth/v1/token?grant_type=refresh_token` observed mid-session triggered no profile refetch, which the old code would have done |
| **F6** | `/post` | DevTools issues: "No label associated with a form field" ×5, "A form field element should have an id or name attribute" ×1 | unlabelled inputs in the Create Post form | accessibility: screen readers cannot name six controls | **not fixed** | — |
| **F7** | `/post` → Library; `/media` | `GET media_files?folder_path=eq./` → `content-range: 0-412/*`, 442 KB | deliberate: `src/pages/MediaLibrary.tsx` documents that folder navigation, search and every filter run client-side over the full array | payload grows linearly with the library | **not fixed** — needs server-side filtering first, which is a refactor, not a focused fix | — |
| **F8** | `/post` | `user_subscriptions` ×4, `tier_rate_limits` ×5, `user_rate_limits` ×5, `rpc/get_ai_rate_limit_counts` ×4, all concurrent | `src/hooks/useAIRateLimit.tsx` is a raw `useState`/`useEffect` hook, so each mounting component fetches independently and owns its own 60 s `setInterval`. Two components mount it (`CaptionSection`, `ImageGenerator`); StrictMode doubles that in dev | ~2× a 4-request chain per minute while `/post` is open | **not fixed** — see below | — |
| **F9** | every authenticated route, idle | `check-subscription` every 60 s; `admin_inbox_messages` and `support_messages` every 10–30 s | intentional polling in `useSubscription`, `useAdminInbox`, `useSupportMessageNotifications` | an edge-function invocation per minute per tab, plus two admin queries per 30 s | **not fixed** — classified "necessary but inefficient" | — |

### Deliberately classified as legitimate

- **Client-side navigation costs nothing.** `/dashboard` → `/post` issued zero application requests;
  the 5-minute `staleTime` in `src/App.tsx` is doing its job.
- **Deferred panels are genuinely deferred.** `/post` fetches no media, Library or Stock data until
  the user opens those panels.
- **Realtime is connected**, not dead: one multiplexed `wss://api.postora.cloud/realtime/v1/websocket`
  opens on load, which is why `useRealtimeQueryInvalidation` can carry freshness between polls (F3).
- The repeated `app_settings?key=in.(feature_*)` read and the two single-key `app_settings` reads are
  small and cheap; not worth a change on this evidence.

### F8, and why it was left alone

Most of the multiplicity observed on `/post` is StrictMode: two real consumers became four to five
mounts in dev. The genuine production waste is 2× a four-request chain per minute while that one route
is open — an order of magnitude less than F3, which ran on every route forever. Fixing it properly
means moving `useAIRateLimit` onto React Query, and its `updateFromHeaders` path writes per-instance
state that would have to move into the cache. That is a refactor of a hook this audit did not
otherwise touch, and `ARCHITECTURE.md` §35 rules out folding one into a bug-fix change.

A false lead worth recording: `tier_rate_limits?plan_slug=eq.free` fires while a sibling request asks
for `subscription_plans?slug=eq.business`, which looks like a paying user being served free-tier
limits. It is not. `select count(*) from user_subscriptions where user_id = '7fe4d34e…'` returns **0** —
this account has no subscription row at all, so `"free"` is the correct fallback. The `business` slug
comes from a different hook resolving an admin's effective quota. Verified before writing any fix.

---

## C. Changed files

| File | Change |
|---|---|
| `src/lib/mediaMetadata.ts` | **new** — `mergeHealedDimensions`, the merge that F1 was missing |
| `src/lib/__tests__/mediaMetadata.test.ts` | **new** — 4 cases, including "keeps every key the upload path wrote" |
| `src/components/post/MediaLibraryPicker.tsx` | heal merges; cache patched instead of invalidated; failed writes release the heal guard so a later render retries |
| `src/pages/MediaLibrary.tsx` | same, plus `onHeal` now receives the row's existing metadata |
| `src/hooks/usePosts.tsx` | **new** `useScheduledPostCount()`, keyed `["posts", userId, "scheduled_count"]` so the ten existing `invalidateQueries({ queryKey: ["posts"] })` call sites — and the `refetchQueries({ queryKey: ["posts"] })` calls in `src/hooks/useRealtimePostUpdates.tsx`, which fire when a post publishes — keep refreshing the badge by prefix match |
| `src/components/layout/DashboardLayout.tsx` | uses it instead of `usePosts()` |
| `src/hooks/useMessaging.ts` | `useConversations` accepts `refetchInterval`; exports `CONVERSATIONS_REFETCH_MS` |
| `src/components/NotificationBell.tsx` | 5 min closed / 30 s open |
| `src/hooks/useAuth.tsx` | profile fetch deduped; explicit column list |

Seven modified files plus two new ones. Nothing is committed or deployed.

### Behaviour trade-offs accepted

- **F3:** with the bell closed, an unread count can now be up to 5 minutes stale instead of 30 seconds
  — *unless* the realtime subscription on `social_inbox_events` / `messaging_cache` fires first, which
  invalidates the query immediately. Opening the bell restores the 30 s cadence. If Meta webhook
  delivery into `social_inbox_events` is unreliable for an account, that account's badge is the thing
  that degrades; the conversation list itself is unaffected.
- **F5:** the profile is no longer refetched when Supabase re-emits `SIGNED_IN` on tab refocus.
  Profile edits call `refreshProfile()`, which now forces a fetch, so the paths that matter still work.
- **F4:** `/calendar` and `/scheduled` still call `usePosts()`, so those two routes now issue the count
  query *and* the list — one extra request there, 244 KB saved on every other route.

---

## D. Checks run

| Check | Result |
|---|---|
| `npx tsc -b --noEmit` | **pass** (exit 0) |
| `npx vitest run src/lib/__tests__/mediaMetadata.test.ts` | **pass**, 4/4 |
| `npx vitest run` (full suite) | 1683 passed, **4 failed**, 15 skipped — run before the final query-key change |
| `npx vitest run` on the 8 files covering the changed modules (`useAuth`, `useAuthQueryCacheSync`, `usePosts`, `mediaMetadata`, `WhatsAppLayout`, `WhatsAppInboxScreen`, `UnifiedInboxesPage`, `AutomationHub`) | **pass**, 47/47, after every change |
| `npx eslint` on the 9 touched files | 12 errors, 2 warnings — all pre-existing categories (`no-explicit-any` on casts that were already there). Repo baseline is 446 errors across `src`, so lint is not a gate here |
| `npx vite build --mode production` | **pass**, twice |

The 4 full-suite failures are `DatabaseConnectorsManager.composio`, `DatabaseConnectorsManager.credentials`,
`AiAgentManager.staleSave` and `ConnectionPicker`. They are timeouts under full-suite contention, not
regressions: all four pass in isolation **both** with these changes and with them stashed
(`4 passed (4) / 30 passed (30)` in each direction). None of them import anything changed here.

---

## E. Open items

1. **38 media rows remain damaged** (2 users) from Library opens before this session. `format` could be
   reconstructed from the file extension; `original_filename` and `duration` are gone. Needs a decision,
   not an investigation.
2. **F6 accessibility** — six unlabelled form fields on `/post`.
3. **F7 media pagination** — server-side filtering first, then `.range()`.
4. **F8 `useAIRateLimit`** — move to React Query so the two consumers share one fetch and one timer.
5. **F9 polling budget** — `check-subscription` is an edge-function invocation per minute per tab.
   Worth asking whether a 60 s cadence is needed for data that changes on purchase.
6. **Every route but `/dashboard` and `/post` is untested**, and no scenario covers publishing, messaging or AI generation.
7. **Nothing was measured on `postora.cloud`.** Everything here is preview-build-against-production-data.
   Confirming any of it in production needs a real session there.

### What would settle the unresolved ones

- F7/F9 cost: `pg_stat_statements` on the Supabase instance, keyed by the exact query text, would say
  what these actually cost the database — browser latency does not.
- F3 freshness: the rate of `social_inbox_events` inserts per account versus Meta webhook delivery
  logs would show whether realtime alone is enough, or whether the 5-minute floor is load-bearing.

---

## F. Evidence

- `docs/devtools-audit-evidence/request-inventory-dashboard.md` — per-request inventory for `/dashboard`
  in all three configurations, plus the idle-window counts.
- `docs/devtools-audit-evidence/request-inventory-post-library.md` — the Library burst before and after,
  with the PATCH bodies.
- `docs/devtools-audit-evidence/F1-metadata-clobber-rows.json` — the 9 damaged rows, before and after,
  as captured. Filenames generated from the account's user id are redacted; authorization headers, API
  keys and session tokens appear nowhere in this directory.
