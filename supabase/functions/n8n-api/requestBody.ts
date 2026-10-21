// Reading and parsing a request body for the n8n API.
//
// The body is the one part of a request the caller fully controls, so a
// truncated or malformed JSON payload is a client error, not a server fault.
// JSON parsing lives here rather than in the router so every route reports the
// same typed error instead of each one failing differently.

export const INVALID_JSON_MESSAGE = 'The request body is not valid JSON.';

/** Raised when a request body is not valid JSON. The router maps this error to
 *  a 400 INVALID_REQUEST response that still carries the rate-limit headers. */
export class InvalidRequestBodyError extends Error {
  constructor() {
    super(INVALID_JSON_MESSAGE);
    this.name = 'InvalidRequestBodyError';
  }
}

/** Parses JSON text, reporting a malformed body as {@link InvalidRequestBodyError}
 *  instead of the raw SyntaxError, so the router can tell the two apart. */
export function parseJsonText(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidRequestBodyError();
  }
}

/** Reads the body once and parses it as JSON. The text is read rather than
 *  `request.json()` so a body that turns out to be malformed is still read
 *  exactly once and never leaves the caller half-consumed. */
export async function readJsonBody(request: Request): Promise<any> {
  return parseJsonText(await request.text());
}

/** True when the text looks like a JSON object or array. Used to choose between
 *  a JSON body and a form body when the client sent no content-type. */
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}
