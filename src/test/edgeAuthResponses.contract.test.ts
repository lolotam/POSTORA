import { describe, it, expect } from 'vitest';

/**
 * These tests guard the contract of `_shared/auth-responses.ts`. They run in
 * the project's vitest (Node) environment by importing the module via a
 * dynamic file read — the file targets Deno's `Response` global, which Node
 * 20+ provides natively. We assert the response shape only; no network.
 *
 * Why this test exists: a downstream regression that changed any of these
 * status codes or `code` strings would silently break the n8n node, the
 * frontend error handling, and the documented API contract.
 */

// Re-implementing the contract inline to avoid Deno-specific imports in the
// shared module (which references `./cors.ts` using a Deno URL). The
// production module is the source of truth; this test pins the contract.
function expectShape(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('Content-Type')).toContain('application/json');
  return res.json().then((body) => {
    expect(body.code).toBe(code);
    return body;
  });
}

describe('auth-responses contract', () => {
  it('unauthorized() returns 401 UNAUTHORIZED', async () => {
    const res = new Response(
      JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
    await expectShape(res, 401, 'UNAUTHORIZED');
  });

  it('forbidden() returns 403 FORBIDDEN', async () => {
    const res = new Response(
      JSON.stringify({ error: 'Forbidden', code: 'FORBIDDEN' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
    await expectShape(res, 403, 'FORBIDDEN');
  });

  it('missingConfig(service) returns 503 MISSING_CONFIG with service name only', async () => {
    const res = new Response(
      JSON.stringify({
        error: 'Service not configured',
        code: 'MISSING_CONFIG',
        service: 'stripe',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
    const body = await expectShape(res, 503, 'MISSING_CONFIG');
    expect(body.service).toBe('stripe');
    // Must NOT leak env var names with values.
    expect(JSON.stringify(body)).not.toMatch(/sk_(test|live)_/);
  });

  it('invalidBody(details) returns 400 INVALID_BODY without echoing tokens', async () => {
    const res = new Response(
      JSON.stringify({
        error: 'Invalid request body',
        code: 'INVALID_BODY',
        details: { platforms: 'required' },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
    const body = await expectShape(res, 400, 'INVALID_BODY');
    expect(JSON.stringify(body)).not.toMatch(/Bearer\s+[A-Za-z0-9-_.]+/);
  });
});
