/**
 * Decide which provider (if any) to pass to `runTranscription` for a tier.
 *
 * A provider is only forwarded when the model actually being used for this
 * tier is the one `fetchCategoryAiSettings` configured — not a model that
 * came from an `app_settings` override or (for tier 1) the caller's
 * `requestedModel`. Comparing the resolved model against the settings model
 * captures both override paths without needing separate flags: either
 * override changes `model` away from `settingsModel`, so the comparison
 * fails and no provider is forwarded.
 */
export function sttProviderFor(model: string, settingsModel: string, settingsProvider: string): string | undefined {
  if (model !== settingsModel) return undefined;
  return settingsProvider || undefined;
}
