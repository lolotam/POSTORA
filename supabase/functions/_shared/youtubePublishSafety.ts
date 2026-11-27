/**
 * The two declarations Postora requires before a YouTube upload reaches a
 * provider, and the privacy rule for uploads that omit visibility.
 *
 * A checkbox that was never touched is not a declaration: an absent value must
 * never be serialized as an implicit `false`, and a queued post written before
 * this rule existed must not be published on that assumption either.
 */

import {
  effectiveYoutubePrivacy,
  type YoutubePrivacyStatus,
} from "./youtubePublishOptions.ts";

export const YOUTUBE_REQUIRED_DECLARATIONS = [
  "youtube_made_for_kids",
  "youtube_contains_synthetic_media",
] as const;

export type YoutubeDeclarationKey = (typeof YOUTUBE_REQUIRED_DECLARATIONS)[number];

/**
 * Only this version of the declaration proof is accepted. A stored boolean
 * without a matching proof is a legacy default, not an answer: the caller
 * cannot satisfy D3 by omitting the proof or by relying on an old `false`.
 */
export const YOUTUBE_DECLARATION_PROOF_VERSION = 3 as const;

export interface YoutubeDeclarationProof {
  version: number;
  made_for_kids: boolean;
  contains_synthetic_media: boolean;
  source: "form" | "rest" | "mcp";
}

const PROOF_KEYS: Record<YoutubeDeclarationKey, keyof YoutubeDeclarationProof> = {
  youtube_made_for_kids: "made_for_kids",
  youtube_contains_synthetic_media: "contains_synthetic_media",
};

/** Reads a proof only when its version, values and source are all intact. */
export function youtubeDeclarationProofOf(
  metadata: object | null | undefined,
): YoutubeDeclarationProof | null {
  const values = (metadata ?? {}) as Record<string, unknown>;
  const proof = values.youtube_declaration_proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return null;
  const candidate = proof as Record<string, unknown>;
  if (candidate.version !== YOUTUBE_DECLARATION_PROOF_VERSION) return null;
  if (candidate.source !== "form" && candidate.source !== "rest" && candidate.source !== "mcp") {
    return null;
  }
  for (const key of YOUTUBE_REQUIRED_DECLARATIONS) {
    if (typeof candidate[PROOF_KEYS[key]] !== "boolean") return null;
    if (values[key] !== candidate[PROOF_KEYS[key]]) return null;
  }
  return candidate as unknown as YoutubeDeclarationProof;
}

export function missingYoutubeDeclarations(
  metadata: object | null | undefined,
): YoutubeDeclarationKey[] {
  const proof = youtubeDeclarationProofOf(metadata);
  const values = (metadata ?? {}) as Record<string, unknown>;
  if (!proof) return [...YOUTUBE_REQUIRED_DECLARATIONS];
  return YOUTUBE_REQUIRED_DECLARATIONS.filter((key) => typeof values[key] !== "boolean");
}

/** Builds the proof an ingress writes only when both answers are explicit. */
export function buildYoutubeDeclarationProof(
  metadata: object | null | undefined,
  source: YoutubeDeclarationProof["source"],
): YoutubeDeclarationProof | null {
  const values = (metadata ?? {}) as Record<string, unknown>;
  const madeForKids = values.youtube_made_for_kids;
  const synthetic = values.youtube_contains_synthetic_media;
  if (typeof madeForKids !== "boolean" || typeof synthetic !== "boolean") return null;
  return {
    version: YOUTUBE_DECLARATION_PROOF_VERSION,
    made_for_kids: madeForKids,
    contains_synthetic_media: synthetic,
    source,
  };
}

export function youtubeUploadPrivacy(
  metadata: object | null | undefined,
): YoutubePrivacyStatus {
  return effectiveYoutubePrivacy(metadata);
}

export class YoutubeDeclarationRequiredError extends Error {
  readonly code = "youtube_declaration_required";

  constructor(readonly missing: readonly YoutubeDeclarationKey[]) {
    super(
      "Choose Yes or No for the audience and synthetic-media declarations before publishing to YouTube.",
    );
    this.name = "YoutubeDeclarationRequiredError";
  }
}

export class YoutubeProviderDeclarationUnsupportedError extends Error {
  readonly code = "youtube_provider_declaration_unsupported";

  constructor(readonly declarations: readonly YoutubeDeclarationKey[]) {
    super("The selected YouTube provider cannot apply the declarations this upload requires.");
    this.name = "YoutubeProviderDeclarationUnsupportedError";
  }
}

/**
 * A managed provider may not dispatch a YouTube upload at all until BOTH the
 * declaration contract and the pre-execute durability contract are proven.
 * An explicit "No / No" is still a declaration: the provider cannot send it,
 * so it is not a reason to allow the dispatch.
 */
export class YoutubeComposioDispatchUnavailableError extends Error {
  readonly code = "youtube_composio_dispatch_unavailable";

  constructor() {
    super(
      "Managed YouTube publishing is disabled until the provider can send the required declarations and a durable, exactly-once pre-execute receipt is proven.",
    );
    this.name = "YoutubeComposioDispatchUnavailableError";
  }
}

/** Native dispatch fence: an implicit default is never a declaration. */
export function assertNativeYoutubeDeclarations(
  metadata: object | null | undefined,
): void {
  const missing = missingYoutubeDeclarations(metadata);
  if (missing.length > 0) throw new YoutubeDeclarationRequiredError(missing);
}

/**
 * Managed dispatch fence. This is unconditional: the provider cannot send
 * either mandatory declaration (yes or no), and the exactly-once pre-execute
 * receipt is not proven. Every managed post -- including a queued post that
 * already carries explicit No/No -- is refused before any provider work.
 */
export function assertComposioYoutubeDeclarations(): void {
  throw new YoutubeComposioDispatchUnavailableError();
}
