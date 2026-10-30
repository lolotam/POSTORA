/**
 * The HTTP boundary of the competitor retention function.
 *
 * WHAT THIS SUITE PROVES
 *
 *   - OPTIONS answers the preflight and POST is the only other method;
 *   - the body is strict: it is exactly `{ "dry_run": <boolean> }`, and an
 *     unknown key, a missing flag, a wrong type, invalid JSON and an
 *     oversize body are all refused with 400;
 *   - a client cannot supply an owner, a cutoff or a time: those keys are
 *     unknown keys, so they are refused;
 *   - only a verified cron/service caller (or an admin, when the shared
 *     policy supports it) may run the cleanup; an anonymous caller and an
 *     ordinary user are refused;
 *   - every refusal and every rejection is audited, and the audit never
 *     carries the presented credential;
 *   - a failed audit does not change the response.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleCompetitorRetentionRequest } from "./handler.ts";
import type {
  CompetitorRetentionPorts,
  RetentionAuditEvent,
  RetentionBatchOutcome,
  RetentionBatchRequest,
  RetentionSlice,
} from "./run.ts";

const CRON_SECRET = "cron-secret-value-0123456789";
const SERVICE_ROLE_KEY = "service-role-key-abcdefghijklm";
const ORDINARY_BEARER = "ordinary-user-bearer-token";

const MANAGED_KEYS = [
  "CRON_SECRET",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
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

function slice(overrides: Partial<RetentionSlice> = {}): RetentionSlice {
  return {
    switchState: "enabled",
    dryRun: false,
    parentsConsidered: 1,
    parentsDeleted: 1,
    parentsProjected: 1,
    parentsSkippedLiveLease: 0,
    parentsSkippedIneligible: 0,
    childrenCounted: 2,
    childrenDeleted: 2,
    hasMore: false,
    ...overrides,
  };
}

interface FakePorts extends CompetitorRetentionPorts {
  readonly requests: RetentionBatchRequest[];
  readonly audits: RetentionAuditEvent[];
}

function fakePorts(
  outcome: RetentionBatchOutcome = { ok: true, slice: slice() },
): FakePorts {
  const requests: RetentionBatchRequest[] = [];
  const audits: RetentionAuditEvent[] = [];
  return {
    requests,
    audits,
    async runBatch(request) {
      requests.push(request);
      return outcome;
    },
    async logAudit(event) {
      audits.push(event);
    },
  };
}

/**
 * The audit double. It records the rows the handler writes and answers
 * nothing else: the handler hands it to the shared logger, which is the
 * only thing that ever touches it.
 */
function fakeAdminClient(inserts: Array<Record<string, unknown>>): unknown {
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

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://api.postora.invalid/functions/v1/competitor-retention", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": CRON_SECRET,
      ...headers,
    },
    body,
  });
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

Deno.test("OPTIONS answers the preflight and no other method does", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const response = await handleCompetitorRetentionRequest(
      new Request("https://api.postora.invalid/functions/v1/competitor-retention", { method: "OPTIONS" }),
      { adminClient: fakeAdminClient(inserts) },
    );

    assertEquals(response.status, 204);
    assertEquals(response.headers.get("access-control-allow-origin") === "*", false);
    assertEquals(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");
    assertEquals(inserts.length, 0);
  });
});

Deno.test("GET, PUT and DELETE are refused with an Allow header", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const inserts: Array<Record<string, unknown>> = [];
      const response = await handleCompetitorRetentionRequest(
        new Request("https://api.postora.invalid/functions/v1/competitor-retention", { method }),
        { adminClient: fakeAdminClient(inserts) },
      );

      assertEquals(response.status, 405);
      assertEquals(response.headers.get("allow"), "POST, OPTIONS");
      assertEquals(inserts.length, 1);
      assertEquals(inserts[0].metadata, { reason: "method_not_allowed" });
    }
  });
});

Deno.test("a verified cron caller runs the cleanup and gets the truthful counts", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const ports = fakePorts();

    const response = await handleCompetitorRetentionRequest(
      post(JSON.stringify({ dry_run: false })),
      { ports, adminClient: fakeAdminClient(inserts) },
    );

    assertEquals(response.status, 200);
    const payload = await responseBody(response);
    assertEquals(payload.dry_run, false);
    assertEquals(payload.parents_deleted, 1);
    assertEquals(payload.children_deleted, 2);
    assertEquals(payload.switch_state, "enabled");
    assertEquals(payload.stop_reason, "completed");
    assertEquals(payload.failed, false);

    assertEquals(ports.requests.length, 1);
    assertEquals(ports.requests[0], { parentLimit: 50, childLimit: 500, dryRun: false });
    assertEquals(ports.audits.length, 1);
    assertEquals(inserts.length, 0);
  });
});

Deno.test("a dry run is asked for explicitly and never reports a deletion", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const ports = fakePorts({
      ok: true,
      slice: slice({
        dryRun: true,
        parentsDeleted: 0,
        parentsProjected: 3,
        childrenCounted: 9,
        childrenDeleted: 0,
      }),
    });

    const response = await handleCompetitorRetentionRequest(
      post(JSON.stringify({ dry_run: true })),
      { ports, adminClient: fakeAdminClient([]) },
    );

    assertEquals(response.status, 200);
    const payload = await responseBody(response);
    assertEquals(payload.dry_run, true);
    assertEquals(payload.parents_deleted, 0);
    assertEquals(payload.children_deleted, 0);
    assertEquals(payload.children_counted, 9);
    assertEquals(ports.requests[0], { parentLimit: 50, childLimit: 500, dryRun: true });
  });
});

Deno.test("a service-role bearer is accepted as the scheduler's authority", async () => {
  await withEnv({ CRON_SECRET, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY }, async () => {
    const ports = fakePorts();

    const response = await handleCompetitorRetentionRequest(
      post(JSON.stringify({ dry_run: false }), {
        "x-cron-secret": "",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      }),
      { ports, adminClient: fakeAdminClient([]) },
    );

    assertEquals(response.status, 200);
    assertEquals(ports.requests.length, 1);
  });
});

Deno.test("an anonymous caller is refused and audited", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const inserts: Array<Record<string, unknown>> = [];

    const response = await handleCompetitorRetentionRequest(
      new Request("https://api.postora.invalid/functions/v1/competitor-retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: false }),
      }),
      { adminClient: fakeAdminClient(inserts) },
    );

    assertEquals(response.status, 401);
    assertEquals(inserts.length, 1);
    assertEquals(inserts[0].table, "system_logs");
    assertEquals(inserts[0].level, "warn");
    assertEquals(inserts[0].category, "auth");
    assertEquals(inserts[0].source, "competitor-retention");
    assertEquals(inserts[0].metadata, { reason: "unauthorized" });
  });
});

Deno.test("an ordinary user is refused and audited", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const ports = fakePorts();

    const response = await handleCompetitorRetentionRequest(
      post(JSON.stringify({ dry_run: false }), {
        "x-cron-secret": "",
        Authorization: `Bearer ${ORDINARY_BEARER}`,
      }),
      { ports, adminClient: fakeAdminClient(inserts) },
    );

    assertEquals(response.status, 401);
    assertEquals(ports.requests.length, 0);
    assertEquals(inserts.length, 1);
    assertEquals(inserts[0].metadata, { reason: "unauthorized" });
  });
});

Deno.test("an audit row never carries the presented credential", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const inserts: Array<Record<string, unknown>> = [];

    await handleCompetitorRetentionRequest(
      new Request("https://api.postora.invalid/functions/v1/competitor-retention", {
        method: "POST",
        headers: { Authorization: `Bearer ${ORDINARY_BEARER}` },
        body: JSON.stringify({ dry_run: false }),
      }),
      { adminClient: fakeAdminClient(inserts) },
    );

    const serialised = JSON.stringify(inserts);
    assertEquals(serialised.includes(ORDINARY_BEARER), false);
    assertEquals(serialised.includes(CRON_SECRET), false);
    assertEquals(serialised.toLowerCase().includes("bearer"), false);
  });
});

Deno.test("a body that is not exactly the dry-run flag is refused and audited", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const refused: Array<[string, string, string]> = [
      ["invalid JSON", "{", "invalid_json"],
      ["an empty body", "", "invalid_json"],
      ["an unknown key", JSON.stringify({ dry_run: false, cutoff: "2020-01-01T00:00:00Z" }), "invalid_body"],
      [
        "a client-supplied owner",
        JSON.stringify({ dry_run: false, owner_id: "0f100001-0000-4000-8000-000000000001" }),
        "invalid_body",
      ],
      ["a missing flag", JSON.stringify({}), "invalid_body"],
      ["a non-boolean flag", JSON.stringify({ dry_run: "true" }), "invalid_body"],
    ];

    for (const [label, body, reason] of refused) {
      const inserts: Array<Record<string, unknown>> = [];
      const ports = fakePorts();

      const response = await handleCompetitorRetentionRequest(post(body), {
        ports,
        adminClient: fakeAdminClient(inserts),
      });

      assertEquals(response.status, 400, label);
      assertEquals(ports.requests.length, 0, label);
      assertEquals(inserts.length, 1, label);
      assertEquals(inserts[0].metadata, { reason }, label);
    }
  });
});

Deno.test("an oversize body is refused before it is parsed", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const ports = fakePorts();
    const oversize = JSON.stringify({ dry_run: false, padding: "x".repeat(4096) });

    const response = await handleCompetitorRetentionRequest(post(oversize), {
      ports,
      adminClient: fakeAdminClient(inserts),
    });

    assertEquals(response.status, 400);
    assertEquals(ports.requests.length, 0);
    assertEquals(inserts.length, 1);
    assertEquals(inserts[0].metadata, { reason: "body_too_large" });
  });
});

Deno.test("a failed slice is reported as a failure with the truthful counts", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const ports = fakePorts({ ok: false, reason: "rpc_failed" });

    const response = await handleCompetitorRetentionRequest(
      post(JSON.stringify({ dry_run: false })),
      { ports, adminClient: fakeAdminClient([]) },
    );

    assertEquals(response.status, 500);
    const payload = await responseBody(response);
    assertEquals(payload.failed, true);
    assertEquals(payload.stop_reason, "rpc_failed");
  });
});

Deno.test("a failed audit write does not change the refusal", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const throwingClient = {
      from() {
        return {
          insert() {
            return Promise.reject(new Error("the log table is unavailable"));
          },
        };
      },
    };

    const response = await handleCompetitorRetentionRequest(
      new Request("https://api.postora.invalid/functions/v1/competitor-retention", { method: "POST" }),
      { adminClient: throwingClient },
    );

    assertEquals(response.status, 401);
  });
});

Deno.test("the response carries counts and reasons only", async () => {
  await withEnv({ CRON_SECRET }, async () => {
    const response = await handleCompetitorRetentionRequest(
      post(JSON.stringify({ dry_run: false })),
      { ports: fakePorts(), adminClient: fakeAdminClient([]) },
    );

    const payload = await responseBody(response);
    assertEquals(
      Object.keys(payload).sort(),
      [
        "children_counted",
        "children_deleted",
        "dry_run",
        "failed",
        "has_more",
        "parents_deleted",
        "parents_processed",
        "parents_projected",
        "parents_skipped_ineligible",
        "parents_skipped_live_lease",
        "slices",
        "stop_reason",
        "switch_state",
      ],
    );

    const serialised = JSON.stringify(payload);
    for (const forbidden of ["caption", "url", "username", "handle", "Bearer", "token", "secret"]) {
      assert(
        !serialised.toLowerCase().includes(forbidden.toLowerCase()),
        `the response must not carry ${forbidden}: ${serialised}`,
      );
    }
  });
});
