## Restyle Facebook Page selection dialog to match uploaded reference

Update `src/components/profiles/PageSelectionDialog.tsx` only — frontend/presentation change, no backend/OAuth/data changes.

### Visual changes to match reference

**Header (centered, like reference):**
- Title: `Configure Your Channel` (centered)
- Description: `Select the Facebook page or account you want to connect.` (centered)
- Small left-aligned label above the grid: `Select Page:`

**Grid cards (clone reference style):**
- 3 columns (`grid-cols-3`), generous gap (`gap-6`)
- Each card = just a large rounded-square logo + page name underneath
  - Remove the bordered/aspect-square card box, hover ring background, "Facebook Page" subtitle, and outer card padding
  - Logo: ~96px square, `rounded-2xl`, object-cover, subtle hover scale/opacity transition
  - Name: centered, small font, below logo (truncate/wrap to 2 lines)
- Keep "IG" badge in the top-right corner of the logo for pages with `has_instagram`
- Keep loading spinner overlay on the logo while `selectingPage === page.id`
- Keep image fallback (Facebook icon on error / no picture_url)

**Search input:** keep, but visually lighter (small, above the grid) — matches the same dialog family

**Standalone Instagram section:** keep below FB pages, same card style, IG icon fallback, "IG" badge

**Footer:** keep single `Cancel` outline button

**Dialog container:**
- `sm:max-w-2xl`, dark-friendly (already using semantic tokens)
- Centered header alignment via `text-center` on `DialogHeader`

### Out of scope
- No changes to `useFacebookOAuth.ts`, OAuth flow, edge functions, SQL, env, or n8n
- No changes to `InstagramSelectionDialog.tsx` (kept as the structural sibling)
- Logos still pulled from `page.picture_url` with fallback to `https://graph.facebook.com/${page.id}/picture?type=square`

### Final status
`completed` (documentation/UI-only restyle, ready for visual review in preview)
