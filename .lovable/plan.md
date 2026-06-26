
## Goal

Restyle `PageSelectionDialog` (the "Select a Facebook Page" popup shown after Facebook OAuth on `/profiles`) so it looks and behaves exactly like the Instagram-via-Facebook `InstagramSelectionDialog`: a grid of small square cards with the page logo, page name, and an "IG" badge — instead of the current vertical list of full-width buttons.

Frontend-only. No backend, SQL, env, or edge-function changes.

## What changes visually

Current: stacked rows (full-width outline buttons) for each FB Page, plus an Instagram-only section below.

New (mirrors `InstagramSelectionDialog`):
- Same shadcn `Dialog` shell (`sm:max-w-2xl`) with `DialogHeader` / `DialogTitle` / `DialogDescription` / `DialogFooter`.
- Same search input with `Search` icon.
- Grid of square cards: `grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto`.
- Each card: `aspect-square`, rounded border, hover ring; circular 64×64 logo on top, page name truncated below, small "via …" / type label under it.
- Loading overlay on the card being selected (spinner over backdrop-blur).
- "IG" badge in the top-right corner of cards whose page has a linked Instagram.
- Standalone Instagram accounts shown as additional cards in the same grid, visually tagged "IG only" (kept in one unified grid, separated by a thin section label — same dialog, same card style).
- Footer: single "Cancel" outline button (replaces the AlertDialog cancel).

## Logos

`FacebookPage` currently has `{ id, name, has_instagram }` — no picture. Two options for the logo:

1. Use Facebook's public CDN redirect: `https://graph.facebook.com/{page.id}/picture?type=square` (works without a token for public Pages). Fallback to Facebook icon if image fails to load (`onError` → hide img, show icon).
2. Add `picture_url?: string` to the `FacebookPage` type so the backend can later populate it; until then, option 1 fills the gap.

Plan: do both — add the optional `picture_url` field for future backend use, and use the Graph URL as the runtime source when `picture_url` is absent. Standalone Instagram cards already have `profile_picture_url`.

## Files changed

- `src/components/profiles/PageSelectionDialog.tsx` — full rewrite of the dialog body to use `Dialog` + card grid mirroring `InstagramSelectionDialog`. Same props kept (`open`, `onOpenChange`, `pages`, `standaloneInstagram`, `pageSearchQuery`, `onPageSearchChange`, `onSelectPage`, `onSelectStandaloneInstagram`, `selectingPage`) — no caller changes needed.
- `src/hooks/oauth/useFacebookOAuth.ts` — add optional `picture_url?: string` to the `FacebookPage` interface. No behavior change.

No other callers, hooks, edge functions, SQL, env, or n8n touched.

## Out of scope

- No backend change to actually populate `picture_url` from the Facebook Graph API (frontend uses the public picture URL directly).
- No changes to the IG selection dialog itself.
- No changes to OAuth flow, scopes, or state machine.

## Validation

- Visual check on `/profiles` → connect Facebook → dialog appears as a card grid with logos.
- Search filters both FB Pages and standalone IG cards.
- Selecting a card shows spinner overlay on that card and disables others.
- Cancel closes the dialog and resets search.

## Final report fields

- Files changed: 2 frontend files above.
- Database changes: none.
- Env changes: none.
- Deployment notes: standard frontend deploy only.
- Final status: `completed`.
