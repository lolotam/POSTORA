## Goal

Restyle the platform tabs in `src/pages/Profiles.tsx` so each tab shows only the platform logo and the account count badge (no platform name), with a hover tooltip revealing the name, and fix the unreadable count badge in dark mode.

## Changes (single file: `src/pages/Profiles.tsx`)

Tab trigger (lines ~236–256):

1. **Remove the platform name text** (`{config.name}`).
2. **Bigger logo**: change `<PlatformIcon size="sm" />` → `size="lg"`.
3. **Compact button sizing**: tighten the trigger to fit just the icon + badge — e.g. `px-3 py-2.5 gap-2` (no extra horizontal space from the removed label). Keep rounded-xl, border, hover-lift, and active-gradient styling.
4. **Hover tooltip with platform name**: wrap each `TabsTrigger` with `Tooltip`/`TooltipTrigger asChild`/`TooltipContent` from `@/components/ui/tooltip`, content = `getPlatformName(config.platform)` (or `config.name`). Add one `TooltipProvider` around the `TabsList`.
5. **Fix dark-mode count badge contrast**: the active-state class currently uses `group-data-[state=active]:bg-white/90 group-data-[state=active]:text-foreground`. In dark mode `text-foreground` is white → invisible on white bg. Replace with an explicit dark color so the number stays readable on the white badge in both themes:
   - Active + has accounts: `bg-white text-slate-900` (or `text-black`) instead of `text-foreground`.
   - Keep inactive states unchanged.
6. Keep the Beta badge positioning unchanged (still centered above the trigger).

## Out of scope

- No changes to OAuth flows, hooks, edge functions, SQL, env, n8n, or any other file.
- `PageSelectionDialog` and `InstagramSelectionDialog` are not touched.

## Final status

`completed` — UI-only restyle in a single file.
