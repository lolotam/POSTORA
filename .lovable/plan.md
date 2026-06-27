# LinkedIn multi-destination posting + 3D platform chips

## 1. LinkedIn: select personal profile + multiple Pages

Today the LinkedIn settings let you pick exactly **one** destination from a dropdown (personal OR one page). The publisher (`process-post`) currently always posts to the personal `urn:li:person:*` and silently ignores `linkedin_page_id`. Both layers need to change.

### Frontend — `src/components/post/settings/LinkedInSettings.tsx`

Replace the single-select with a multi-select dropdown:

- New prop shape: `selectedDestinationIds: string[]` + `setSelectedDestinationIds: (ids: string[]) => void` (replaces `selectedPageId` / `setSelectedPageId`). Destination IDs: `"personal"` for the user's profile, page id string for each Page.
- Trigger button (custom, not raw `Select`) shows: "Personal Profile" if only personal; "Personal Profile + N Pages" if more; "3 destinations" once it overflows. Chevron + click opens a popover.
- Popover content: checkbox row per destination (Personal Profile always first, then each page from `availablePages` with avatar + name + vanityName). Header row "Select all" / "Clear". Empty state when no pages: "No LinkedIn Pages found. Reconnect this account with `w_organization_social` to manage pages."
- Behavior: must always have ≥1 destination selected; if user unchecks the last one, force-select `personal` and show inline hint "At least one destination is required".
- Keep the existing "Posting to LinkedIn as:" account chip row above — unchanged.

### Frontend — selected destinations stack under the LinkedIn logo

`src/components/post/PlatformSettingsSection.tsx`, the LinkedIn `TabsTrigger` (lines 199–204) currently shows just the LinkedIn icon + label. Wrap it so that when the LinkedIn tab is active **and** destinations are selected, a vertical stack of mini avatars renders directly under the chip:

```
[ in ]   ← LinkedIn chip (existing)
 (●)     ← personal avatar (24px)
 (●)     ← page1 logo
 (●)     ← page2 logo  (max 4 shown, then "+N")
```

Implementation: render a small absolutely-positioned/flow column beneath the chip (`absolute top-full left-1/2 -translate-x-1/2 mt-1 flex flex-col items-center gap-1`). Each avatar is 20–24px, ring-2 ring-background, with `title=` tooltip for the destination name. Capped at 4, overflow shown as `+N` chip. Pull data from the same `connectedAccounts` + `selectedDestinationIds` source already in `PlatformSettingsSection`.

### State + persistence — `src/hooks/usePlatformSettings.tsx`

- Rename `linkedinSelectedPageId: string` (default `"personal"`) → `linkedinSelectedDestinationIds: string[]` (default `["personal"]`). Update both exports (line 142 and the return object around line 742).
- In the metadata-builder around line 528, replace `linkedin_page_id` with:

  ```ts
  linkedin_destination_ids: selectedPlatforms.includes("linkedin")
    ? linkedinSelectedDestinationIds
    : null,
  // back-compat shim so older edge function deploys keep working
  linkedin_page_id: linkedinSelectedDestinationIds.find(id => id !== "personal") ?? null,
  ```

- All call sites flagged earlier (`PlatformSettingsSection.tsx` line 535–536, `n8n/PlatformSettingsCards.tsx` line 83 reference) updated to the new field name. `n8n-api` schema gets the new `linkedin_destination_ids: string[]` parameter alongside the legacy `linkedin_page_id` for one release.

### Backend — `supabase/functions/process-post/index.ts` (`postToLinkedIn`, line 4524)

- Read `metadata?.linkedin_destination_ids` (fallback to `["personal"]`, plus legacy `metadata?.linkedin_page_id` mapped into the array).
- Resolve each ID to a LinkedIn actor URN:
  - `"personal"` → `urn:li:person:${account.platform_user_id}` (current behavior)
  - page id → `urn:li:organization:${pageId}`
  - For organization URNs, swap `MemberNetworkVisibility` for `com.linkedin.ugc.MemberNetworkVisibility: "PUBLIC"` (orgs cannot use CONNECTIONS).
- Loop over actors, calling `POST /v2/ugcPosts` once per destination. Return a `PlatformPostResult` whose `platform_post_id` / `url` is the first success and whose `response_data` carries an array `destinations: [{ destination_id, urn, post_id, url, status, error? }]`. If at least one succeeds, mark overall success; if all fail, return failure with concatenated error.
- Asset registration (`/v2/assets?action=registerUpload`) currently uses `personUrn` as `owner` — for organization posts, owner must be the org URN. The simplest fix: register the asset once **per actor** (LinkedIn requires owner-matched asset URNs). For a first pass acceptable trade-off: register the asset once with the **personal** URN if personal is selected, otherwise with the first org; the same returned asset URN reused across all actors is rejected by LinkedIn, so we'll do per-actor registration to be safe. Document this in code comments.
- Manual deploy required afterward per `docs/runbooks/deploy-edge-function.md` for `process-post`.

### Out of scope (called out so we don't pretend otherwise)

- Scheduled-post path uses the same `process-post` so it inherits the fix.
- LinkedIn Article (`linkedin_article_link`) flow already branches separately; same per-actor loop applies.
- No DB migration — destinations live in `posts.metadata` JSONB.

---

## 2. 3D, named, professional platform chips

Replace the flat `TabsTrigger` chips (lines 174–235 of `PlatformSettingsSection.tsx`) with a single reusable component so all eleven platforms share styling.

### New component — `src/components/post/PlatformChip.tsx`

Props: `platform: Platform`, `value: string`, optional `children` (for the LinkedIn destination stack). Renders a `TabsTrigger` styled as:

- **Shape**: 64×64 (sm: 72×72) rounded-2xl, brand-color background gradient (`bg-gradient-to-br from-{brand} to-{brand-dark}` driven from existing `platformColors` map in `PlatformIcon.tsx`).
- **3D depth**: layered shadows + highlight, all token-based:
  - top inner highlight: `before:absolute before:inset-x-2 before:top-1 before:h-1/3 before:rounded-t-xl before:bg-white/25 before:blur-sm`
  - bottom inset shadow: `after:absolute after:inset-x-3 after:bottom-1 after:h-1 after:rounded-full after:bg-black/30 after:blur-md`
  - outer drop: `shadow-[0_8px_20px_-6px_hsl(var(--foreground)/0.35)]`
  - hover lifts 2px: `hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-8px_hsl(var(--foreground)/0.45)]`
  - active (selected) ring: `data-[state=active]:ring-2 data-[state=active]:ring-primary data-[state=active]:scale-105`
- **Icon**: existing `<PlatformIcon size="lg" />`, forced to `text-white` since the brand background guarantees contrast. Add a subtle `drop-shadow-sm` so the glyph reads as raised.
- **Label**: full platform name from `getPlatformName(platform)` rendered **outside** the chip, directly below in `text-xs font-medium text-foreground` — this fixes the "Linke..." truncation visible in the screenshot. Chip itself stays icon-only.

### Design-system additions — `src/index.css`

No hardcoded hexes in JSX. Add tokens per brand pair so dark mode is honored, e.g.:

```css
--brand-linkedin: 210 90% 40%;
--brand-linkedin-dark: 210 90% 28%;
/* + facebook / instagram / tiktok / twitter / youtube / pinterest / threads / bluesky / reddit / whatsapp */
```

`tailwind.config.ts`: extend `colors.brand.{platform}` to map to these vars so `from-brand-linkedin to-brand-linkedin-dark` works. Instagram uses a 3-stop gradient (purple → pink → orange) — handled as an inline class override inside `PlatformChip` for that one platform.

### Wire-up

`PlatformSettingsSection.tsx` lines 174–235 collapse to ~12 lines:

```tsx
<TabsList className="flex flex-wrap justify-center gap-3 h-auto p-2 bg-transparent">
  {visiblePlatforms.map((p) => (
    <PlatformChip key={p} platform={p} value={p}>
      {p === "linkedin" && <LinkedInDestinationStack ids={linkedinSelectedDestinationIds} />}
    </PlatformChip>
  ))}
</TabsList>
```

`visiblePlatforms` is computed once via the existing `isPlatformEligible / isPlatformVisible / hasPlatformSelected / uploadMethod` filters.

---

## Files

- New: `src/components/post/PlatformChip.tsx`
- New: `src/components/post/LinkedInDestinationStack.tsx` (mini-avatar column rendered under the LinkedIn chip)
- Edited: `src/components/post/settings/LinkedInSettings.tsx` — single-select → multi-select popover
- Edited: `src/components/post/PlatformSettingsSection.tsx` — chip list replacement, LinkedIn destination wiring
- Edited: `src/hooks/usePlatformSettings.tsx` — `linkedinSelectedDestinationIds` state + metadata field
- Edited: `src/components/n8n/PlatformSettingsCards.tsx` — add `linkedin_destination_ids` parameter row, keep `linkedin_page_id` row marked deprecated
- Edited: `src/index.css` + `tailwind.config.ts` — brand color tokens for the 3D chips
- Edited: `supabase/functions/process-post/index.ts` — multi-actor fan-out in `postToLinkedIn`

## Database changes

None. Destinations live in `posts.metadata` JSONB.

## Env changes

None.

## Deployment notes (self-hosted Supabase)

After this lands, sync `supabase/functions/process-post/` to the functions volume and restart the functions container per `docs/runbooks/deploy-edge-function.md`. Until that runs, the new field reaches the function but the legacy `linkedin_page_id` shim still posts to a single destination (personal or first page).

## Validation

- Open `/post`, select a LinkedIn account, open Platform-specific settings → LinkedIn tab. Verify multi-select popover, "Select all", forced-personal fallback.
- Verify destination avatars stack vertically under the LinkedIn chip and that long platform names (LinkedIn, Pinterest, Instagram) no longer truncate.
- Visual check on all 11 platform chips: brand-colored, 3D shadow/highlight, full label beneath, hover lift, selected scale + ring.
- After backend redeploy, post a test message to personal + one page; confirm two posts appear and `platform_posts.response_data.destinations` records both URNs.

## Guard review

CleanCodeGuard pass after implementation (no hex literals in JSX, no duplicated chip JSX, no broad catches in the LinkedIn loop — failures per actor return structured per-destination errors, never silently swallowed).

## Security

No new secrets, no new RLS. Backend continues to use the existing access token on the `social_account` row; organization URNs only succeed if the token has `w_organization_social` scope (already required for the LinkedIn integration).

## Remaining manual actions

1. Sync + restart functions container for `process-post`.
2. Smoke test: create a post selecting personal + a Page; confirm both publish.

## Final status

`completed_requires_manual_redeploy` (frontend will deploy automatically via Dokploy; `process-post` needs the runbook).
