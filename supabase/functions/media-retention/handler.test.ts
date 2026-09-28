import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleMediaRetentionRequest } from "./handler.ts";

// Mirrors the env-scoping helper in _shared/cron-auth.test.ts: run `body` with
// exactly `env` in place, then restore whatever the process had before.
const MANAGED_KEYS = [
  "CRON_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
] as const;

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

function refusedRequest(): Request {
  return new Request("https://functions.postora.cloud/media-retention", { method: "POST" });
}

// deno-lint-ignore no-explicit-any
function fakeAdminClient(inserts: Array<Record<string, unknown>>): any {
  return {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, ...row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

Deno.test("an unauthorized retention request writes one sanitized audit log row", async () => {
  await withEnv({}, async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const res = await handleMediaRetentionRequest(refusedRequest(), { adminClient: fakeAdminClient(inserts) });
    assertEquals(res.status, 503);

    assertEquals(inserts.length, 1);
    assertEquals(inserts[0].table, "system_logs");
    assertEquals(inserts[0].level, "warn");
    assertEquals(inserts[0].category, "auth");
    assertEquals(inserts[0].source, "media-retention");
    assertEquals(inserts[0].message, "Retention request refused");
    assertEquals(inserts[0].metadata, { reason: "unauthorized" });
  });
});

Deno.test("a failed audit log write does not change the auth response", async () => {
  await withEnv({}, async () => {
    const throwingClient = {
      from() {
        throw new Error("db unreachable");
      },
    };
    const res = await handleMediaRetentionRequest(refusedRequest(), { adminClient: throwingClient });
    assertEquals(res.status, 503);
  });
});

Deno.test("an authorized request does not write the refusal log", async () => {
  const CRON_SECRET = "cron-secret-value-0123456789";
  await withEnv({ CRON_SECRET }, async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const req = new Request("https://functions.postora.cloud/media-retention", {
      method: "POST",
      headers: { "x-cron-secret": CRON_SECRET },
      body: JSON.stringify({ dryRun: true }),
    });
    const ports = {
      sweep: async () => [],
      claim: async () => [],
      release: async () => {},
      preview: async () => [],
      readDeleteState: async () => "enabled" as const,
      logDeleteSwitchUnreadable: async () => {},
      loadProviders: async () => ({ rows: [] }),
      deleteFile: async () => ({ confirmed: true }),
      removeMediaRow: async () => ({ removed: true, stillDeleting: false }),
      logRun: async () => {},
    };
    const res = await handleMediaRetentionRequest(req, { ports, adminClient: fakeAdminClient(inserts) });
    assertEquals(res.status, 200);
    assertEquals(inserts, []);
  });
});
