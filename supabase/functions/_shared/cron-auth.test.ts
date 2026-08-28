import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { verifyCronAuth, verifyCronOrAdmin } from "./cron-auth.ts";

const CRON_SECRET = "cron-secret-value-0123456789";
const SERVICE_ROLE_KEY = "service-role-key-abcdefghijklm";

const MANAGED_KEYS = [
  "CRON_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
] as const;

/**
 * Runs `body` with exactly `env` in place — every key this module reads that is
 * absent from `env` is unset, not inherited — then restores the process env.
 * Inheriting a real SUPABASE_URL would let a "fails closed" assertion pass by
 * making a live network call instead.
 */
async function withEnv(
  env: Partial<Record<(typeof MANAGED_KEYS)[number], string>>,
  body: () => void | Promise<void>,
): Promise<void> {
  const saved = MANAGED_KEYS.map((key) => [key, Deno.env.get(key)] as const);
  try {
    for (const key of MANAGED_KEYS) {
      const value = env[key];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://functions.postora.cloud/cleanup-media", {
    method: "POST",
    headers,
  });
}

async function statusAndError(
  result: { ok: true } | { ok: false; response: Response },
): Promise<{ status: number; error: string | null }> {
  if (result.ok) return { status: 200, error: null };
  const body = await result.response.json();
  return { status: result.response.status, error: body.error };
}

Deno.test("verifyCronAuth credential table", async (t) => {
  const configured = {
    CRON_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  };

  const cases: Array<[string, Record<string, string>, number]> = [
    ["cron secret as a Bearer token", { authorization: `Bearer ${CRON_SECRET}` }, 200],
    ["cron secret in x-cron-secret", { "x-cron-secret": CRON_SECRET }, 200],
    ["capitalised Authorization header", { Authorization: `Bearer ${CRON_SECRET}` }, 200],
    ["service-role key as a Bearer token", { authorization: `Bearer ${SERVICE_ROLE_KEY}` }, 200],
    // The service-role key authenticates only on the Bearer path. Accepting it
    // through x-cron-secret would widen a header meant solely for the shared
    // cron secret, so this must stay a rejection.
    ["service-role key in x-cron-secret", { "x-cron-secret": SERVICE_ROLE_KEY }, 401],
    // Guards the constant-time compare against a regression to startsWith or a
    // truncating comparison.
    ["a prefix of the cron secret", { authorization: `Bearer ${CRON_SECRET.slice(0, 10)}` }, 401],
    ["a same-length near miss", { authorization: `Bearer ${CRON_SECRET.slice(0, -1)}X` }, 401],
    ["no credentials at all", {}, 401],
    ["a non-Bearer scheme carrying the secret", { authorization: `Basic ${CRON_SECRET}` }, 401],
  ];

  for (const [label, headers, expectedStatus] of cases) {
    await t.step(label, async () => {
      await withEnv(configured, async () => {
        const { status } = await statusAndError(verifyCronAuth(requestWith(headers)));
        assertEquals(status, expectedStatus);
      });
    });
  }
});

// Regression: on 2026-08-24 CRON_SECRET was written into Dokploy with a colon
// instead of `=`, so the variable never reached the container and every cron
// function answered 503. The fail-closed behaviour is the correct one; this
// test exists so a future refactor cannot quietly turn it into a 200.
Deno.test("verifyCronAuth fails closed when CRON_SECRET is unset", async () => {
  await withEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY }, async () => {
    const { status, error } = await statusAndError(
      verifyCronAuth(requestWith({ authorization: `Bearer ${SERVICE_ROLE_KEY}` })),
    );
    assertEquals(status, 503);
    assertEquals(error, "CRON_SECRET not configured");
  });
});

Deno.test("verifyCronOrAdmin accepts the cron secret without consulting auth", async () => {
  // SUPABASE_URL and SUPABASE_ANON_KEY are deliberately absent: if the cron
  // path did not short-circuit, the admin lookup would run and this would fail.
  await withEnv({ CRON_SECRET }, async () => {
    const { status } = await statusAndError(
      await verifyCronOrAdmin(requestWith({ "x-cron-secret": CRON_SECRET })),
    );
    assertEquals(status, 200);
  });
});

Deno.test("verifyCronOrAdmin rejects a bearer it cannot verify as an admin", async () => {
  // With no Supabase credentials configured the admin lookup cannot answer, and
  // "cannot answer" must resolve to a rejection rather than an allow.
  await withEnv({ CRON_SECRET }, async () => {
    const { status, error } = await statusAndError(
      await verifyCronOrAdmin(requestWith({ authorization: "Bearer some-users-jwt" })),
    );
    assertEquals(status, 401);
    assertEquals(error, "Unauthorized");
  });
});

Deno.test("verifyCronOrAdmin reports the misconfiguration when no admin can be proven either", async () => {
  await withEnv({}, async () => {
    const { status, error } = await statusAndError(await verifyCronOrAdmin(requestWith({})));
    assertEquals(status, 503);
    assertEquals(error, "CRON_SECRET not configured");
  });
});
