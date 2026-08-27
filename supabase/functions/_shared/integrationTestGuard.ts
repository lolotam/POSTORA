/**
 * Guard for edge-function integration tests that `fetch()` a *deployed* function.
 *
 * These tests need `SUPABASE_URL` and `SUPABASE_ANON_KEY` to point at a real
 * environment. When those are unset — a plain local run, or CI — the URL builds
 * as the literal string "undefined/functions/v1/..." and every test in the file
 * throws `TypeError: Invalid URL` before reaching a single assertion.
 *
 * Registering them as *ignored* rather than skipping registration keeps them
 * visible in the run summary. A test that silently fails to register reads as
 * green; an ignored one is reported and counted. Do not "fix" a failure here by
 * removing the guard — when the env vars ARE set (a deploy-verification run)
 * these execute exactly as written, with no weakened assertions.
 *
 * Precedent: supabase/functions/stripe-webhook/index.test.ts.
 */

const rawSupabaseUrl = Deno.env.get("SUPABASE_URL");
const rawAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

/** True when the deployed-environment credentials are absent or empty. */
export const skipIntegrationTests = !rawSupabaseUrl || !rawAnonKey;

/** Base URL of the deployed functions host; empty string when unconfigured. */
export const supabaseUrl = rawSupabaseUrl ?? "";

/** Anon key for the deployed environment; empty string when unconfigured. */
export const anonKey = rawAnonKey ?? "";

/** Registers a test that runs only against a configured deployed environment. */
export function integrationTest(
  name: string,
  fn: () => void | Promise<void>,
): void {
  Deno.test({ name, ignore: skipIntegrationTests, fn });
}
