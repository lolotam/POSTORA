export function describeImageFailure(errMsg: string): { code: string; message: string } {
  const lower = errMsg.toLowerCase();
  let error_code = 'ai_error';
  // Default: surface the real internal error so admins can debug instead of
  // a generic "temporarily unavailable" message.
  let message = `Image generation failed: ${errMsg}`;

  if (lower.includes('all image providers failed') || lower.includes('missing ')) {
    error_code = 'ai_not_configured';
    message = `Image generation is not configured. Set the provider API key (e.g. OPENAI_API_KEY or GOOGLE_AI_STUDIO_KEY) for the model selected in admin settings. ${errMsg}`;
  } else if (lower.includes('unsupported provider')) {
    error_code = 'ai_provider_unsupported';
    message = `The configured image provider is not supported by this function. ${errMsg}`;
  } else if (lower.includes('credits')) {
    error_code = 'ai_credits_exhausted';
    message = 'AI credits exhausted. Please add credits to continue.';
  } else if (lower.includes('rate limit')) {
    error_code = 'ai_rate_limited';
    message = 'Too many requests. Please wait a moment and try again.';
  } else if (lower.includes('did not return an image') || lower.includes('no image')) {
    error_code = 'ai_no_image';
    // keep detailed errMsg so user/admin sees model + provider reason
    message = `The model could not generate an image. ${errMsg}`;
  } else if (lower.includes('empty response')) {
    error_code = 'ai_gateway_empty';
    message = `The AI gateway returned an empty response. ${errMsg}`;
  } else if (lower.includes('gateway') || lower.includes('google api')) {
    error_code = 'ai_gateway_error';
    message = `AI provider error: ${errMsg}`;
  }
  return { code: error_code, message };
}
