/**
 * The service drain of the `instagram-insights-sync` handler.
 *
 * WHAT THIS SUITE COVERS
 *
 *   1. the request contract: the drain carries no key other than the
 *      action, and every other action keeps its own behaviour;
 *   2. the authorization matrix: the cron secret, the service-role key and
 *      a verified administrator are service callers; a plain user, a
 *      `service_role` claim and a failed administrator lookup are refused;
 *      a deployment without a service credential is a misconfiguration;
 *   3. the availability gates: the drain reads the same two switches as
 *      the owner actions, and it refuses BEFORE the worker is built;
 *   4. the response: the bounded summary, and no credential in it.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createInstagramInsightsSyncHandler,
  type InstagramInsightsSyncDeps,
  type OwnerIntakeAuditEvent,
} from "./handler.ts";
import type { OwnerCollectionStore } from "./store.ts";
import { InstagramGraphProvider } from "./graphProvider.ts";
import { InstagramDirectGraphProvider } from "./directGraphProvider.ts";
import type { OwnerWorkerPorts } from "./worker.ts";
import { createFakeGraph, createFakeStore } from "./workerTestSupport.ts";

const CRON_SECRET = "the-cron-secret";
const SERVICE_ROLE_KEY = "the-service-role-key";
const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const BEARER = "header.payload.signature";

const DEFAULT_SETTINGS: Record<string, unknown> = {
  collection_instagram_insights_enabled: { data: { value: true }, error: null },
  credential_facebook_user_mode: { data: { value: "protected" }, error: null },
};

interface HarnessOptions {
  readonly claims?: unknown;
  readonly claimsHang?: boolean;
  readonly settings?: Record<string, unknown>;
  readonly cronSecret?: string | null;
  readonly serviceRoleKey?: string | null;
  readonly withoutServicePorts?: boolean;
  readonly admin?: boolean | "fail" | "hang" | "not-boolean";
  readonly workerThrows?: boolean;
}

interface Harness {
  readonly handler: (request: Request) => Promise<Response>;
  readonly audit: OwnerIntakeAuditEvent[];
  readonly settingsReads: string[];
  readonly workerBuilds: number;
  readonly claimsCalls: number;
}

function claimsEnvelope(sub: unknown = OWNER_ID, role: unknown = "authenticated"): unknown {
  return { data: { claims: { sub, role } }, error: null };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const audit: OwnerIntakeAuditEvent[] = [];
  const settingsReads: string[] = [];
  let workerBuilds = 0;
  let claimsCalls = 0;

  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...(options.settings ?? {}) };

  const { store } = createFakeStore();
  const { fetchFn } = createFakeGraph({
    profile: { followers_count: 1, media_count: 1 },
    media: [],
  });

  const workerPorts: OwnerWorkerPorts = {
    store,
    provider: new InstagramGraphProvider({ fetchFn }),
    directProvider: new InstagramDirectGraphProvider({ fetchFn }),
    bucketKeyFor: async () => "a".repeat(64),
    now: () => 0,
    log: () => undefined,
  };

  const ownerStore: OwnerCollectionStore = {
    async enqueueOwnerJob() {
      throw new Error("the owner store must not be used by the drain");
    },
    async readOwnerStatus() {
      throw new Error("the owner store must not be used by the drain");
    },
  };

  const deps: InstagramInsightsSyncDeps = {
    configuration: () => "ready",
    verifyClaims: async () => {
      claimsCalls += 1;
      if (options.claimsHang) await new Promise(() => undefined);
      return "claims" in options ? options.claims : claimsEnvelope();
    },
    readSetting: async (key: string) => {
      settingsReads.push(key);
      return settings[key];
    },
    createOwnerStore: () => ownerStore,
    audit: async (event: OwnerIntakeAuditEvent) => {
      audit.push(event);
    },
    service: options.withoutServicePorts
      ? undefined
      : {
        cronSecret: () => (options.cronSecret === undefined ? CRON_SECRET : options.cronSecret),
        serviceRoleKey: () =>
          (options.serviceRoleKey === undefined
            ? SERVICE_ROLE_KEY
            : options.serviceRoleKey),
        isAdmin: async (): Promise<boolean> => {
          if (options.admin === "hang") await new Promise(() => undefined);
          if (options.admin === "fail") throw new Error("the lookup failed");
          if (options.admin === "not-boolean") return "yes" as unknown as boolean;
          return options.admin === true;
        },
        createServiceWorker: () => {
          workerBuilds += 1;
          if (options.workerThrows) throw new Error("the worker could not be built");
          return workerPorts;
        },
      },
  };

  return {
    handler: createInstagramInsightsSyncHandler(deps),
    audit,
    settingsReads,
    get workerBuilds() {
      return workerBuilds;
    },
    get claimsCalls() {
      return claimsCalls;
    },
  };
}

function post(body: unknown, bearer: string = BEARER): Request {
  return new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// The request contract
// ---------------------------------------------------------------------------

Deno.test("the drain carries no key other than the action", async () => {
  const harness = createHarness();

  for (
    const body of [
      { action: "drain", social_account_id: "0f1a0002-0000-4000-8000-000000000012" },
      { action: "drain", limit: 5 },
      { action: "drain", user_id: OWNER_ID },
      { action: "drain", access_token: "a-secret" },
    ]
  ) {
    const response = await harness.handler(post(body));
    assertEquals(response.status, 400);
  }

  assertEquals(harness.workerBuilds, 0);
});

Deno.test("a drain without a bearer is refused", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "drain" }),
    }),
  );

  assertEquals(response.status, 401);
  assertEquals(harness.workerBuilds, 0);
});

// ---------------------------------------------------------------------------
// The authorization matrix
// ---------------------------------------------------------------------------

Deno.test("the cron secret is a service caller", async () => {
  const harness = createHarness();
  const response = await harness.handler(post({ action: "drain" }, CRON_SECRET));

  assertEquals(response.status, 200);
  assertEquals(harness.workerBuilds, 1);
  assertEquals(harness.claimsCalls, 0);
});

Deno.test("the service-role key is a service caller", async () => {
  const harness = createHarness();
  const response = await harness.handler(post({ action: "drain" }, SERVICE_ROLE_KEY));

  assertEquals(response.status, 200);
  assertEquals(harness.workerBuilds, 1);
  assertEquals(harness.claimsCalls, 0);
});

Deno.test("a verified administrator is a service caller", async () => {
  const harness = createHarness({ admin: true });
  const response = await harness.handler(post({ action: "drain" }));

  assertEquals(response.status, 200);
  assertEquals(harness.workerBuilds, 1);
  assertEquals(harness.claimsCalls, 1);
});

Deno.test("a plain user session is refused", async () => {
  const harness = createHarness({ admin: false });
  const response = await harness.handler(post({ action: "drain" }));

  assertEquals(response.status, 403);
  assertEquals((await json(response)).error, "forbidden");
  assertEquals(harness.workerBuilds, 0);
});

Deno.test("a service_role claim is never upgraded into a user", async () => {
  const harness = createHarness({
    claims: claimsEnvelope(OWNER_ID, "service_role"),
    admin: true,
  });
  const response = await harness.handler(post({ action: "drain" }));

  assertEquals(response.status, 403);
  assertEquals((await json(response)).error, "forbidden");
  assertEquals(harness.workerBuilds, 0);
});

Deno.test("a failed, late or non-boolean administrator lookup is not an administrator", async () => {
  for (const admin of ["fail", "hang", "not-boolean"] as const) {
    const harness = createHarness({ admin });
    const response = await harness.handler(post({ action: "drain" }));

    assertEquals(response.status, 403, admin);
    assertEquals(harness.workerBuilds, 0);
  }
});

Deno.test("a deployment without a service credential is a misconfiguration", async () => {
  const withoutPorts = createHarness({ withoutServicePorts: true });
  const withoutCredentials = createHarness({ cronSecret: null, serviceRoleKey: null });

  for (const harness of [withoutPorts, withoutCredentials]) {
    const response = await harness.handler(post({ action: "drain" }));
    assertEquals(response.status, 503);
    assertEquals((await json(response)).error, "service_auth_unavailable");
    assertEquals(harness.workerBuilds, 0);
  }
});

Deno.test("a claim envelope that is not a plain record is refused", async () => {
  for (const claims of ["not-an-envelope", null, [], 42]) {
    const harness = createHarness({ claims, admin: true });
    const response = await harness.handler(post({ action: "drain" }));
    assertEquals(response.status, 401);
  }
});

// ---------------------------------------------------------------------------
// The availability gates
// ---------------------------------------------------------------------------

Deno.test("a disabled collection refuses the drain before the worker is built", async () => {
  const harness = createHarness({
    settings: { collection_instagram_insights_enabled: { data: null, error: null } },
  });

  const response = await harness.handler(post({ action: "drain" }, CRON_SECRET));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "collection_disabled");
  assertEquals(harness.workerBuilds, 0);
  assertEquals(harness.settingsReads, ["collection_instagram_insights_enabled"]);
});

Deno.test("a legacy credential mode refuses the drain before the worker is built", async () => {
  const harness = createHarness({
    settings: { credential_facebook_user_mode: { data: { value: "legacy" }, error: null } },
  });

  const response = await harness.handler(post({ action: "drain" }, CRON_SECRET));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "protected_credentials_required");
  assertEquals(harness.workerBuilds, 0);
});

Deno.test("a malformed setting is unavailable, never absent", async () => {
  const harness = createHarness({
    settings: { collection_instagram_insights_enabled: { data: { value: "yes" }, error: null } },
  });

  const response = await harness.handler(post({ action: "drain" }, CRON_SECRET));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "settings_unavailable");
  assertEquals(harness.workerBuilds, 0);
});

Deno.test("a worker that cannot be built is unavailable", async () => {
  const harness = createHarness({ workerThrows: true });
  const response = await harness.handler(post({ action: "drain" }, CRON_SECRET));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "request_unavailable");
});

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

Deno.test("the drain answers with the bounded summary and no credential", async () => {
  const harness = createHarness();
  const response = await harness.handler(post({ action: "drain" }, CRON_SECRET));

  assertEquals(response.status, 200);
  const body = await json(response);
  assertEquals(body.claimed, 0);
  assertEquals(body.processed, 0);
  assertEquals(body.completed, 0);
  assertEquals(body.abandoned, 0);
  assertEquals(body.stopped_early, false);
  assertEquals(Array.isArray(body.jobs), true);
  assertEquals(JSON.stringify(body).includes("token"), false);
});

Deno.test("the drain is audited once with its stable outcome", async () => {
  const harness = createHarness();
  await harness.handler(post({ action: "drain" }, CRON_SECRET));

  assertEquals(harness.audit.length, 1);
  assertEquals(harness.audit[0]!.action, "drain");
  assertEquals(harness.audit[0]!.outcome, "drained");
  assertEquals(harness.audit[0]!.status, 200);
  assertEquals(JSON.stringify(harness.audit[0]).includes(CRON_SECRET), false);
});

Deno.test("a refusal of the drain is audited with its stable reason", async () => {
  const harness = createHarness({ admin: false });
  await harness.handler(post({ action: "drain" }));

  assertEquals(harness.audit.length, 1);
  assertEquals(harness.audit[0]!.outcome, "forbidden");
  assertEquals(harness.audit[0]!.status, 403);
});

Deno.test("the owner actions keep their own behaviour", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    post({ action: "status", social_account_id: "0f1a0002-0000-4000-8000-000000000012" }),
  );

  // The owner path reaches the owner store, which the harness refuses.
  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "status_unavailable");
  assertEquals(harness.workerBuilds, 0);
  assert(harness.audit.length >= 1);
});
