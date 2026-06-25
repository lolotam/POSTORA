# Fix CreatePost AI Image Generator & AI Caption Generator

## What's failing
1. **`POST /functions/v1/generate-image` → 500** — outer `catch` returns a bare 500. The UI shows the generic "AI service is temporarily unavailable" toast (your screenshot) regardless of the real cause (no image returned, gateway error, empty response, etc.).
2. **`POST /functions/v1/generate-caption` → 504 + CORS** — the function runs longer than the gateway timeout. When Kong returns 504 it strips CORS headers, so the browser also reports a CORS error. CORS in the function is fine; the real problem is duration. `callAiWithFallback` walks through primary → fallback → last-resort with ~15s each and no total budget, easily exceeding 60s.

## Plan

### 1. `supabase/functions/generate-image/index.ts`
- Replace the bare 500 in the outer `catch` with a structured response `{ success:false, error_code, message }` and CORS headers.
- Map each failure branch to a real `error_code`: `ai_gateway_empty`, `ai_no_image`, `ai_gateway_error`, `ai_credits_exhausted`, `ai_rate_limited`.
- Ensure every error path goes through `errorResponse(...)` / `jsonResponse(...)` so CORS is always present.

### 2. `supabase/functions/generate-caption/index.ts`
- Add a per-provider deadline (12s) and a total request budget (~45s) around `callAiWithFallback` using `Promise.race` + `AbortController`.
- On budget exhaustion, return `200` with `{ success:false, error_code:'ai_timeout', message:'AI is busy, please retry.' }` + CORS — eliminates the 504/CORS pair in the browser.
- Fix the shadowed `rateLimitResult` (`const` inside the `if` shadows the outer `let`) so rate-limit headers are actually applied.

### 3. Client toasts (small)
- `ImageGenerator.tsx` (~L280-294): when the function returns `{ success:false, message }`, show `message`; otherwise keep current fallback toast.
- `CaptionSection.tsx` (~L103-128): same — surface `data.message` when present.

### 4. Verify
- Redeploy both functions, trigger image + caption generation on the live app, confirm: image returns either an image or a specific error toast; caption returns within ~15s or shows "AI is busy" instead of a CORS/504.

## Out of scope
- Apify 404 (`igview-owner~threads-post-scraper`) — needs actor ID update in Admin → Scraping Services.
- DialogContent aria warnings — cosmetic.
- No DB changes, no migrations.

## Files
- `supabase/functions/generate-image/index.ts`
- `supabase/functions/generate-caption/index.ts`
- `src/components/.../ImageGenerator.tsx`
- `src/components/.../CaptionSection.tsx`

## Risks
- Hard timeouts may surface more "AI busy" messages when the gateway is slow — strictly better than the current 504/CORS crash.
- No destructive changes; no SQL.
