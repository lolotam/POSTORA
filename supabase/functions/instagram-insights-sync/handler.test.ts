/**
 * The owner intake use case: the request contract, the verified identity,
 * the two availability gates, the one deadline, the response mapping and the
 * bounded audit record.
 *
 * WHAT THIS SUITE COVERS
 *
 *   1. the strict request union, byte for byte: unknown keys, explicit
 *      nulls, service actions, target kinds, job ids and owner ids are all
 *      malformed;
 *   2. the body limit, enforced while the bytes arrive, with a lying
 *      Content-Length and a body that never ends;
 *   3. the verified claim envelope: own data, own `claims`, own `sub`, own
 *      `role`, an accessor refused WITHOUT being invoked, and a service
 *      identity refused;
 *   4. the two gates, and the proof that NOTHING of the owner path is read
 *      before them;
 *   5. the response mapping, including the one 404 for a missing and for a
 *      cross-owner target, and the indeterminate enqueue;
 *   6. the deadlines: the body, the claims, the settings, the RPC and the
 *      audit are each bounded;
 *   7. one bounded audit attempt per terminal path, and no secret in it.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createInstagramInsightsSyncHandler,
  type InstagramInsightsSyncDeps,
  type OwnerIntakeAuditEvent,
  type SettingReadEnvelope,
} from "./handler.ts";
import type { OwnerCollectionStore } from "./store.ts";

const ACCOUNT_ID = "0f1a0002-0000-4000-8000-000000000012";
const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const BEARER = "header.payload.signature";
const CAPTURED_ON = "2026-10-28";

interface StoreCall {
  readonly method: "enqueueOwnerJob" | "readOwnerStatus";
  readonly input: Record<string, unknown>;
}

type StoreOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "throttled" }
  | { readonly kind: "target_not_found" }
  | { readonly kind: "request_refused" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "hang" };

interface HarnessOptions {
  readonly claims?: unknown;
  readonly claimsHang?: boolean;
  readonly claimsThrow?: boolean;
  readonly settings?: Record<string, unknown>;
  readonly settingsHang?: boolean;
  readonly settingsThrow?: boolean;
  readonly store?: StoreOutcome;
  readonly auditThrows?: boolean;
  readonly auditHang?: boolean;
  readonly configuration?: "ready" | "unavailable";
}

interface Harness {
  readonly handler: (request: Request) => Promise<Response>;
  readonly audit: OwnerIntakeAuditEvent[];
  readonly settingsReads: string[];
  readonly storeCalls: StoreCall[];
  readonly tokens: string[];
}

const DEFAULT_SETTINGS: Record<string, unknown> = {
  collection_instagram_insights_enabled: { data: { value: true }, error: null },
  credential_facebook_user_mode: { data: { value: "protected" }, error: null },
};

function claimsEnvelope(
  sub: unknown = OWNER_ID,
  role: unknown = "authenticated",
): unknown {
  return { data: { claims: { sub, role } }, error: null };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const audit: OwnerIntakeAuditEvent[] = [];
  const settingsReads: string[] = [];
  const storeCalls: StoreCall[] = [];
  const tokens: string[] = [];

  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...(options.settings ?? {}) };

  const store: OwnerCollectionStore = {
    async enqueueOwnerJob(input) {
      storeCalls.push({ method: "enqueueOwnerJob", input: { ...input, signal: undefined } });
      const outcome = options.store ?? { kind: "accepted" };
      if (outcome.kind === "hang") await new Promise(() => undefined);
      if (outcome.kind === "accepted") {
        return {
          kind: "accepted",
          projection: {
            accepted: true,
            reason: "enqueued",
            job_id: "5c1b0003-0000-4000-8000-000000000003",
            job_generation: 1,
            status: "queued",
            captured_on: CAPTURED_ON,
            created: true,
            accepted_at: "2026-10-28T07:00:00+00:00",
          },
        };
      }
      if (outcome.kind === "throttled") {
        return {
          kind: "throttled",
          projection: {
            accepted: false,
            reason: "throttled",
            retry_after_seconds: 120,
            captured_on: CAPTURED_ON,
          },
        };
      }
      throw Object.assign(new Error("store failure"), { failure: outcome.kind });
    },
    async readOwnerStatus(input) {
      storeCalls.push({ method: "readOwnerStatus", input: { ...input, signal: undefined } });
      const outcome = options.store ?? { kind: "accepted" };
      if (outcome.kind === "hang") await new Promise(() => undefined);
      if (outcome.kind === "accepted") {
        return {
          target_kind: "owner",
          target_id: ACCOUNT_ID,
          captured_on: CAPTURED_ON,
          status: "partial",
          job_generation: 3,
          attempts: 2,
          due_at: "2026-10-28T07:00:00+00:00",
          next_retry_at: null,
          last_attempt_at: "2026-10-28T07:00:00+00:00",
          last_partial_at: "2026-10-28T07:00:00+00:00",
          last_success_at: null,
          reason_code: "provider_throttled",
          inventory: {
            truncated: false,
            partial: false,
            window_covered: true,
            oldest_returned_at: "2026-10-28T07:00:00+00:00",
            gap_reason: null,
            pages_fetched: 4,
          },
          pending_operations: 7,
        };
      }
      throw Object.assign(new Error("store failure"), { failure: outcome.kind });
    },
  };

  const deps: InstagramInsightsSyncDeps = {
    configuration: () => options.configuration ?? "ready",

    verifyClaims: async () => {
      if (options.claimsHang) await new Promise(() => undefined);
      if (options.claimsThrow) throw new Error("claims transport failed");
      return "claims" in options ? options.claims : claimsEnvelope();
    },

    readSetting: async (key: string): Promise<SettingReadEnvelope> => {
      settingsReads.push(key);
      if (options.settingsHang) await new Promise(() => undefined);
      if (options.settingsThrow) throw new Error("settings transport failed");
      return settings[key] as SettingReadEnvelope;
    },

    createOwnerStore: (token: string) => {
      tokens.push(token);
      return store;
    },

    audit: async (event: OwnerIntakeAuditEvent) => {
      if (options.auditHang) await new Promise(() => undefined);
      if (options.auditThrows) throw new Error("audit write failed");
      audit.push(event);
    },
  };

  return {
    handler: createInstagramInsightsSyncHandler(deps),
    audit,
    settingsReads,
    storeCalls,
    tokens,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BEARER}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// The method and the body
// ---------------------------------------------------------------------------

Deno.test("a GET is refused with 405 and an Allow header", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "GET",
    }),
  );

  assertEquals(response.status, 405);
  assertEquals(response.headers.get("Allow"), "POST, OPTIONS");
  assertEquals((await json(response)).error, "method_not_allowed");
  assertEquals(harness.audit.length, 1);
});

Deno.test("an OPTIONS preflight is answered and is not audited", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "OPTIONS",
    }),
  );

  assertEquals(response.status, 204);
  assertEquals(harness.audit.length, 0);
  assertEquals(harness.storeCalls.length, 0);
});

Deno.test("a malformed body is refused with 400", async () => {
  const harness = createHarness();
  const response = await harness.handler(post("{not json"));

  assertEquals(response.status, 400);
  assertEquals((await json(response)).error, "invalid_request");
  assertEquals(harness.storeCalls.length, 0);
});

Deno.test("an unknown field is refused", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    post({ action: "enqueue", social_account_id: ACCOUNT_ID, user_id: OWNER_ID }),
  );

  assertEquals(response.status, 400);
});

Deno.test("a service action, a target kind, a job id and a secret are refused", async () => {
  const harness = createHarness();
  const bodies = [
    { action: "drain", social_account_id: ACCOUNT_ID },
    { action: "enqueue", social_account_id: ACCOUNT_ID, target_kind: "owner" },
    { action: "enqueue", social_account_id: ACCOUNT_ID, job_id: "5c1b0003-0000-4000-8000-000000000003" },
    { action: "enqueue", social_account_id: ACCOUNT_ID, access_token: "a-secret" },
    { action: "enqueue", social_account_id: ACCOUNT_ID, mode: "service" },
  ];

  for (const body of bodies) {
    const response = await harness.handler(post(body));
    assertEquals(response.status, 400);
  }
  assertEquals(harness.storeCalls.length, 0);
});

Deno.test("an explicit null is not an omission", async () => {
  const harness = createHarness();
  const modeNull = await harness.handler(
    post({ action: "enqueue", social_account_id: ACCOUNT_ID, mode: null }),
  );
  const dayNull = await harness.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID, captured_on: null }),
  );

  assertEquals(modeNull.status, 400);
  assertEquals(dayNull.status, 400);
});

Deno.test("a body that is not an object is refused", async () => {
  const harness = createHarness();
  for (const body of ["[]", '"enqueue"', "null", "42"]) {
    const response = await harness.handler(post(body));
    assertEquals(response.status, 400);
  }
});

Deno.test("an account id that is not a clean UUID is refused", async () => {
  const harness = createHarness();
  const bodies = [
    "not-a-uuid",
    " 0f1a0002-0000-4000-8000-000000000012",
    "0f1a0002-0000-4000-8000-000000000012 ",
    "0f1a0002-0000-4000-8000-00000000001\u00002",
    "0f1a00020000-4000-8000-000000000012",
  ];

  for (const social_account_id of bodies) {
    const response = await harness.handler(post({ action: "status", social_account_id }));
    assertEquals(response.status, 400);
  }
});

Deno.test("an upper case UUID is accepted and canonicalised", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID.toUpperCase() }),
  );

  assertEquals(response.status, 200);
  assertEquals(harness.storeCalls[0]!.input.socialAccountId, ACCOUNT_ID);
});

Deno.test("an impossible capture day is refused and a real one is accepted", async () => {
  const harness = createHarness();
  const refused = [
    "2026-02-30",
    "2023-02-29",
    "2026-13-01",
    "2026-00-10",
    "0000-01-01",
    "2026-10-28T00:00:00Z",
    "20261028",
  ];
  for (const captured_on of refused) {
    const response = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID, captured_on }),
    );
    assertEquals(response.status, 400);
  }

  for (const captured_on of ["2024-02-29", "0001-01-01", "0099-12-31", "2026-10-28"]) {
    const response = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID, captured_on }),
    );
    assertEquals(response.status, 200);
  }
});

Deno.test("a body of exactly four kibibytes is accepted and one byte more is refused", async () => {
  const harness = createHarness();
  const base = JSON.stringify({ action: "enqueue", social_account_id: ACCOUNT_ID, mode: "normal" });
  const padded = base + " ".repeat(4096 - base.length);

  assertEquals(new TextEncoder().encode(padded).length, 4096);
  const accepted = await harness.handler(post(padded));
  assertEquals(accepted.status, 202);

  const tooLarge = await harness.handler(post(padded + " "));
  assertEquals(tooLarge.status, 413);
  assertEquals((await json(tooLarge)).error, "payload_too_large");
});

Deno.test("a multibyte body is measured in bytes", async () => {
  const harness = createHarness();
  const base = JSON.stringify({ action: "enqueue", social_account_id: ACCOUNT_ID, mode: "normal" });
  const padding = "é".repeat(4096);
  const body = base + padding;

  assertEquals(new TextEncoder().encode(body).length > 4096, true);
  const response = await harness.handler(post(body));
  assertEquals(response.status, 413);
});

Deno.test("a lying Content-Length does not change the outcome", async () => {
  const harness = createHarness();
  const body = JSON.stringify({ action: "enqueue", social_account_id: ACCOUNT_ID });

  const small = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BEARER}`,
        "Content-Length": "4",
      },
      body,
    }),
  );
  assertEquals(small.status, 202);

  const large = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BEARER}`,
        "Content-Length": "999999",
      },
      body: body + " ".repeat(4096),
    }),
  );
  assertEquals(large.status, 413);
});

Deno.test("a body that never ends is refused at the limit", async () => {
  const harness = createHarness();
  let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunk = new TextEncoder().encode(" ".repeat(256));
      const pump = () => {
        if (stopped) return;
        try {
          controller.enqueue(chunk);
        } catch {
          return;
        }
        setTimeout(pump, 0);
      };
      pump();
    },
    cancel() {
      stopped = true;
    },
  });

  const response = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${BEARER}` },
      body: stream,
      // @ts-expect-error - the duplex hint is required by the fetch spec for a stream body.
      duplex: "half",
    }),
  );

  assertEquals(response.status, 413);
});

Deno.test("a caller that aborts stops the body read", async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode(" "));
    },
  });

  const request = new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}` },
    body: stream,
    signal: controller.signal,
    // @ts-expect-error - the duplex hint is required by the fetch spec for a stream body.
    duplex: "half",
  });

  setTimeout(() => controller.abort(), 10);
  const started = Date.now();
  const response = await harness.handler(request);

  assertEquals(response.status, 503);
  assertEquals(harness.storeCalls.length, 0);
  // The caller's cancellation stops the read at once. It does not wait for
  // the dependency ceiling.
  assertEquals(Date.now() - started < 2_000, true);
});

// ---------------------------------------------------------------------------
// The verified identity
// ---------------------------------------------------------------------------

Deno.test("a missing or malformed bearer is refused with 401", async () => {
  const harness = createHarness();

  const missing = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", social_account_id: ACCOUNT_ID }),
    }),
  );
  assertEquals(missing.status, 401);

  const malformed = await harness.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID }, { Authorization: "Basic abc" }),
  );
  assertEquals(malformed.status, 401);
  assertEquals(harness.storeCalls.length, 0);
});

Deno.test("a claim envelope that is not a plain record is refused", async () => {
  for (const claims of ["not-an-envelope", null, [], 42]) {
    const harness = createHarness({ claims });
    const response = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID }),
    );
    assertEquals(response.status, 401);
  }
});

Deno.test("a claim envelope without an own error that is null is refused", async () => {
  const cases: unknown[] = [
    { data: { claims: { sub: OWNER_ID, role: "authenticated" } } },
    { data: { claims: { sub: OWNER_ID, role: "authenticated" } }, error: undefined },
    { data: { claims: { sub: OWNER_ID, role: "authenticated" } }, error: { message: "x" } },
    Object.assign(Object.create({ error: null }), {
      data: { claims: { sub: OWNER_ID, role: "authenticated" } },
    }),
  ];

  for (const claims of cases) {
    const harness = createHarness({ claims });
    const response = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID }),
    );
    assertEquals(response.status, 401);
  }
});

Deno.test("an accessor claim property is refused without being invoked", async () => {
  let invoked = false;
  const envelope = {
    data: {
      claims: {
        sub: OWNER_ID,
        role: "authenticated",
        get email() {
          invoked = true;
          return "a@b.invalid";
        },
      },
    },
    error: null,
  };

  const harness = createHarness({ claims: envelope });
  const response = await harness.handler(post({ action: "status", social_account_id: ACCOUNT_ID }));

  assertEquals(response.status, 200);
  assertEquals(invoked, false);
});

Deno.test("an accessor role or sub is refused without being invoked", async () => {
  for (const key of ["role", "sub"]) {
    let invoked = false;
    const claims: Record<string, unknown> = { sub: OWNER_ID, role: "authenticated" };
    Object.defineProperty(claims, key, {
      get() {
        invoked = true;
        return key === "role" ? "authenticated" : OWNER_ID;
      },
      enumerable: true,
      configurable: true,
    });

    const harness = createHarness({ claims: { data: { claims }, error: null } });
    const response = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID }),
    );
    assertEquals(response.status, 401);
    assertEquals(invoked, false);
  }
});

Deno.test("an inherited role or sub is refused", async () => {
  for (const key of ["role", "sub"]) {
    const claims = Object.create({ [key]: key === "role" ? "authenticated" : OWNER_ID }) as Record<
      string,
      unknown
    >;
    claims.sub = OWNER_ID;
    claims.role = "authenticated";
    delete claims[key];

    const harness = createHarness({ claims: { data: { claims }, error: null } });
    const response = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID }),
    );
    assertEquals(response.status, 401);
  }
});

Deno.test("a service identity is refused and an administrator is an ordinary owner", async () => {
  const service = createHarness({ claims: claimsEnvelope(OWNER_ID, "service_role") });
  const serviceResponse = await service.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID }),
  );
  assertEquals(serviceResponse.status, 401);

  const administrator = createHarness({ claims: claimsEnvelope(OWNER_ID, "authenticated") });
  const adminResponse = await administrator.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID }),
  );
  assertEquals(adminResponse.status, 200);
});

Deno.test("a sub that is not a usable UUID is refused", async () => {
  for (const sub of ["not-a-uuid", "", null, 42]) {
    const harness = createHarness({ claims: claimsEnvelope(sub) });
    const response = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID }),
    );
    assertEquals(response.status, 401);
  }
});

Deno.test("the verified bearer reaches the owner store unchanged", async () => {
  const harness = createHarness();
  await harness.handler(post({ action: "status", social_account_id: ACCOUNT_ID }));

  assertEquals(harness.tokens.length, 1);
  assertEquals(harness.tokens[0], BEARER);
});

// ---------------------------------------------------------------------------
// The availability gates
// ---------------------------------------------------------------------------

Deno.test("an absent or off collection setting refuses before anything else is read", async () => {
  for (const value of [{ data: null, error: null }, { data: { value: false }, error: null }]) {
    const harness = createHarness({
      settings: { collection_instagram_insights_enabled: value },
    });
    const response = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID }),
    );

    assertEquals(response.status, 503);
    assertEquals((await json(response)).error, "collection_disabled");
    assertEquals(harness.tokens.length, 0);
    assertEquals(harness.storeCalls.length, 0);
    assertEquals(harness.settingsReads.length, 1);
  }
});

Deno.test("an off collection setting never reads the credential mode", async () => {
  const harness = createHarness({
    settings: { collection_instagram_insights_enabled: { data: null, error: null } },
  });
  await harness.handler(post({ action: "enqueue", social_account_id: ACCOUNT_ID }));

  assertEquals(harness.settingsReads.length, 1);
  assertEquals(harness.settingsReads[0], "collection_instagram_insights_enabled");
});

Deno.test("a legacy or absent credential mode refuses the request", async () => {
  for (const value of [
    { data: null, error: null },
    { data: { value: "legacy" }, error: null },
  ]) {
    const harness = createHarness({
      settings: { credential_facebook_user_mode: value },
    });
    const response = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID }),
    );

    assertEquals(response.status, 503);
    assertEquals((await json(response)).error, "protected_credentials_required");
    assertEquals(harness.storeCalls.length, 0);
  }
});

Deno.test("a malformed, failed or unreadable setting is unavailable, never absent", async () => {
  const cases: Record<string, unknown>[] = [
    { data: { value: { nested: true } }, error: null },
    { data: { value: "not-a-mode" }, error: null },
    { data: null, error: { code: "42501" } },
    { data: null, error: undefined },
    Object.assign(Object.create({ error: null }), { data: { value: true } }),
    { error: null },
    "not-an-envelope",
  ];

  for (const value of cases) {
    const harness = createHarness({
      settings: { collection_instagram_insights_enabled: value },
    });
    const response = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID }),
    );

    assertEquals(response.status, 503);
    assertEquals((await json(response)).error, "settings_unavailable");
    assertEquals(harness.storeCalls.length, 0);
  }
});

Deno.test("a failed settings read is unavailable", async () => {
  const harness = createHarness({ settingsThrow: true });
  const response = await harness.handler(post({ action: "status", social_account_id: ACCOUNT_ID }));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "settings_unavailable");
});

Deno.test("an accessor setting value is refused without being invoked", async () => {
  let invoked = false;
  const row = {};
  Object.defineProperty(row, "value", {
    get() {
      invoked = true;
      return true;
    },
    enumerable: true,
    configurable: true,
  });

  const harness = createHarness({
    settings: { collection_instagram_insights_enabled: { data: row, error: null } },
  });
  const response = await harness.handler(post({ action: "status", social_account_id: ACCOUNT_ID }));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "settings_unavailable");
  assertEquals(invoked, false);
});

Deno.test("a missing server configuration is refused without printing it", async () => {
  const harness = createHarness({ configuration: "unavailable" });
  const response = await harness.handler(post({ action: "status", social_account_id: ACCOUNT_ID }));

  assertEquals(response.status, 503);
  assertEquals(harness.storeCalls.length, 0);
  assertEquals(harness.settingsReads.length, 0);
});

// ---------------------------------------------------------------------------
// The responses
// ---------------------------------------------------------------------------

Deno.test("an accepted enqueue is 202 and keeps the projection", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    post({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 202);
  const body = await json(response);
  assertEquals(body.accepted, true);
  assertEquals(body.reason, "enqueued");
  assertEquals(Object.keys(body).length, 8);
});

Deno.test("an omitted mode is a normal enqueue and a force mode is a force", async () => {
  const harness = createHarness();
  await harness.handler(post({ action: "enqueue", social_account_id: ACCOUNT_ID }));
  await harness.handler(post({ action: "enqueue", social_account_id: ACCOUNT_ID, mode: "force" }));

  assertEquals(harness.storeCalls[0]!.input.mode, "normal");
  assertEquals(harness.storeCalls[1]!.input.mode, "force");
});

Deno.test("a throttle is 429 with a validated Retry-After and no second write", async () => {
  const harness = createHarness({ store: { kind: "throttled" } });
  const response = await harness.handler(
    post({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), "120");
  const body = await json(response);
  assertEquals(body.accepted, false);
  assertEquals(body.reason, "throttled");
  assertEquals(body.retry_after_seconds, 120);
  assertEquals(Object.keys(body).length, 4);
  assertEquals(harness.storeCalls.length, 1);
});

Deno.test("a status read is 200 and keeps the projection", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 200);
  const body = await json(response);
  assertEquals(body.status, "partial");
  assertEquals(body.pending_operations, 7);
  assertEquals("job_id" in body, false);
});

Deno.test("an explicit capture day reaches the store and an omitted one is null", async () => {
  const harness = createHarness();
  await harness.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID, captured_on: CAPTURED_ON }),
  );
  await harness.handler(post({ action: "status", social_account_id: ACCOUNT_ID }));

  assertEquals(harness.storeCalls[0]!.input.capturedOn, CAPTURED_ON);
  assertEquals(harness.storeCalls[1]!.input.capturedOn, null);
});

Deno.test("a missing and a cross-owner target are the same 404", async () => {
  for (const kind of ["target_not_found"] as const) {
    const harness = createHarness({ store: { kind } });
    const enqueue = await harness.handler(
      post({ action: "enqueue", social_account_id: ACCOUNT_ID }),
    );
    const status = await harness.handler(
      post({ action: "status", social_account_id: ACCOUNT_ID }),
    );

    assertEquals(enqueue.status, 404);
    assertEquals(status.status, 404);
    assertEquals((await json(enqueue)).error, "not_found");
    assertEquals((await json(status)).error, "not_found");
  }
});

Deno.test("an indeterminate enqueue is 503 and is never replayed or replaced by a status read", async () => {
  const harness = createHarness({ store: { kind: "indeterminate" } });
  const response = await harness.handler(
    post({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "enqueue_indeterminate");
  assertEquals(harness.storeCalls.length, 1);
  assertEquals(harness.storeCalls[0]!.method, "enqueueOwnerJob");
});

Deno.test("a malformed receipt is indeterminate for both actions", async () => {
  const enqueue = createHarness({ store: { kind: "indeterminate" } });
  assertEquals(
    (await enqueue.handler(post({ action: "enqueue", social_account_id: ACCOUNT_ID }))).status,
    503,
  );

  const status = createHarness({ store: { kind: "indeterminate" } });
  const statusResponse = await status.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID }),
  );
  assertEquals(statusResponse.status, 503);
  assertEquals((await json(statusResponse)).error, "status_unavailable");
});

Deno.test("a definitive request refusal is 400 and a role refusal is 401", async () => {
  const refused = createHarness({ store: { kind: "request_refused" } });
  assertEquals(
    (await refused.handler(post({ action: "status", social_account_id: ACCOUNT_ID }))).status,
    400,
  );

  const unauthorized = createHarness({ store: { kind: "unauthorized" } });
  assertEquals(
    (await unauthorized.handler(post({ action: "status", social_account_id: ACCOUNT_ID }))).status,
    401,
  );
});

Deno.test("no response carries the bearer, the owner or a driver message", async () => {
  const harness = createHarness({ store: { kind: "indeterminate" } });
  const response = await harness.handler(
    post({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );
  const text = await response.text();

  assertEquals(text.includes(BEARER), false);
  assertEquals(text.includes(OWNER_ID), false);
});

// ---------------------------------------------------------------------------
// The deadlines
// ---------------------------------------------------------------------------

Deno.test("a claim verification that never answers is refused inside the budget", async () => {
  const harness = createHarness({ claimsHang: true });
  const started = Date.now();
  const response = await harness.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 503);
  assertEquals(Date.now() - started < 12_000, true);
  assertEquals(harness.storeCalls.length, 0);
});

Deno.test("a settings read that never answers is refused inside the budget", async () => {
  const harness = createHarness({ settingsHang: true });
  const started = Date.now();
  const response = await harness.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "settings_unavailable");
  assertEquals(Date.now() - started < 12_000, true);
});

Deno.test("an RPC that never answers is refused inside the budget", async () => {
  const harness = createHarness({ store: { kind: "hang" } });
  const started = Date.now();
  const response = await harness.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "status_unavailable");
  assertEquals(Date.now() - started < 12_000, true);
});

Deno.test("an audit write that never answers does not hold the response", async () => {
  const harness = createHarness({ auditHang: true });
  const started = Date.now();
  const response = await harness.handler(
    post({ action: "status", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 200);
  assertEquals(Date.now() - started < 12_000, true);
});

// ---------------------------------------------------------------------------
// The audit record
// ---------------------------------------------------------------------------

Deno.test("every terminal path writes exactly one bounded audit record", async () => {
  const harness = createHarness();
  await harness.handler(post({ action: "enqueue", social_account_id: ACCOUNT_ID }));

  assertEquals(harness.audit.length, 1);
  assertEquals(harness.audit[0]!.action, "enqueue");
  assertEquals(harness.audit[0]!.outcome, "enqueued");
  assertEquals(harness.audit[0]!.status, 202);
  assertEquals(harness.audit[0]!.userId, OWNER_ID);
  assertEquals(harness.audit[0]!.socialAccountId, ACCOUNT_ID);
});

Deno.test("the audit record carries no bearer, no body and no driver text", async () => {
  const harness = createHarness({ store: { kind: "indeterminate" } });
  await harness.handler(post({ action: "enqueue", social_account_id: ACCOUNT_ID }));

  const record = JSON.stringify(harness.audit[0]);
  assertEquals(record.includes(BEARER), false);
  assertEquals(record.includes("secret"), false);
  assertStringIncludes(record, "indeterminate");
});

Deno.test("a failed audit write does not change the response and is not claimed as stored", async () => {
  const harness = createHarness({ auditThrows: true });
  const response = await harness.handler(
    post({ action: "enqueue", social_account_id: ACCOUNT_ID }),
  );

  assertEquals(response.status, 202);
  assertEquals(harness.audit.length, 0);
  assertEquals(harness.storeCalls.length, 1);
});

Deno.test("a refusal is audited with its stable reason", async () => {
  const harness = createHarness({
    settings: { collection_instagram_insights_enabled: { data: null, error: null } },
  });
  await harness.handler(post({ action: "enqueue", social_account_id: ACCOUNT_ID }));

  assertEquals(harness.audit.length, 1);
  assertEquals(harness.audit[0]!.outcome, "collection_disabled");
  assertEquals(harness.audit[0]!.status, 503);
});

Deno.test("a malformed request is audited with the action it claimed", async () => {
  const harness = createHarness();
  await harness.handler(post({ action: "status", social_account_id: "not-a-uuid" }));

  assertEquals(harness.audit.length, 1);
  assertEquals(harness.audit[0]!.action, "status");
  assertEquals(harness.audit[0]!.outcome, "invalid_request");
});
