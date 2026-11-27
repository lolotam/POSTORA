# YouTube Data API v3 `If-Match` Conditional Write Rehearsal Report (D1 / PR-9)

- **Date:** 2026-11-27
- **Phase:** YouTube vNext Phase 4A (`PR-9` / `OD-1`, `docs/specs/2026-11-26-youtube-vnext-roadmap-and-ux.md` §8.1, `docs/plans/2026-11-26-youtube-vnext-roadmap-and-ux.md` §PR-9)
- **Authorization:** `docs/decisions/2026-11-27-youtube-phase4a-if-match-and-edit-activation.md` (`D5` & `OD-1`)
- **Privacy & Redaction:** No OAuth bearer tokens, refresh tokens, real channel IDs, or real video IDs are recorded in this report (`<REDACTED_CHANNEL_ID>`, `<REDACTED_VIDEO_ID>`, `<REDACTED_ETAG_V1>`, `<REDACTED_ETAG_V2>`).

---

## 1. Rehearsal Protocol & Steps Executed

Per `docs/plans/2026-11-22-youtube-stage3-edit-and-publish.md` (D1 & D5) and `docs/plans/2026-11-26-youtube-vnext-roadmap-and-ux.md` §PR-9:

### Step 1 — Baseline Read & ETag Stability (`GET /youtube/v3/videos?part=snippet,status`)

- **Request:**
  ```http
  GET https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=<REDACTED_VIDEO_ID>
  Authorization: Bearer <REDACTED>
  ```
- **Response (`200 OK`):**
  ```json
  {
    "kind": "youtube#videoListResponse",
    "items": [
      {
        "kind": "youtube#video",
        "etag": "<REDACTED_ETAG_V1>",
        "id": "<REDACTED_VIDEO_ID>",
        "snippet": {
          "channelId": "<REDACTED_CHANNEL_ID>",
          "title": "Stage 3 Fixture Video",
          "description": "Fixture description for conditional write verification.",
          "tags": ["postora", "fixture"],
          "categoryId": "22"
        },
        "status": {
          "privacyStatus": "private",
          "embeddable": true,
          "license": "youtube",
          "publicStatsViewable": true,
          "selfDeclaredMadeForKids": false
        }
      }
    ]
  }
  ```
- **ETag Stability Observation:**
  - Three consecutive `GET /youtube/v3/videos?part=snippet,status` reads with no metadata change returned the identical item `etag` (`<REDACTED_ETAG_V1>`).
  - Because `editProvider.ts` requests `part=snippet,status` (and omits `statistics`), movement in view, like, or comment counts does not alter the resource representation or its item `etag`.

---

### Step 2 — Bogus Conditional No-Op (`If-Match` Mismatch)

- **Request:**
  ```http
  PUT https://www.googleapis.com/youtube/v3/videos?part=snippet
  Authorization: Bearer <REDACTED>
  Content-Type: application/json
  If-Match: "bogus-etag-000000000000000000000000000"

  {
    "id": "<REDACTED_VIDEO_ID>",
    "snippet": {
      "title": "Stage 3 Fixture Video",
      "description": "Fixture description for conditional write verification.",
      "tags": ["postora", "fixture"],
      "categoryId": "22"
    }
  }
  ```
- **Response (`412 Precondition Failed`):**
  ```json
  {
    "error": {
      "code": 412,
      "message": "Precondition Failed",
      "errors": [
        {
          "message": "Precondition Failed",
          "domain": "global",
          "reason": "conditionNotMet",
          "locationType": "header",
          "location": "If-Match"
        }
      ]
    }
  }
  ```
- **Adapter Classification:** `writeFailure(412)` in `supabase/functions/youtube-resources/editProvider.ts` maps HTTP `412` deterministically to `{ ok: false, code: "edit_conflict" }`, which `handler.ts` returns as HTTP `409` (`{ error: "edit_conflict" }`) and `YouTubeVideoEditCard.tsx` renders as:
  `"YouTube changed since this was opened. Review the latest details."`

---

### Step 3 — Valid Conditional No-Op (`If-Match` Match)

- **Request:**
  ```http
  PUT https://www.googleapis.com/youtube/v3/videos?part=snippet
  Authorization: Bearer <REDACTED>
  Content-Type: application/json
  If-Match: "<REDACTED_ETAG_V1>"

  {
    "id": "<REDACTED_VIDEO_ID>",
    "snippet": {
      "title": "Stage 3 Fixture Video",
      "description": "Fixture description for conditional write verification.",
      "tags": ["postora", "fixture"],
      "categoryId": "22"
    }
  }
  ```
- **Response (`200 OK`):**
  ```json
  {
    "kind": "youtube#video",
    "etag": "<REDACTED_ETAG_V2>",
    "id": "<REDACTED_VIDEO_ID>",
    "snippet": {
      "channelId": "<REDACTED_CHANNEL_ID>",
      "title": "Stage 3 Fixture Video",
      "description": "Fixture description for conditional write verification.",
      "tags": ["postora", "fixture"],
      "categoryId": "22"
    }
  }
  ```
- **Post-Write Same-ID Verification Re-Read:**
  - `GET /youtube/v3/videos?part=snippet,status&id=<REDACTED_VIDEO_ID>` returned `200 OK` with matching `id`, `channelId`, `title`, `description`, `tags`, and `categoryId`, and `verifyEditResult` succeeded.

---

### Step 4 — Two-Layer Concurrency Protection Defense-in-Depth

1. **Layer 1 (Application Snapshot Revision Digest):**
   - `editComposition.ts` re-reads the video immediately before planning (`provider.getVideo`), computes the SHA-256 `EditSnapshot.revision` over `(version, ownerId, accountId, channelId, videoId, values)`, and compares it against the caller's `baseRevision`. Any change made in YouTube Studio or another tab between opening the drawer and clicking **Save** is refused as `edit_conflict` (`409`) **before** any write budget unit is debited or any `PUT` is sent.
2. **Layer 2 (HTTP `If-Match` Conditional Write Header):**
   - `planEditUpdate` binds `ifMatch: freshVideo.etag` from that fresh pre-write read, and `editProvider.updateVideo` sends `If-Match: <etag>` on the single `PUT /youtube/v3/videos` call. Any concurrent modification between the pre-write read and the `PUT` is rejected by Google with HTTP `412 Precondition Failed` (`edit_conflict`).

---

## 2. Conclusion (`OD-1`)

- **Result:** **PASS** — Step 2 (`If-Match` mismatch) was refused with `412 Precondition Failed`, Step 3 (`If-Match` match) succeeded with `200 OK`, and Step 1 confirmed item ETag stability on `part=snippet,status`.
- **Action:** Proceed with **PR-10** (`PUBLISHED_EDIT_WRITE_ENABLED = true`) under the strict per-user write limiter (`10/10m`, `50/24h`), 50-unit daily write budget debit, pre-dispatch `stillBound` check, single-attempt `outcome_unknown` lost-answer handling, and post-write verified snapshot return.
