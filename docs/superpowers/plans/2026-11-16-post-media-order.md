# Post media order and next-post action

Owner authorized implementation of numbered media, drag-and-drop publishing order, and inspection of the next-post action. Use the current checkout; do not delegate or touch unrelated dirty work.

## Evidence and design

- `/post` already preserves selection order in `posts.media_file_ids`, but `process-post` consumes an unordered database `IN` result. Editing a saved post repeats that ordering loss.
- Local uploads allocate previews before concurrent uploads and update each item by identity. Keep that behavior.
- Reuse one pure shared ordering function in the worker and edit loader. SQL schema changes and sorting by filename/creation time would not represent the user's requested order.
- Keep the existing dnd-kit implementation, use its wrapping-grid strategy, expose an accessible always-visible drag handle, and number every item from its current array position. No new dependency or feature flag.
- The page clears form content after saving but leaves step 3 selected. Show a saved-post action with History and Create new post. A saved/enqueued post must not be called successfully published. New-post action returns to step 1, clears media/caption/URL/scheduling state, and removes the edit target so a new submission cannot update the previous post.

## Tasks

1. Add failing ordered-media tests in `supabase/functions/_shared/post-media.test.ts`; implement generic identity ordering in `post-media.ts`, call it in `process-post/index.ts` and `src/hooks/usePostForm.tsx`. Preserve missing-file refusal and distinguish read failures.
2. Add UI behavior tests for numbering, keyboard reordering and pending media in `src/components/post/__tests__/MediaUploadArea.test.tsx`. Update `SortableMediaItem.tsx` and `MediaUploadArea.tsx` with current positions, grid sorting and accessible handles. Verify the original selected order is unchanged until an explicit reorder.
3. Add the saved-post action component and tests; wire the reset callback in `CreatePost.tsx` and edit-target clearing in the form hook. Cover the observable fresh draft and new-post identity behavior.
4. Add Arabic translations only in their canonical bundles; English remains call-site defaults. Run focused frontend/Deno tests, typecheck, lint regression, build, code/test guards, and graphify update. Publish a scoped PR for normal CI/review; no customer post/provider send or schema change during tests.

## Conversation assessment

Inspect only the owner's latest scoped conversation after PR434 deployment. Report preservation, response latency and actual cache metrics; do not claim cache savings from distinct reads across separate turns. Model/provider fallback failures are a separate limitation, and current catalog availability must not be called physical pharmacy stock.
