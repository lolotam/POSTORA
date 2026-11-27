# YouTube Channel Benchmark — Policy Review & OD-4 Decision Record

- **Date:** 2026-11-27
- **Phase:** YouTube vNext Phase 6B (`PR-15`, `docs/specs/2026-11-26-youtube-vnext-roadmap-and-ux.md` §11.2, `docs/plans/2026-11-26-youtube-vnext-roadmap-and-ux.md` §PR-15)
- **Owner Decision (`OD-4`):** Approved (**Go**, standalone `/youtube/benchmark` page behind `feature_youtube_benchmark` / `youtubeBenchmark` feature flag, default `false`), under Waleed's overnight delegation (`"I WILL SLEEP NOW AND U HAVE THE MERG DESCIONS AND YOU CAN SLECT RECCOMENDED IF ANY QUESTIONS UNTILE I WILL WAKE AGAIN"`).

---

## 1. YouTube API Services Developer Policies & Terms Review

Reviewed against the **YouTube API Services Terms of Service** and **YouTube API Services Developer Policies** (Section III.E — *Handling YouTube Data and Content*, Section III.E.4 — *Storing and Deleting Data*, Section III.D — *Minimum Functionality & Attribution*, and Section III.E.4.g — *Prohibition on Aggregating or Commingling Data Across Unaffiliated Channels*):

1. **Public Data Only, Explicit User Input, No Background Scraping:**
   - The benchmark endpoint (`supabase/functions/youtube-channel-benchmark`) queries **only public YouTube Data API v3 fields** (`channels.list?part=snippet,statistics,contentDetails`, `playlistItems.list?part=contentDetails`, `videos.list?part=snippet,statistics`) for 1 to 3 public channel handles (`@handle`) or channel IDs (`UC...`) explicitly typed by the authenticated creator in an on-demand comparison request.
   - No background polling, scraping, or automated discovery is performed.

2. **Zero Persistence & Strict Data Freshness (`Cache-Control: no-store`):**
   - Nothing read from `youtube-channel-benchmark` is written to any database table, storage bucket, or log line in Postora.
   - All HTTP responses from `youtube-channel-benchmark` carry `Cache-Control: no-store`.
   - In the browser, React Query holds settled per-channel results (`"found"` without `error`, and `"not_found"`) in memory only (`staleTime = 30 * 60 * 1000`, 30 minutes — well within YouTube API Services' 30-day maximum for Authorized Data and 24-hour refresh guidance for displayed statistics), with **no browser storage persistence** (`localStorage`/`sessionStorage`/`IndexedDB` are never written), and clears the cache automatically on sign-out or user change (`QueryCacheAuthScope`).
   - Transient or degraded responses (`"unavailable"`, `"found"` carrying `error`, or request-level errors) are never cached as fresh (`staleTime: 0`), so retrying one channel or clicking Compare again re-queries only the failed channel without re-spending quota on already-settled channels.

3. **No Cross-Channel Aggregation or Derived Rankings Across Unaffiliated Channels:**
   - Each queried channel is rendered in its **own distinct column** with its own status (`"found"`, `"not_found"`, or `"unavailable"`), its own public statistics (`subscriber_count` or hidden notice, `view_count`, `video_count`), and its own per-recent-video averages computed in the browser from that channel's own recent uploads (`up to 10` videos).
   - Postora does not combine figures across different channels into a composite score or cross-platform metric, and clearly displays the `fetched_at` timestamp and YouTube attribution line (`"Public channel data provided by YouTube API Services"`).

4. **Bounded Quota & Credential Isolation:**
   - The caller's own connected native YouTube account (`account_id`, verified by `id` and `user_id` ownership) supplies the `youtube.readonly` OAuth credential only; its channel is never implicitly added as a lookup target, and foreign `account_id` values are refused with `404 not_found`.
   - Each channel costs **at most 3 units** (`1` unit when `channels.list` returns 0 items -> `"not_found"`; `2` units when the uploads playlist has 0 items -> `videos.list` is skipped; `3` units when recent videos are enriched), for a maximum of `9` units per 3-channel request.
   - Enforced by per-user rate limits (`10` requests / 10 minutes and `30` requests / 24 hours via `check_rate_limit`) and a dedicated project-wide daily budget bucket (`youtube-channel-benchmark:budget:data:<YYYY-MM-DD Pacific>`, ceiling **300 units/day** via `check_weighted_rate_limit`), debited by the exact units spent (`1`, `2`, or `3`).

---

## 2. Placement & Feature Flag Decision (`OD-4`)

- **Decision:** **Go** — ship as its own feature module (`src/features/youtube-benchmark/`) and Edge Function (`supabase/functions/youtube-channel-benchmark/`), mounted at `/youtube/benchmark` (`src/pages/youtube/YouTubeBenchmarkPage.tsx`) and gated behind the feature flag `feature_youtube_benchmark` (`flags.youtubeBenchmark`, default `false`, included in `VISIBILITY_FLAG_KEYS` so it stays dark until explicitly enabled after the Edge Function is deployed).
