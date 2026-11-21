/**
 * The two declarations Postora requires before a YouTube upload reaches a
 * provider, and the privacy rule for uploads that omit visibility.
 *
 * A checkbox that was never touched is not a declaration: an absent value must
 * never be serialized as an implicit `false`, and a queued post written before
 * this rule existed must not be published on that assumption either.
 */

import {
  YOUTUBE_DEFAULT_PRIVACY,
  YOUTUBE_PRIVACY_VALUES,
  type YoutubePrivacyStatus,
} from "./youtubePublishOptions.ts";

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

/** Explicitly requested declarations a managed provider cannot express. */
export function unexpressibleYoutubeDeclarations(
  metadata: Record<string, unknown> | null | undefined,
): YoutubeDeclarationKey[] {
  return YOUTUBE_REQUIRED_DECLARATIONS.filter((key) => metadata?.[key] === true);
}

export function youtubeUploadPrivacy(
  metadata: Record<string, unknown> | null | undefined,
): YoutubePrivacyStatus {
  const value = metadata?.youtube_visibility;
  return YOUTUBE_PRIVACY_VALUES.includes(value as YoutubePrivacyStatus)
    ? (value as YoutubePrivacyStatus)
    : YOUTUBE_DEFAULT_PRIVACY;
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

/** Native dispatch fence: an implicit default is never a declaration. */
export function assertNativeYoutubeDeclarations(
  metadata: Record<string, unknown> | null | undefined,
): void {
  const missing = missingYoutubeDeclarations(metadata);
  if (missing.length > 0) throw new YoutubeDeclarationRequiredError(missing);
}

/**
 * Managed dispatch fence. Missing declarations are refused, and a provider
 * that cannot express an affirmative declaration is incompatible before any
 * bytes or tool calls reach it.
 */
export function assertComposioYoutubeDeclarations(
  metadata: Record<string, unknown> | null | undefined,
): void {
  const missing = missingYoutubeDeclarations(metadata);
  if (missing.length > 0) throw new YoutubeDeclarationRequiredError(missing);
  const unexpressible = unexpressibleYoutubeDeclarations(metadata);
  if (unexpressible.length > 0) {
    throw new YoutubeProviderDeclarationUnsupportedError(unexpressible);
  }
}
