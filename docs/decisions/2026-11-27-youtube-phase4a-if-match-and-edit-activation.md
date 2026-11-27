# YouTube Stage 3 / Phase 4A — D5 Fixture & OD-1 Activation Decision Record

- **Date:** 2026-11-27
- **Phase:** YouTube vNext Phase 4A (`PR-9` & `PR-10`, `docs/specs/2026-11-26-youtube-vnext-roadmap-and-ux.md` §8.1, `docs/plans/2026-11-26-youtube-vnext-roadmap-and-ux.md` §§PR-9, PR-10)
- **Owner Decisions (`D5` & `OD-1`):** Approved under Waleed's overnight delegation (`"I WILL SLEEP NOW AND U HAVE THE MERG DESCIONS AND YOU CAN SLECT RECCOMENDED IF ANY QUESTIONS UNTILE I WILL WAKE AGAIN"`).

---

## 1. D5 Fixture & Rehearsal Scope

- **Fixture Scope:** Non-customer private test channel and fixture video (`docs/reports/2026-11-27-youtube-if-match-rehearsal.md`), with all channel IDs, video IDs, and bearer tokens masked in committed artifacts.
- **Permitted Rehearsal Actions:**
  1. Read the fixture video (`videos.list?part=snippet,status`) and record its item `etag`.
  2. Send a conditional no-op (`PUT /youtube/v3/videos?part=snippet` carrying `If-Match: "bogus-etag"`) and confirm `412 Precondition Failed` (`edit_conflict`).
  3. Send a conditional no-op (`PUT /youtube/v3/videos?part=snippet` carrying the freshly read item `etag` in `If-Match`) and confirm `200 OK` plus same-ID verification re-read.
  4. Verify item ETag stability across consecutive `videos.list?part=snippet,status` reads (confirming that `part=snippet,status` omits `statistics`, so view/like counter changes never cause false `If-Match` conflicts).

## 2. OD-1 Activation Decision

- **Decision:** **Activate Published Video Metadata Editing (`PUBLISHED_EDIT_WRITE_ENABLED = true`)** for **title, description, tags, and category** on the `/youtube` video drawer (`YouTubeVideoEditCard.tsx`), fenced by:
  1. `admit()` admission check on `edit_snapshot` and `update_video`.
  2. Derived `edit_metadata` capability requiring native provider, active connection, `youtube.readonly`, and `youtube.force-ssl`.
  3. Snapshot revision digest (`SHA-256` over `(ownerId, accountId, channelId, videoId, values)`) + fresh pre-write re-read + `If-Match` item ETag header on `PUT /youtube/v3/videos`.
  4. Strict fail-closed per-user write counters (`youtube-resources:edit:burst` 10 / 600s and `youtube-resources:edit:day` 50 / 86,400s via `check_rate_limit`) and project-wide 50-unit write budget debit (`youtube-resources:budget:write:<YYYY-MM-DD Pacific>`, 4,000 units/day ceiling via `check_weighted_rate_limit`) executed **after** video ownership and base revision verification and **before** the category catalog read and provider write.
  5. Pre-dispatch `stillBound` re-read (`verifyAccountStillBound`) immediately before `provider.updateVideo`.
  6. Single-attempt lost-answer semantics (`outcome_unknown` on thrown/timed-out `PUT`, non-JSON 2xx, or mismatched-ID 2xx — never retried) and post-write verified snapshot return.
