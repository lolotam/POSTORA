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

/** Reads a proof only when its version, source and values are all intact. */
export function youtubeDeclarationProofOf(
  metadata: Record<string, unknown> | null | undefined,
): YoutubeDeclarationProof | null {
  const proof = metadata?.youtube_declaration_proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return null;
  const candidate = proof as Partial<YoutubeDeclarationProof>;
  if (candidate.version !== YOUTUBE_DECLARATION_PROOF_VERSION) return null;
  if (candidate.source !== "form" && candidate.source !== "rest" && candidate.source !== "mcp") return null;
  if (typeof candidate.made_for_kids !== "boolean" || typeof candidate.contains_synthetic_media !== "boolean") return null;
  if (metadata?.youtube_made_for_kids !== candidate.made_for_kids) return null;
  if (metadata?.youtube_contains_synthetic_media !== candidate.contains_synthetic_media) return null;
  return candidate as YoutubeDeclarationProof;
}

export function missingYoutubeDeclarations(
  metadata: Record<string, unknown> | null | undefined,
): YoutubeDeclarationKey[] {
  if (!youtubeDeclarationProofOf(metadata)) return [...YOUTUBE_REQUIRED_DECLARATIONS];
  return YOUTUBE_REQUIRED_DECLARATIONS.filter(
    (key) => typeof metadata?.[key] !== "boolean",
  );
}
