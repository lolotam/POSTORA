# Scheduled Posts — Media Previews, Lightbox, Caption Hover

Today each scheduled post card only shows a tiny "image-icon + count" badge. We'll replace that with an actual media thumbnail strip and add a lightbox + caption hover.

Scope: `/scheduled` UI only. No DB, no edge functions, no business logic.

## Changes

### 1. New component `src/components/scheduled/ScheduledPostMedia.tsx`
A small, reusable thumbnail strip that:
- Accepts `mediaFileIds: string[]`.
- Loads media rows from `media_files` (id, file_path, file_type, mime_type, storage_bucket) and resolves URLs the same way `History.tsx` already does:
  - `storage_bucket === "cloudinary"` → use `file_path` directly.
  - otherwise → `supabase.storage.from(bucket).createSignedUrl(file_path, 3600)`.
  - Cached per id in a small in-memory `Map` so revisiting cards doesn't re-sign.
- Renders thumbnails inline next to each other:
  - 1 item → single 1:1 thumb, ~`w-28 h-28` (≈112px), `object-cover`, rounded.
  - 2–4 items → horizontal flex row of `w-20 h-20` (80px) 1:1 tiles. Videos show a play-icon overlay and use `<video preload="metadata">` (poster frame) so the still appears at correct aspect.
  - >4 items → first 4 tiles + a final `+N` tile.
- Each tile preserves the underlying aspect via `object-cover` inside a fixed-ratio square box (so portrait/landscape/video all "fit the correct aspect ratio" within the placeholder tile).
- Hover state on a tile shows a translucent overlay with a `Maximize2` icon and tooltip text "View larger". Clicking opens the lightbox at that index.
- Skeleton tile shown while signed URLs resolve; broken-image fallback shows a muted `Image`/`Video` icon.

### 2. New component `src/components/scheduled/MediaLightboxDialog.tsx`
- shadcn `Dialog` with a large content area (`max-w-4xl`), dark backdrop.
- Shows the selected media large:
  - Image → `<img>` with `max-h-[80vh] object-contain`.
  - Video → `<video controls autoPlay playsInline>` with `max-h-[80vh] object-contain`. Clicking the thumbnail (point 2b) opens here and auto-plays.
- Prev/Next arrows when multiple items; index indicator (`2 / 5`).
- Close on Esc / backdrop click (Dialog default).

### 3. `src/pages/ScheduledPosts.tsx` edits
- Replace the existing tiny `<Image /> + count` line (around lines 770–775) with `<ScheduledPostMedia mediaFileIds={post.media_file_ids ?? []} onOpenLightbox={...} />`, placed above the schedule-info block so it's prominent.
- Keep the `Image` count chip but move it into the new component's header ("3 media").
- Wrap the caption `<p>` (lines 717–721) in a shadcn `Tooltip` (TooltipProvider already used elsewhere) — the existing `line-clamp-3` preview remains visible, hovering shows the full caption in a `TooltipContent` with `max-w-md whitespace-pre-wrap`. Also make the `<p>` `cursor-pointer` and on click open the existing edit dialog's read mode — actually simpler: clicking the caption also opens the tooltip-equivalent in a small `Popover` so touch users can tap. Implementation: use a `HoverCard` (shadcn) — opens on hover AND click, perfect for this.
- Lightbox state (`{ urls, index } | null`) lives in the page; opened from `ScheduledPostMedia` callbacks.

### 4. Dark mode / theming
- All new elements use semantic tokens (`bg-card`, `border-border/60`, `text-muted-foreground`, `bg-background/80` overlays). No hardcoded white/black.

## Out of scope
- No changes to media upload, post schema, OAuth, edge functions, n8n, or the History/Calendar pages.
- No new SQL.

## Files
- New: `src/components/scheduled/ScheduledPostMedia.tsx`
- New: `src/components/scheduled/MediaLightboxDialog.tsx`
- Edited: `src/pages/ScheduledPosts.tsx` (caption HoverCard, replace count chip with media strip, lightbox state)

Final status: ready to implement on approval.
