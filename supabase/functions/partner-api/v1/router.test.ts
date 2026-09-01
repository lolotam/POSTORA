// deno-lint-ignore-file no-import-prefix
// Deliverables 2.1 + 2.2 — the /v1 router and the D2 error envelope.
//
// Same discipline as suspension.test.ts / limiterPolicy.test.ts: exercise the
// REAL production handler through handleRequest and stub only the Supabase
// client boundary. The contract facts (required fields, the error-code enum)
// are READ from docs/api/openapi.yaml rather than hardcoded, the way
// contractConformance.test.ts does, so this file fails when the document and
// the code drift apart — in either direction.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parse } from "jsr:@std/yaml@1";
import { handleRequest } from "../index.ts";
import {
  resolveV1Route,
  V1_ROUTES,
  v1SubpathOf,
  type V1Route,
} from "./router.ts";
import { V1_ERROR_POLICY } from "./errors.ts";

const DOC_PATH = new URL("../../../../docs/api/openapi.yaml", import.meta.url);
// deno-lint-ignore no-explicit-any
const doc = parse(await Deno.readTextFile(DOC_PATH)) as any;

const KEY_ROW = {
  id: "key-1", workspace_id: "ws-1", social_account_id: "acct-1",
  key_prefix: "pk_live_abcd",
  scopes: ["whatsapp:template.send", "whatsapp:templates.read"],
  rate_limit_per_min: 60, monthly_quota: null, expires_at: null, revoked_at: null,
};

const ACCOUNT_ROW = {
  id: "acct-1", user_id: "user-1", workspace_id: "ws-1", platform: "whatsapp",
  platform_user_id: "phone-1", access_token: "token", connection_mode: "cloud",
  is_active: true, needs_reauth: false, token_expires_at: null,
  account_metadata: { waba_id: "waba-1" },
};

interface StubOptions {
  keyRow?: unknown;
  keyLookupError?: unknown;
  limiter?: { data: unknown; error: unknown };
}

function stubClient(opts: StubOptions = {}) {
  const { keyRow = KEY_ROW, keyLookupError = null } = opts;
  const limiter = opts.limiter ??
    { data: { allowed: true, remaining: 59, reset_seconds: 42 }, error: null };
  return {
    rpc(name: string) {
      if (name === "consume_partner_rate_v2") return Promise.resolve(limiter);
      return Promise.resolve({ error: null });
    },
    from(table: string) {
      if (table === "partner_api_usage") {
        return { insert: () => Promise.resolve({ error: null }) };
      }
      const row = table === "partner_api_keys" ? keyRow : ACCOUNT_ROW;
      const err = table === "partner_api_keys" ? keyLookupError : null;
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: err ? null : row, error: err }); },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

const BASE = "https://partner.example/functions/v1/partner-api";

function v1Request(path: string, method = "GET", headers: Record<string, string> = {}) {
  return new Request(BASE + path, { method, headers });
}

function aliasPost(action: string, headers: Record<string, string> = {}) {
  return new Request(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-postora-key": "pk_live_test", ...headers },
    body: JSON.stringify({ action }),
  });
}

/** A client factory that throws if the /v1 door ever touches Supabase.
 *  Authentication, metering, idempotency and quota are 2.3+ work; this keeps
 *  that boundary mechanical instead of aspirational. */
function refusingClient() {
  return () => {
    throw new Error("the /v1 router must not touch the database in 2.1/2.2");
  };
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Register a route for the duration of one test block, then remove it —
 *  production registers nothing (deliverables 2.3–2.7), so 405/dispatch can
 *  only be proven against a route that exists for the test's lifetime. */
async function withTempRoute<T>(route: V1Route, block: () => Promise<T> | T): Promise<T> {
  V1_ROUTES.push(route);
  try {
    return await block();
  } finally {
    const at = V1_ROUTES.indexOf(route);
    if (at !== -1) V1_ROUTES.splice(at, 1);
  }
}

// ---------------------------------------------------------------------------
// Routing boundary — which door a request takes.
// ---------------------------------------------------------------------------

Deno.test("v1SubpathOf routes only paths at or under /v1 to the v1 door", () => {
  const cases: Array<[string, string | null]> = [
    [`${BASE}`, null],
    [`${BASE}/`, null],
    [`${BASE}/v1`, "/v1"],
    [`${BASE}/v1/`, "/v1/"],
    [`${BASE}/v1/accounts`, "/v1/accounts"],
    [`${BASE}/v1/accounts/acc_1/messages`, "/v1/accounts/acc_1/messages"],
    // "/v1x" is a different path, not a /v1 path — the alias door answers.
    [`${BASE}/v1x`, null],
    [`${BASE}/other`, null],
    // Query strings never participate in routing.
    [`${BASE}/v1?account_id=acc_1`, "/v1"],
    // Mount depth must not matter: Kong, localhost, or a deeper proxy prefix.
    ["https://other.example/v1", null],
    ["https://other.example/somewhere/deep/partner-api/v1/messages", "/v1/messages"],
    ["https://other.example/x", null],
  ];
  for (const [url, expected] of cases) {
    assertEquals(v1SubpathOf(url), expected, `v1SubpathOf(${url})`);
  }
});

// ---------------------------------------------------------------------------
// T1 — X-Postora-Request-Id on every /v1 response, EQUAL to the envelope's
// request_id. Equality, not presence: the header and the body value are one
// correlation handle, and a build where they diverge is uninterruptible.
// ---------------------------------------------------------------------------

Deno.test("every /v1 response carries X-Postora-Request-Id equal to the envelope's request_id (404 and 405)", async () => {
  await withTempRoute(
    {
      pattern: "/v1/route-for-t1",
      methods: {
        GET: (_req, requestId) =>
          Promise.resolve(
            new Response(JSON.stringify({ request_id: requestId }), {
              status: 200,
              headers: { "X-Postora-Request-Id": requestId },
            }),
          ),
      },
    },
    async () => {
      const responses: Array<[string, Response]> = [
        ["404", await handleRequest(v1Request("/v1/nothing-here"), refusingClient())],
        ["405", await handleRequest(v1Request("/v1/route-for-t1", "POST"), refusingClient())],
        ["200", await handleRequest(v1Request("/v1/route-for-t1", "GET"), refusingClient())],
      ];
      for (const [label, res] of responses) {
        const header = res.headers.get("X-Postora-Request-Id");
        assertEquals(header !== null, true, `${label}: header missing`);
        assertEquals(UUID_V4.test(header!), true, `${label}: not a UUIDv4: ${header}`);
        const body = await res.json();
        assertEquals(
          body.request_id ?? body.error?.request_id,
          header,
          `${label}: header and body request_id differ`,
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T2 — the unmatched-path 404, shaped exactly as documented.
// ---------------------------------------------------------------------------

Deno.test("an unmatched /v1 path returns the typed resource_not_found envelope with no stray keys", async () => {
  const res = await handleRequest(v1Request("/v1/does-not-exist"), refusingClient());
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("Content-Type"), "application/json");
  const body = await res.json();
  // Envelope: top level is ONLY {error} — no success, no top-level request_id
  // (that is the ALIAS's shape, deliberately different per D2).
  assertEquals(Object.keys(body).sort(), ["error"]);
  // Object: exactly the four required keys; details omitted — never null,
  // never {} — when there is nothing to say.
  assertEquals(Object.keys(body.error).sort(), ["code", "message", "request_id", "retryable"]);
  assertEquals(body.error.code, "resource_not_found");
  assertEquals(body.error.retryable, false);
  assertEquals(typeof body.error.message, "string");
  assertEquals(body.error.request_id, res.headers.get("X-Postora-Request-Id"));
});

Deno.test("a /v1 CORS preflight is not answered with the alias's CORS headers", async () => {
  // The recorded CORS decision (2026-08-30, correction 2) covers the alias
  // only; /v1 makes no Access-Control-* claims until its own decision is
  // recorded, so an OPTIONS under /v1 resolves like any other /v1 request
  // instead of hitting the alias preflight short-circuit.
  const res = await handleRequest(v1Request("/v1/anything", "OPTIONS"), refusingClient());
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), null);
  const body = await res.json();
  assertEquals(body.error.code, "resource_not_found");
});

// ---------------------------------------------------------------------------
// T3 — matched path, wrong method: 405 + Allow naming the supported methods.
// ---------------------------------------------------------------------------

Deno.test("a matched /v1 path with an unsupported method returns 405 with an Allow header", async () => {
  await withTempRoute(
    {
      pattern: "/v1/route-for-t3",
      methods: {
        GET: () => Promise.resolve(new Response("{}")),
        DELETE: () => Promise.resolve(new Response("{}")),
      },
    },
    async () => {
      const res = await handleRequest(v1Request("/v1/route-for-t3", "POST"), refusingClient());
      assertEquals(res.status, 405);
      // Registration order, uppercase, comma-separated (RFC 9110 §10.2.1).
      assertEquals(res.headers.get("Allow"), "GET, DELETE");
      const body = await res.json();
      assertEquals(body.error.code, "method_not_allowed");
      assertEquals(body.error.retryable, false);
      assertEquals(body.error.request_id, res.headers.get("X-Postora-Request-Id"));
    },
  );
});

Deno.test("a route matching with its declared method dispatches with the captured path params", async () => {
  await withTempRoute(
    {
      pattern: "/v1/route-for-dispatch/{id}",
      methods: {
        GET: (_req, requestId, params) =>
          Promise.resolve(
            new Response(JSON.stringify({ request_id: requestId, params }), {
              headers: { "X-Postora-Request-Id": requestId },
            }),
          ),
      },
    },
    async () => {
      const res = await handleRequest(v1Request("/v1/route-for-dispatch/acc_1", "GET"), refusingClient());
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.params, { id: "acc_1" });
      assertEquals(body.request_id, res.headers.get("X-Postora-Request-Id"));
    },
  );
});

Deno.test("a path that matches no pattern stays a 404 even while other routes exist", async () => {
  await withTempRoute(
    { pattern: "/v1/route-a", methods: { GET: () => Promise.resolve(new Response("{}")) } },
    async () => {
      // Wrong segment count: not /v1/route-a, and nothing else matches.
      const res = await handleRequest(v1Request("/v1/route-a/extra", "GET"), refusingClient());
      assertEquals(res.status, 404);
      const body = await res.json();
      assertEquals(body.error.code, "resource_not_found");
      // Segment-count equality is the matcher's rule, checked at unit level too.
      assertEquals(resolveV1Route(V1_ROUTES, "/v1/route", "GET").kind, "not_found");
    },
  );
});

// ---------------------------------------------------------------------------
// T4 — envelope shape vs the DOCUMENT, read at run time. Hardcoding the
// required fields here would keep passing after someone edited the document,
// which is the exact drift this exists to catch.
// ---------------------------------------------------------------------------

Deno.test("the /v1 envelope satisfies V1ErrorObject's documented required fields", async () => {
  const required: string[] = doc.components.schemas.V1ErrorObject.required;
  assertEquals(
    [...required].sort(),
    ["code", "message", "request_id", "retryable"],
    "V1ErrorObject.required changed in docs/api/openapi.yaml — update this test consciously, " +
      "and update v1/errors.ts to match the new contract.",
  );
  const envelopeRequired: string[] = doc.components.schemas.V1ErrorEnvelope.required;
  assertEquals(envelopeRequired, ["error"], "V1ErrorEnvelope must require exactly {error}");

  const res = await handleRequest(v1Request("/v1/anything"), refusingClient());
  const body = await res.json();
  for (const field of required) {
    assertEquals(
      body.error[field] !== undefined,
      true,
      `documented required field "${field}" missing from the /v1 envelope`,
    );
  }
  assertEquals(doc.components.schemas.V1ErrorCode.enum.includes(body.error.code), true);
  assertEquals(typeof body.error.message, "string");
  assertEquals(typeof body.error.retryable, "boolean");
  assertEquals(typeof body.error.request_id, "string");
});

Deno.test("the envelope's policy table and the documented error-code enum are the same set", () => {
  const documented: string[] = doc.components.schemas.V1ErrorCode.enum;
  const table = Object.keys(V1_ERROR_POLICY);
  assertEquals(
    table.filter((c) => !documented.includes(c)),
    [],
    "v1/errors.ts expresses code(s) the document does not list — an undocumented code is a " +
      "contract a partner cannot branch on.",
  );
  assertEquals(
    documented.filter((c) => !table.includes(c)),
    [],
    "the document lists code(s) v1/errors.ts cannot express — every documented code must be " +
      "constructible through the single envelope builder.",
  );
});

// ---------------------------------------------------------------------------
// T5 — ALIAS COMPATIBILITY (plan Phase 2, "Alias compatibility criterion"):
// status and body semantics identical after normalising request_id. /v1 must
// not regress the surface already in production. Expected bodies are the
// alias's CURRENT shapes, pinned from the existing suites (suspension,
// limiterPolicy, contractConformance) — any change here is a regression.
// ---------------------------------------------------------------------------

/** Replace the dynamic correlation handle with a constant so deep-equality
 *  compares semantics, not this request's UUID. */
function normalized(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...body, request_id: "NORMALIZED" }));
}

/** What the alias door actually returns, narrowed to the fields these tests
 *  read. Untrusted JSON shapes stay `unknown`-friendly (§31) while the
 *  scenario asserts stay readable. */
interface AliasScenarioResult {
  status: number;
  body: {
    error?: { code?: string; message?: string; retryable?: boolean };
    request_id?: string;
    [field: string]: unknown;
  };
  headerRequestId: string | null;
}

async function aliasScenario(
  req: Request,
  opts: StubOptions = {},
): Promise<AliasScenarioResult> {
  const res = await handleRequest(req, () => stubClient(opts));
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headerRequestId: res.headers.get("X-Postora-Request-Id") };
}

Deno.test("the alias keeps its pre-authentication and method semantics, byte for byte after request_id normalisation", async () => {
  // GET to a non-/v1 path: the alias 405, BEFORE authentication.
  const notAllowed = await aliasScenario(new Request("https://partner.example/x", { method: "GET" }));
  assertEquals(notAllowed.status, 405);
  assertEquals(normalized(notAllowed.body), {
    success: false,
    error: { code: "method_not_allowed", message: "Use POST", retryable: false },
    request_id: "NORMALIZED",
  });

  // Missing credential and wrong-prefix credential: non-enumerable 401.
  const noKey = await aliasScenario(aliasPost("get_status", { "x-postora-key": "" }));
  assertEquals(noKey.status, 401);
  assertEquals(normalized(noKey.body), {
    success: false,
    error: { code: "invalid_key", message: "Invalid API key", retryable: false },
    request_id: "NORMALIZED",
  });
  const badPrefix = await aliasScenario(
    aliasPost("get_status", { "x-postora-key": "not-a-postora-key" }),
  );
  assertEquals(badPrefix.status, 401);
  assertEquals(badPrefix.body.error?.code, "invalid_key");

  // Key states.
  const revoked = await aliasScenario(
    aliasPost("get_status"), { keyRow: { ...KEY_ROW, revoked_at: "2020-01-01T00:00:00Z" } },
  );
  assertEquals(revoked.status, 401);
  assertEquals(revoked.body.error?.code, "key_revoked");
  const expired = await aliasScenario(
    aliasPost("get_status"), { keyRow: { ...KEY_ROW, expires_at: "2020-01-01T00:00:00Z" } },
  );
  assertEquals(expired.status, 401);
  assertEquals(expired.body.error?.code, "key_expired");

  // A failed key lookup is an internal error, not "invalid key". Pinned with
  // retryable:false because that is the alias's CURRENT verdict (its catch
  // computes retryable only for rate_limited / limiter_unavailable) — a known
  // inconsistency with its own inline internal_error paths, reported in the
  // task report, deliberately not "fixed" here.
  const lookupFailed = await aliasScenario(
    aliasPost("get_status"), { keyLookupError: { message: "connection reset" } },
  );
  assertEquals(lookupFailed.status, 500);
  assertEquals(lookupFailed.body.error?.code, "internal_error");
  assertEquals(lookupFailed.body.error?.retryable, false);

  // Routing and authorization inside the action protocol.
  const unknownAction = await aliasScenario(aliasPost("no_such_action"));
  assertEquals(unknownAction.status, 400);
  assertEquals(normalized(unknownAction.body), {
    success: false,
    error: { code: "unknown_action", message: "Unknown action: no_such_action", retryable: false },
    request_id: "NORMALIZED",
  });
  const noScope = await aliasScenario(
    aliasPost("list_templates"), { keyRow: { ...KEY_ROW, scopes: [] } },
  );
  assertEquals(noScope.status, 403);
  assertEquals(noScope.body.error?.code, "insufficient_scope");

  // The 0A safety suspension.
  const suspended = await aliasScenario(aliasPost("send_template"));
  assertEquals(suspended.status, 503);
  assertEquals(normalized(suspended.body), {
    success: false,
    error: {
      code: "temporarily_unavailable",
      message: "This action is temporarily suspended; see the Partner API changelog. " +
        "Retrying will not succeed until it is re-enabled",
      retryable: false,
    },
    request_id: "NORMALIZED",
  });

  // Success still stamps request_id, top level (the alias envelope, not v1's).
  const ok = await aliasScenario(aliasPost("get_status"));
  assertEquals(ok.status, 200);
  assertEquals(normalized(ok.body), {
    success: true,
    whatsapp_connected: true,
    phone_number_id: "phone-1",
    workspace_id: "ws-1",
    request_id: "NORMALIZED",
  });
  // And the alias's header/body correlation handle still agrees with itself.
  assertEquals(ok.headerRequestId, ok.body.request_id);

  // A non-/v1 subpath still reaches the alias door — only /v1 branches away.
  const otherSubpath = await aliasScenario(new Request(`${BASE}/other`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-postora-key": "pk_live_test" },
    body: JSON.stringify({ action: "get_status" }),
  }));
  assertEquals(otherSubpath.status, 200);
});

Deno.test("the alias keeps its limiter semantics: outage, refusal, and the CORS preflight", async () => {
  // Class B (list_templates) fails closed on a limiter outage.
  const outage = await handleRequest(
    aliasPost("list_templates"),
    () => stubClient({ limiter: { data: null, error: { message: "boom" } } }),
  );
  assertEquals(outage.status, 503);
  const outageBody = await outage.json();
  assertEquals(normalized(outageBody), {
    success: false,
    error: { code: "limiter_unavailable", message: "Rate limiter is unavailable; retry shortly", retryable: true },
    request_id: "NORMALIZED",
  });
  assertEquals(outage.headers.get("Retry-After"), "5");

  // A limiter refusal publishes the database's own window numbers.
  const refused = await handleRequest(
    aliasPost("list_templates"),
    () => stubClient({ limiter: { data: { allowed: false, remaining: 0, reset_seconds: 30 }, error: null } }),
  );
  assertEquals(refused.status, 429);
  const refusedBody = await refused.json();
  assertEquals(normalized(refusedBody), {
    success: false,
    error: { code: "rate_limited", message: "Rate limit exceeded", retryable: true },
    request_id: "NORMALIZED",
  });
  assertEquals(refused.headers.get("X-RateLimit-Limit"), "60");
  assertEquals(refused.headers.get("X-RateLimit-Remaining"), "0");
  assertEquals(refused.headers.get("X-RateLimit-Reset"), "30");
  assertEquals(refused.headers.get("Retry-After"), "30");

  // The preflight short-circuit still answers before any /v1 or auth logic
  // for ALIAS paths (only paths under /v1 branch away from it).
  const preflight = await handleRequest(
    new Request(BASE, { method: "OPTIONS" }),
    refusingClient(),
  );
  assertEquals(preflight.status, 200);
  assertEquals(await preflight.text(), "ok");
  assertEquals(preflight.headers.get("Access-Control-Allow-Origin"), "*");
});
