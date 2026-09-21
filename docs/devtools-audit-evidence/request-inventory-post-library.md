# Request inventory — `/post`, opening the media Library

Vite dev, `localhost:8080` → production Supabase, StrictMode on. Account holds 413 media files,
136 of them without `metadata.width` at the start of the session.

## Before fixes — one click on "Library ⌘4"

Requests attributable to the click, in order:

| Group | Count | Endpoint |
|---|---|---|
| plan/limits | 4 | `user_subscriptions?select=plan_id,status,subscription_plans!inner(slug)` — **4 identical concurrent** |
| plan/limits | 5 | `tier_rate_limits?plan_slug=eq.free&is_active=eq.true` |
| plan/limits | 5 | `user_rate_limits?user_id=eq.…` |
| plan/limits | 4 | `rpc/get_ai_rate_limit_counts` |
| quotas | 2 | `user_quotas` (one narrow select, one `select=*`) |
| quotas | 3 | `HEAD posts` / `HEAD media_files` day- and month-counters |
| AI | 3 | `ai_providers`, `ai_models`, `system_settings?key=like.default_ai_model%` |
| AI | 1 | `caption_history?select=*&limit=50` |
| library | 1 | `media_folders` |
| library | 1 | `media_files?folder_path=eq./` — **413 rows / 442 KB**, unpaginated |
| library | 1 | `social_accounts` (filter list) |
| **heal** | **10** | **`PATCH media_files?id=eq.…` with body `{"metadata":{"width":…,"height":…}}`** |
| **heal** | **8** | **repeat `GET media_files?folder_path=eq./`** — one refetch per heal |

The 10 PATCH + 8 refetch pairs are F1 and F2: each healed thumbnail wrote to the database and then
invalidated the whole folder listing, re-downloading 442 KB.

## After fixes — same click, same account

| Group | Count | Note |
|---|---|---|
| library | 1 | `media_files?folder_path=eq./` |
| heal | 0 | rows in the first viewport had already been healed earlier in the session |
| heal (after scrolling the grid to the bottom) | 8 `PATCH` | bodies now merge (below) |
| library refetch after heals | **0** | cache patched in place with `setQueriesData` |

### PATCH body, before

```json
{"metadata":{"width":500,"height":500}}
```

39 bytes. `format`, `duration` and `original_filename` are gone from the row.

### PATCH body, after

```json
{"metadata":{"width":1024,"format":"png","height":1024,"duration":null,
             "original_filename":"<uuid>_<uuid>"}}
```

168 bytes. Every key the upload path wrote survives.

## Not changed

`media_files` is fetched unpaginated on purpose — `src/pages/MediaLibrary.tsx` carries a comment
explaining that folder navigation, search and all filters run client-side over the full array, so a
`.range()` would silently scope them to the newest N rows. Left as-is; see finding F7.
