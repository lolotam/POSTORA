/**
 * Browser mirror of the declaration rules the worker enforces before a
 * YouTube upload. The worker's copy under `supabase/functions/_shared` is
 * authoritative; this one lets the form write the same versioned proof.
 * `youtubePublishingContract.test.ts` keeps them aligned.
 */

export const YOUTUBE_REQUIRED_DECLARATIONS = [
  "youtube_made_for_kids",
  "youtube_contains_synthetic_media",
] as const;

export type YoutubeDeclarationKey = (typeof YOUTUBE_REQUIRED_DECLARATIONS)[number];

export const YOUTUBE_DECLARATION_PROOF_VERSION = 3 as const;

export interface YoutubeDeclarationProof {
  version: number;
  made_for_kids: boolean;
  contains_synthetic_media: boolean;
  source: "form" | "rest" | "mcp";
}

export function buildYoutubeDeclarationProof(
  metadata: Record<string, unknown> | null | undefined,
  source: YoutubeDeclarationProof["source"],
): YoutubeDeclarationProof | null {
  const madeForKids = metadata?.youtube_made_for_kids;
  const synthetic = metadata?.youtube_contains_synthetic_media;
  if (typeof madeForKids !== "boolean" || typeof synthetic !== "boolean") return null;
  return {
    version: YOUTUBE_DECLARATION_PROOF_VERSION,
    made_for_kids: madeForKids,
    contains_synthetic_media: synthetic,
    source,
  };
}

export function missingYoutubeDeclarations(
  metadata: Record<string, unknown> | null | undefined,
): YoutubeDeclarationKey[] {
  const proof = metadata?.youtube_declaration_proof as YoutubeDeclarationProof | undefined;
  const valid = proof?.version === YOUTUBE_DECLARATION_PROOF_VERSION &&
    (proof.source === "form" || proof.source === "rest" || proof.source === "mcp") &&
    typeof proof.made_for_kids === "boolean" &&
    typeof proof.contains_synthetic_media === "boolean" &&
    metadata?.youtube_made_for_kids === proof.made_for_kids &&
    metadata?.youtube_contains_synthetic_media === proof.contains_synthetic_media;
  if (!valid) return [...YOUTUBE_REQUIRED_DECLARATIONS];
  return YOUTUBE_REQUIRED_DECLARATIONS.filter(
    (key) => typeof metadata?.[key] !== "boolean",
  );
}
