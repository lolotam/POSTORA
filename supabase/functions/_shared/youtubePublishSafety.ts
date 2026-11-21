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
  metadata: object | null | undefined,
): YoutubeDeclarationKey[] {
  const values = (metadata ?? {}) as Record<string, unknown>;
  return YOUTUBE_REQUIRED_DECLARATIONS.filter(
    (key) => typeof values[key] !== "boolean",
  );
}

export function youtubeUploadPrivacy(
  metadata: object | null | undefined,
): YoutubePrivacyStatus {
  const value = (metadata as Record<string, unknown> | null | undefined)?.youtube_visibility;
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
export function assertComposioYoutubeDeclarations(
  _metadata: object | null | undefined,
): void {
  throw new YoutubeComposioDispatchUnavailableError();
}
