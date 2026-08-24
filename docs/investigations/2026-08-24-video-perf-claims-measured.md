# Eight video performance/security claims, measured against Postora

Date: 2026-08-24 · Branch: `fix/whatsapp-qr-repair-and-consent-logo`
Method: static counts over the repo, plus live reads from the prod Postgres
(`postorasupabase-supabase-j8axyh-supabase-db`) and the Contabo host.

## Stack mismatch that reframes every claim

The videos assume Next.js + Prisma + a serverless runtime opening its own
Postgres connections. Postora is none of those:

| Video assumes | Postora actually is |
|---|---|
| Next.js (SSR, `unstable_cache`) | Vite SPA, no server rendering |
| Prisma (`select`, `include`, `@unique`) | `supabase-js` → PostgREST over HTTP |
| App opens pg connections per request | 0 files reference `DATABASE_URL`; no `Pool(` anywhere in 126 edge functions |

So three of the eight tips are structurally answered by the architecture, and
the two that land hardest are the ones the videos treat as afterthoughts.

## Verdicts

| # | Claim | Verdict | Anchor |
|---|---|---|---|
| 6 | Unoptimized images | **Realized — worst finding** | 663 MB in one page load; fix exists, wired to nothing |
| 2 | Over-fetching | **Real, two flavors** | 104 `select('*')`; unbounded aggregate-in-JS |
| 8 | `npm audit` | **Real, and the repo defeats the `--production` filter** | 8 high; dev tooling sits in `dependencies` |
| 4 | N+1 | **Not the read pattern; batchable writes instead** | cron loops only |
| 1 | Caching | **Already done client-side; server "cache" is something else** | `staleTime: 5min` |
| 5 | Connection pooling | **Inverted** | PostgREST holds 4 of 75 connections |
| 3 | Missing indexes | **Inverse problem** | 305 of 473 indexes never scanned |
| 7 | Redis | **Mostly does not map** | RLS makes nearly every read per-user |

---

## 6. Images — the one warning fully realized

Measured library (prod):

```
937 images · avg 1,044 KB · max 9.1 MB · 58 files over 2 MB
top user: 550 images = 663 MB
```

`src/pages/MediaLibrary.tsx:305` fetches every one of them:

```ts
.from("media_files").select("*").eq("user_id", effectiveUserId)
.order("created_at", { ascending: false })   // no .range(), no .limit()
```

then `:1082`, `:1115`, `:1148` render each as `<img src={file.publicUrl}>` —
the **full original** — into a `w-full h-full object-cover` cell, with no
`loading="lazy"`, no `srcset`, no width transform. Repo-wide, 33 of 55 `<img>`
tags do carry `loading="lazy"`; the media grid is in the other 22.

**The remediation is already built and connected to nothing:**

- `src/lib/cdn.ts` exports `getCdnImageUrl`, `getCdnThumbnail` (default 150px),
  `getCdnSrcSet`, `getCdnPlaceholder` (`w_20` + blur), with passing tests in
  `src/lib/cdn.test.ts`. **No component imports any of these functions** —
  only the `CdnConfig` / `CdnProvider` *types* are imported, at
  `src/hooks/useCdnConfig.ts:3`.
- The live resolver is a different function: `src/lib/mediaUrl.ts:42`
  `resolveMediaPublicUrl`, used by 3 components. It returns `delivery_url`
  verbatim (`:62`) and accepts **no width argument** — so even the CDN path
  serves originals.
- The Supabase stack runs an **`imgproxy` container** that nothing in the app
  calls.

The "use Cloudinary/ImageKit" step from the video is already done — at *write*
time (19 edge functions touch Cloudinary/Openinary). The gap is read-time
transforms.

## 2. Over-fetching — real, plus a flavor the video misses

- 104 `select('*')` in `src/**` (non-test) against 331 total `.select(` calls;
  56 more in `supabase/functions/**`.
- Worst: `MediaLibrary.tsx:305` above — unbounded `select("*")`.

The video's fix is "select fewer columns." Postora's more expensive pattern is
already column-narrow but still transfers N rows to compute one number —
**aggregate pushdown is the actual fix**:

- `src/pages/admin/AdminAnalytics.tsx:60` — fetches every post's `user_id` in a
  window, then `new Set(...).size` in JS to get a distinct count.
- `src/pages/MediaLibrary.tsx:214` — fetches every media row's `user_id`
  (table-wide, all users) to build a per-user count map client-side. Gated
  `enabled: isAdmin`, so it costs on admin loads only.

Corroborating, from `pg_stat_statements`: a `SELECT posts.user_id FROM posts`
with no WHERE clause, 207 calls at 22 ms average.

Done right for contrast: `src/components/post/MediaLibraryPicker.tsx:162` —
explicit column list plus an embedded `media_file_providers(...)` join.

## 8. npm audit — and why `--production` will not help here

```
npm audit            → 9 vulns (8 high, 1 moderate) across 691 deps
npm audit --omit=dev → 8 vulns (7 high, 1 moderate)
```

Direct: `vite` (high), `react-router-dom` (high), `postcss` (high).
Transitive: `brace-expansion`, `js-yaml`, `nanoid`, `react-router`, `undici`, `esbuild`.

Three corrections to the video for this repo:

1. **`npm audit --production` is deprecated** (npm 11 here); it is `--omit=dev`.
2. **The filter barely filters.** It drops only 1 of 9, and still reports
   `vite` and `esbuild` as production vulnerabilities — because
   `@playwright/test`, `vitest`, `@testing-library/*` and `@vitejs/plugin-react`
   are declared in `dependencies`, not `devDependencies`. Fixing the manifest
   is a prerequisite for the video's advice to mean anything here.
3. **The `--force` warning is empirically validated.** `fixAvailable` for
   vite/esbuild is **vite 8.2.2, `isSemVerMajor: true`**, and this repo already
   has recorded history of an uncommitted vite 8 bump breaking the local build.
   `npm audit fix --force` would take exactly that jump.

Priority: `react-router-dom` — it ships in the browser bundle. vite/esbuild are
build-time.

## 4. N+1 — not the read pattern

- Frontend fetch-list-then-query-per-row: **1 candidate**,
  `src/hooks/history/usePostRetry.ts` (user-triggered, small N).
- PostgREST embedding (`select("a, b, related(*)")`) is the `include`
  equivalent and is used where joins are needed.

What does exist is **serial per-row writes in background jobs**:

- `supabase/functions/leads-api/index.ts:84` and `:133` — per-form and per-lead
  `upsert` in a loop. Batchable into a single array `upsert` today.
- `supabase/functions/refresh-tokens/index.ts:705` — per-account update, but
  each iteration also makes a Meta API call, so serialization is inherent.

Off the user's hot path either way.

## 1. Caching — already done, in a different place

- Global React Query defaults at `src/App.tsx:21` — `staleTime: 5 min`,
  `gcTime: 10 min`, `refetchOnWindowFocus: false`. That is the SPA equivalent
  of the `unstable_cache` advice, already shipped.
- Server-side there is no Redis. Caching is five **Postgres cache tables**
  (`messaging_cache`, `comment_inbox_cache`, `tiktok_api_analytics_cache`,
  `brand_scrape_cache`, `threads_reply_cache`) — a cache living inside the
  database it would be protecting. It saves external Meta/TikTok Graph calls,
  not DB load.
- Only 4 `Cache-Control` headers across 126 edge functions.

## 5. Connection pooling — inverted

Live, from prod:

```
max_connections = 100      in use = 75

supavisor_meta (idle)              25
supabase_admin (unnamed, idle)     13
realtime workers                  ~16
PostgREST 12.2.11                   4   ← serves ALL user traffic
pg_net, auth, misc               rest
```

The application holds **4 of 75**. Roughly 60 are held by the Supabase stack's
own infrastructure. A pooler is already running (`supabase-pooler` / supavisor)
and is itself the largest single consumer. Adding pooling is not the fix; the
25-connection headroom is being eaten by supavisor + realtime, not by request
volume.

Host, against the "upgrade above 75%" trigger: 6 cores, 11.9 GB RAM (7.8 GB
used), load average 0.97 ≈ 16% of 6 cores. Trigger does not fire.

## 3. Indexes — the inverse problem

- 222 `CREATE INDEX` statements across 217 migrations; 473 indexes on `public`.
- The `EXPLAIN ANALYZE` check already passes: in `pg_stat_user_tables`, the only
  table with more sequential than index scans is `auth.audit_log_entries`
  (1 seq scan, a GoTrue internal table). No application table is sequentially
  scanning.
- Inverse finding: **305 of 473 public indexes have `idx_scan = 0`** since the
  last stats reset. Each one costs write amplification on every INSERT/UPDATE.
  Caveat: some back unique or FK constraints and are required regardless of
  scan counts, so this is a review list, not a drop list.

## 7. Redis — mostly does not map

Every user-facing read is scoped by RLS to a user and workspace. The qualifying
category — "changes rarely, read constantly, identical for everyone" — barely
exists in this product. The one endpoint that fits (`openrouter-models`)
already caches. There is a `dokploy-redis` container on the host, but it
belongs to Dokploy, not Postora.

---

## Where the DB cost actually sits

Top `pg_stat_statements` entries by cumulative execution time (~22 days uptime):

| calls | total | avg | statement |
|---|---|---|---|
| 2,960,403 | 20,994 s | 7.09 ms | `realtime.list_changes(...)` |
| 381,196 | 895 s | 2.35 ms | `CREATE TABLE IF NOT EXISTS realtime.schema_migrations` |
| 86,091 | 835 s | 9.70 ms | `net.http_post(...)` from cron |
| 32,540 | 398 s | 12.22 ms | `_analytics.log_events` INSERT (Logflare) |
| 107,321 | 298 s | 2.78 ms | `claim_ai_knowledge_excel_source()` — first app query |

Application queries via PostgREST first appear at rank 5, and that one is a
polling worker rather than user traffic. Spread over 22 days this is well under
1% of one core — **none of it is currently a bottleneck**, which is itself the
honest answer to all eight claims. The cost that exists is infrastructure:
realtime WAL polling, `pg_net` cron dispatch, and Logflare ingest.

## Options, ranked (nothing applied)

1. Paginate `MediaLibrary.tsx:305` (`.range()`), narrow the `select("*")`, add
   `loading="lazy"`, and route thumbnails through `getCdnThumbnail` — or give
   `resolveMediaPublicUrl` a width parameter. Decide which of the two URL
   helpers is canonical; today one is live and transform-less, the other
   transforms and is dead.
2. Push the two count-in-JS aggregations down to SQL RPCs
   (`AdminAnalytics.tsx:60`, `MediaLibrary.tsx:214`).
3. Move `@playwright/test`, `vitest`, `@testing-library/*`, `@vitejs/plugin-react`
   to `devDependencies`, then `npm audit --omit=dev` becomes meaningful. Patch
   `react-router-dom` without `--force`.
4. Review the 305 unused indexes for write amplification (exclude
   unique/FK-backing ones).
5. Batch the `leads-api` per-row upserts.
6. Investigate whether realtime is subscribed to more tables than the UI needs —
   it is the single largest DB consumer and the largest connection holder.
