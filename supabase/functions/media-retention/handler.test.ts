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

function authorisedRequest(body: string): Request {
  return new Request("https://functions.postora.cloud/media-retention", {
    method: "POST",
    headers: { "x-cron-secret": "cron-secret-value-0123456789" },
    body,
  });
}

function dryRunPorts(state: "enabled" | "disabled" | "unknown") {
  return {
    sweep: async () => [],
    claim: async () => [],
    release: async () => {},
    preview: async () => [],
    readDeleteState: async () => state,
    logDeleteSwitchUnreadable: async () => {},
    loadProviders: async () => ({ rows: [] }),
    deleteFile: async () => ({ confirmed: true }),
    removeMediaRow: async () => ({ removed: true, stillDeleting: false }),
    logRun: async () => {},
  };
}

Deno.test("the response keeps deleteEnabled and adds deleteState", async () => {
  const CRON_SECRET = "cron-secret-value-0123456789";
  await withEnv({ CRON_SECRET }, async () => {
    for (const state of ["enabled", "disabled", "unknown"] as const) {
      const res = await handleMediaRetentionRequest(authorisedRequest(JSON.stringify({ dryRun: true })), {
        ports: dryRunPorts(state),
        adminClient: fakeAdminClient([]),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.deleteState, state);
      assertEquals(body.deleteEnabled, state === "enabled");
    }
  });
});

Deno.test("malformed JSON from an authorised caller is logged and refused", async () => {
  const CRON_SECRET = "cron-secret-value-0123456789";
  await withEnv({ CRON_SECRET }, async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const res = await handleMediaRetentionRequest(authorisedRequest("{"), { adminClient: fakeAdminClient(inserts) });
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { success: false, error: "Invalid request" });
    assertEquals(inserts.length, 1);
    assertEquals(inserts[0].table, "system_logs");
    assertEquals(inserts[0].level, "warn");
    assertEquals(inserts[0].category, "system");
    assertEquals(inserts[0].source, "media-retention");
    assertEquals(inserts[0].message, "Retention request rejected");
    assertEquals(inserts[0].metadata, { reason: "invalid_json" });
  });
});

Deno.test("a non-boolean dryRun from an authorised caller is logged and refused", async () => {
  const CRON_SECRET = "cron-secret-value-0123456789";
  await withEnv({ CRON_SECRET }, async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const res = await handleMediaRetentionRequest(
      authorisedRequest(JSON.stringify({ dryRun: "yes" })),
      { adminClient: fakeAdminClient(inserts) },
    );
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { success: false, error: "Invalid request" });
    assertEquals(inserts.length, 1);
    assertEquals(inserts[0].metadata, { reason: "invalid_dry_run" });
    assertEquals(inserts[0].message, "Retention request rejected");
    assertEquals(inserts[0].level, "warn");
    assertEquals(inserts[0].category, "system");
  });
});

Deno.test("a failed rejection log does not change the 400", async () => {
  const CRON_SECRET = "cron-secret-value-0123456789";
  await withEnv({ CRON_SECRET }, async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    const throwingClient = {
      from() {
        return {
          insert() {
            return Promise.reject(new Error("insert failed"));
          },
        };
      },
    };
    try {
      const res = await handleMediaRetentionRequest(authorisedRequest("{"), { adminClient: throwingClient });
      assertEquals(res.status, 400);
      assertEquals(await res.json(), { success: false, error: "Invalid request" });
      assertEquals(errors.length > 0, true);
    } finally {
      console.error = original;
    }
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
