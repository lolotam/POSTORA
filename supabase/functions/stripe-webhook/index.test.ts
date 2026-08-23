import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// These are integration tests: they fetch() a deployed stripe-webhook function and
// require SUPABASE_URL/SUPABASE_ANON_KEY to point at a real, deployed environment.
// Locally these env vars are unset, which previously produced the literal string
// "undefined/functions/v1/stripe-webhook" and threw `TypeError: Invalid URL` for
// every test in this file. Skip cleanly (via Deno.test's `ignore`) only when the
// env vars are absent/empty — do NOT skip on an assertion failure. When the env
// vars ARE set (e.g. in a deploy-verification run), these tests run exactly as
// before with no weakened assertions.
// DO NOT remove this guard "to fix" the tests — see supabase/functions/stripe-webhook/index.test.ts history.
const RAW_SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const RAW_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SKIP_INTEGRATION_TESTS = !RAW_SUPABASE_URL || !RAW_ANON_KEY;

const FUNCTION_URL = `${RAW_SUPABASE_URL ?? ""}/functions/v1/stripe-webhook`;
const ANON_KEY = RAW_ANON_KEY ?? "";

Deno.test({
  name: "stripe-webhook: handles CORS preflight request",
  ignore: SKIP_INTEGRATION_TESTS,
  fn: async () => {
    const response = await fetch(FUNCTION_URL, {
      method: "OPTIONS",
      headers: { apikey: ANON_KEY },
    });

    assertEquals(response.status, 200);
  },
});

Deno.test({
  name: "stripe-webhook: rejects invalid signature",
  ignore: SKIP_INTEGRATION_TESTS,
  fn: async () => {
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        "stripe-signature": "invalid_signature",
      },
      body: JSON.stringify({ id: "evt_test_123", type: "checkout.session.completed" }),
    });

    assertEquals(response.status, 400);
  },
});

Deno.test({
  name: "stripe-webhook: rejects missing signature",
  ignore: SKIP_INTEGRATION_TESTS,
  fn: async () => {
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ id: "evt_test_missing", type: "unknown.event.type" }),
    });

    assertEquals(response.status === 400 || response.status === 401, true);
  },
});

Deno.test({
  name: "stripe-webhook: does not process unsigned unknown events",
  ignore: SKIP_INTEGRATION_TESTS,
  fn: async () => {
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ id: "evt_test_unknown", type: "unknown.event.type" }),
    });

    assertEquals(response.status === 200, false);
  },
});

Deno.test({
  name: "stripe-webhook: rejects unsigned invalid JSON before parsing",
  ignore: SKIP_INTEGRATION_TESTS,
  fn: async () => {
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: "not valid json",
    });

    assertEquals(response.status === 200, false);
  },
});

Deno.test({
  name: "stripe-webhook: does not process unsigned checkout metadata",
  ignore: SKIP_INTEGRATION_TESTS,
  fn: async () => {
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({
        id: "evt_test_no_metadata",
        type: "checkout.session.completed",
        data: { object: { id: "cs_test_no_metadata" } },
      }),
    });

    assertEquals(response.status === 200, false);
  },
});
