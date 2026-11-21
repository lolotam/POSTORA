/**
 * Browser mirror of the declaration rules the worker enforces before a
 * YouTube upload. The worker's copy under `supabase/functions/_shared` is
 * authoritative; this one exists so the form can refuse the same things
 * before it writes a post. `youtubePublishingContract.test.ts` keeps them
 * aligned.
 */

export const YOUTUBE_REQUIRED_DECLARATIONS = [
  "youtube_made_for_kids",
  "youtube_contains_synthetic_media",
] as const;

export type YoutubeDeclarationKey = (typeof YOUTUBE_REQUIRED_DECLARATIONS)[number];

export function missingYoutubeDeclarations(
  metadata: Record<string, unknown> | null | undefined,
): YoutubeDeclarationKey[] {
  return YOUTUBE_REQUIRED_DECLARATIONS.filter(
    (key) => typeof metadata?.[key] !== "boolean",
  );
}

