/** Evaluated after user-first composition and its cap. Recovery must be an
 * explicitly configured platform API tier; a prepended user key is not consent. */
export function hasLaterAgentApiTier<T extends { credentialSource: string; authMethod?: string }>(chain: readonly T[], index: number, ready: (tier: T) => boolean): boolean {
  return chain.slice(index + 1).some(tier => tier.credentialSource === "platform" && tier.authMethod !== "oauth" && ready(tier));
}

export function supportsAgentApiTools(model: { capabilities: string[]; metadata?: Record<string, unknown> | null }): boolean {
  const parameters = model.metadata?.supported_parameters;
  return model.capabilities.includes("chat") && (model.capabilities.includes("tools") || model.metadata?.tool_calling === true ||
    (Array.isArray(parameters) && parameters.includes("tools")));
}
