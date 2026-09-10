// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parse } from "jsr:@std/yaml@1";
import { handleRequest } from "./index.ts";

// ---------------------------------------------------------------------------
// Deliverable 0.5 — RUNTIME CONTRACT TESTS
//
// The 0.8 drift gate proves docs/api/openapi.yaml does not CHANGE without
// someone deciding to. It says nothing about whether the document was ever
// TRUE. That is this file's entire job: it fails when the document and the
// running code disagree.
//
// A test that reads the OpenAPI file and asserts things about the YAML is not
// a contract test. Every assertion below reads a fact out of the document and
// checks it against the real handler.
//
// THESE TESTS EXERCISE THE ALIAS, NOT /v1. /v1 has no endpoints. The alias's
// error envelope differs from the documented /v1 envelope ON PURPOSE
// (decision D2): the alias emits {success:false, error:{...}, request_id} and
// /v1 will emit {error:{..., request_id}}. Assertions below are written
// against the ALIAS's actual shape; where that diverges from the document, the
// divergence is deliberate and is noted at the assertion.
//
// WHY THE DOCUMENT IS READ RATHER THAN HARDCODED: if this file hardcoded
// "x-postora-key" or the error-code list, it would keep passing after someone
// edited the document, which is the exact drift it exists to catch.
// ---------------------------------------------------------------------------

const DOC_PATH = new URL("../../../docs/api/openapi.yaml", import.meta.url);

// deno-lint-ignore no-explicit-any
const doc = parse(await Deno.readTextFile(DOC_PATH)) as any;

const DOCUMENTED_CODES: string[] = doc.components.schemas.V1ErrorCode.enum;
const DOCUMENTED_AUTH_HEADER: string = doc.components.securitySchemes.PartnerApiKey.name;

/**
 * Codes the document lists that these tests deliberately cannot reach, each
 * with the reason. This list is asserted to be EXACTLY the complement of the
 * reached set, so a newly added code cannot quietly join either side — an
 * unexplained gap is how the fourth undocumented code (unsupported_direct_qr)
 * survived until 0.7 went looking.
 *
 * Every reason here is the same root cause: `send_template` is withdrawn by
 * the 0A safety suspension, and the suspension is checked BEFORE the account
 * lookup, the idempotency claim, the quota reservation and any provider call.
 * Everything downstream of that gate is therefore dead code paths until
 * SEND_TEMPLATE_SUSPENDED is flipped — at which point these become reachable
 * and belong in the reached set.
 */
const UNREACHABLE_WHILE_SEND_IS_SUSPENDED: Record<string, string> = {
  invalid_request: "body validation for send_template, downstream of the suspension gate",
  missing_idempotency_key: "send-only requirement, downstream of the suspension gate",
  idempotency_conflict: "idempotency claim runs only for send actions",
  idempotency_in_progress: "idempotency claim runs only for send actions",
  idempotency_indeterminate: "idempotency settle runs only for send actions",
  quota_exceeded: "monthly quota is reserved only for send actions",
  payload_too_large: "upload-only; POST /v1/media is not reachable from the alias these tests drive",
  media_pending: "emitted by the /v1 media send gate (Phase 9.3); the alias these tests drive has no media surface",
  media_rejected: "emitted by the /v1 media send gate (Phase 9.3); the alias these tests drive has no media surface",
  account_not_connected: "account lookup is downstream of the suspension gate",
  account_needs_reauth: "account lookup is downstream of the suspension gate",
  outside_session_window: "emitted by whatsappPartnerOps during a real send",
  template_not_approved: "emitted by whatsappPartnerOps during a real send",
  invalid_recipient: "emitted by whatsappPartnerOps during a real send",
  meta_error: "emitted by whatsappPartnerOps from a Meta Graph response",
  unsupported_direct_qr: "emitted by whatsappPartnerOps for an evolution_qr account",
  // The hybrid-connector codes. Same shape of reason as media_pending's: they
  // are /v1 route codes, and the drives above exercise the ALIAS door plus the
  // two /v1 paths that need no key. Each is covered by its own route suite
  // (v1/connectors.test.ts, v1/tools.test.ts) rather than here.
  connector_type_not_connectable: "emitted by POST /v1/connectors/{type}/connect-link; the alias has no connector surface",
  connector_unavailable: "emitted by the /v1 connector paths when the connector service is unconfigured or unreachable",
  connection_inactive: "emitted by POST /v1/tools/execute when the tool's connection is not active",
  connector_tool_not_allowed: "emitted by POST /v1/tools/execute for a capability outside the registry allow-list",
  connector_write_not_allowed: "emitted by POST /v1/tools/execute for a data-changing capability the owner has not enabled",
  tool_not_found: "emitted by POST /v1/tools/execute for a tool or account outside the key's binding",
  tool_execution_failed: "emitted by POST /v1/tools/execute when the downstream call reports failure",
  tool_execution_timeout: "emitted by POST /v1/tools/execute when the 20 s execution budget expires",
};

const KEY_ROW = {
  id: "key-1",
  workspace_id: "ws-1",
  social_account_id: "acct-1",
  key_prefix: "pk_live_abcd",
  scopes: ["whatsapp:template.send", "whatsapp:templates.read"],
  rate_limit_per_min: 60,
  monthly_quota: null,
  expires_at: null,
  revoked_at: null,
};

const ACCOUNT_ROW = {
  id: "acct-1",
  user_id: "user-1",
  workspace_id: "ws-1",
  platform: "whatsapp",
  platform_user_id: "phone-1",
  access_token: "token",
  connection_mode: "cloud",
  is_active: true,
  needs_reauth: false,
  token_expires_at: null,
  account_metadata: { waba_id: "waba-1" },
};

interface StubOptions {
  keyRow?: unknown;
  /** Error object the partner_api_keys lookup returns, to reach internal_error. */
  keyLookupError?: unknown;
  /** What consume_partner_rate_v2 answers. `null` data models a limiter outage. */
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

function post(
  action: string,
  headers: Record<string, string> = { "x-postora-key": "pk_live_test" },
) {
  return new Request("https://partner.example/functions/v1/partner-api", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ action }),
  });
}

/** Drives the handler and returns the alias error code, or null on success. */
async function codeFrom(req: Request, opts: StubOptions = {}): Promise<string | null> {
  const res = await handleRequest(req, () => stubClient(opts));
  const body = await res.json().catch(() => ({}));
  return body?.error?.code ?? null;
}

// ---------------------------------------------------------------------------
// 1. Error-code coverage, in the honest direction.
// ---------------------------------------------------------------------------

Deno.test("every error code the handler actually emits is documented in the OpenAPI error component", async () => {
  const reached = new Set<string>();

  const add = async (req: Request, opts: StubOptions = {}) => {
    const code = await codeFrom(req, opts);
    if (code) reached.add(code);
  };

  // Pre-authentication: no key row is ever consulted.
  await add(new Request("https://partner.example/x", { method: "GET" }));
  await add(post("get_status", {}));                                    // no header at all
  await add(post("get_status", { "x-postora-key": "not-a-postora-key" })); // wrong prefix

  // The /v1 router's unmatched-path 404. resource_not_found is documented as
  // reachable precisely because the router emits it (deliverable 2.1); this
  // drive keeps it out of the unreached complement below.
  await add(
    new Request("https://partner.example/functions/v1/partner-api/v1/no-such-path", {
      method: "GET",
    }),
  );

  // The /v1 send route's capability refusal. `unsupported_capability` is
  // documented precisely because this route emits it (deliverable 3.6); the
  // drive keeps it out of the unreached complement below.
  await add(
    new Request("https://partner.example/functions/v1/partner-api/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-postora-key": "pk_live_test" },
      body: JSON.stringify({ type: "sticker", recipient_phone: "+10000000000" }),
    }),
  );

  // Authentication verdicts, one per key state.
  await add(post("get_status"), { keyRow: { ...KEY_ROW, revoked_at: "2020-01-01T00:00:00Z" } });
  await add(post("get_status"), { keyRow: { ...KEY_ROW, expires_at: "2020-01-01T00:00:00Z" } });
  await add(post("get_status"), { keyLookupError: { message: "connection reset" } });

  // Routing and authorization.
  await add(post("no_such_action"));
  await add(post("list_templates"), { keyRow: { ...KEY_ROW, scopes: [] } });

  // The 0A safety suspension.
  await add(post("send_template"));

  // Limiter verdicts. list_templates is risk class B, which fails CLOSED, so
  // both the refusal and the outage are reachable without a provider call.
  await add(post("list_templates"), {
    limiter: { data: { allowed: false, remaining: 0, reset_seconds: 30 }, error: null },
  });
  await add(post("list_templates"), { limiter: { data: null, error: { message: "boom" } } });

  const documented = new Set(DOCUMENTED_CODES);
  const undocumented = [...reached].filter((c) => !documented.has(c)).sort();

  assertEquals(
    undocumented,
    [],
    `The handler emits code(s) absent from docs/api/openapi.yaml: ${undocumented.join(", ")}. ` +
      "Add them to components.schemas.V1ErrorCode — an undocumented code is a contract a " +
      "partner cannot branch on.",
  );

  // The complement must be exactly the explained list. This is what stops an
  // unexplained gap: a new code is either reached above, or it carries a
  // written reason, and nothing may be silently absent from both.
  const unreachedButDocumented = [...documented].filter((c) => !reached.has(c)).sort();
  assertEquals(
    unreachedButDocumented,
    Object.keys(UNREACHABLE_WHILE_SEND_IS_SUSPENDED).sort(),
    "The set of documented-but-unreached codes changed. Either a test now reaches one " +
      "(remove it from UNREACHABLE_WHILE_SEND_IS_SUSPENDED) or a new code was documented " +
      "without a test or a stated reason.",
  );
});

/**
 * Source-side sweep. THE TEST ABOVE SAMPLES; THIS ONE ENUMERATES.
 *
 * Driving the handler proves the codes it was driven to. A new code on a
 * branch no test exercises -- a new provider failure inside list_templates,
 * say -- changes neither `reached` nor the document, and the sampled check
 * passes while the runtime emits something undocumented. Reported as P1 by the
 * Codex reviewer on #91, and correct: "every code the handler emits" is a
 * claim about the source, so it has to be checked against the source.
 */
const PARTNER_SURFACE = [
  "./index.ts",
  "./router.ts",
  "./v1/router.ts",
  "./v1/errors.ts",
  "./v1/connectors.ts",
  "./v1/tools.ts",
  "../_shared/partnerApiKeys.ts",
  "../_shared/partnerApiMetering.ts",
  "../_shared/partnerApiIdempotency.ts",
  "../_shared/partnerDispatch.ts",
  "../_shared/partnerDispatchIntents.ts",
  "../_shared/whatsappPartnerOps.ts",
];

/** Every shape by which this surface emits a typed code. If a new mechanism is
 *  introduced, the guard below fails rather than silently matching nothing. */
const EMIT_PATTERNS: RegExp[] = [
  // errorBody(<code>, <message>, <retryable>) -- the code is the FIRST argument.
  /\berrorBody\(\s*"([a-z][a-z0-9_]*)"/g,
  // new PartnerAuthError(<message>, <code>, <status>), and the WhatsAppOpError
  // variant -- the code is the SECOND argument, after a message that may itself
  // contain parentheses.
  /\bnew\s+(?:PartnerAuthError|WhatsAppOpError)\(\s*(?:[^,()]|\([^()]*\))*,\s*"([a-z][a-z0-9_]*)"/g,
  // super(<message>, <code>, <status>) -- RateLimitedError extends
  // PartnerAuthError and passes its code straight through.
  /\bsuper\(\s*"[^"]*"\s*,\s*"([a-z][a-z0-9_]*)"/g,
  // The /v1 envelope's policy table (v1/errors.ts): each entry opens with the
  // code literal on its own line, status/retryable on the next. The whole
  // table IS /v1's emit surface — every documented code is constructible
  // through it, so sweeping the entries sweeps the codes.
  /^ {2}([a-z][a-z0-9_]*): \{\n {4}status: \d{3}, retryable: (?:true|false),$/gm,
  // v1ErrorResponse(<code>, ...) and v1ErrorBody(<code>, ...) call sites -- a
  // future /v1 route emitting a code the table does not carry is caught here.
  /\bv1(?:Error(?:Response|Body))?\(\s*"([a-z][a-z0-9_]*)"/g,
];

/** The /v1 table pattern's own liveness alarm, separate from the >=15 guard:
 *  that guard counts the WHOLE surface, so the alias files alone can satisfy
 *  it while the v1 table pattern has quietly stopped matching (a reformat, a
 *  rename). This pins the v1 table's visibility directly. */
const MIN_V1_TABLE_CODES = 26;

Deno.test("every error code PRESENT IN THE SOURCE is documented, not merely the ones a test reaches", async () => {
  const found = new Set<string>();
  for (const rel of PARTNER_SURFACE) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    for (const re of EMIT_PATTERNS) {
      for (const m of src.matchAll(re)) found.add(m[1]);
    }
  }

  // Anti-false-green guard. A regex that stops matching finds nothing and
  // reports success, which is indistinguishable from a clean sweep -- the
  // exact failure this whole programme keeps rediscovering. If the emit shapes
  // are refactored, this fails and someone updates EMIT_PATTERNS.
  assertEquals(
    found.size >= 15,
    true,
    `The source sweep found only ${found.size} codes (${[...found].sort().join(", ")}). ` +
      "The emit shapes in EMIT_PATTERNS have probably drifted from the code. A sweep " +
      "that matches nothing looks exactly like a sweep that found no problems.",
  );

  // The same guard for the /v1 table pattern specifically: the >=15 check
  // above can stay green on the alias files alone while the v1 table entries
  // have stopped matching. The table has exactly 24 codes today; a count
  // below that means the pattern (or the table) changed shape.
  const v1ErrorsSrc = await Deno.readTextFile(new URL("./v1/errors.ts", import.meta.url));
  const v1TableCodes = [
    ...v1ErrorsSrc.matchAll(/^ {2}([a-z][a-z0-9_]*): \{$/gm),
  ].map((m) => m[1] as string);
  assertEquals(
    v1TableCodes.length >= MIN_V1_TABLE_CODES,
    true,
    `The v1 policy-table pattern found only ${v1TableCodes.length} entries ` +
      `(${v1TableCodes.join(", ")}). The table in v1/errors.ts or the pattern in ` +
      "EMIT_PATTERNS has changed shape — fix one of them; a table the sweep cannot " +
      "see is a table whose codes nobody is checking against the document.",
  );

  const documented = new Set(DOCUMENTED_CODES);
  const undocumented = [...found].filter((c) => !documented.has(c)).sort();
  assertEquals(
    undocumented,
    [],
    `These codes exist in the partner surface but not in docs/api/openapi.yaml: ` +
      `${undocumented.join(", ")}. Add them to components.schemas.V1ErrorCode.`,
  );
});

// ---------------------------------------------------------------------------
// 1b. The document's paths, page bounds and id prefixes match the router.
//
// Three comments in the source say a constant "MUST equal" something in the
// document. Until now nothing checked any of them, which makes them the same
// kind of claim as the error table that drifted four times: true when
// written, unenforced afterwards.
// ---------------------------------------------------------------------------

/** The Kong mount the document spells its paths with. */
const MOUNT = "/functions/v1/partner-api";

/**
 * Routes that are SERVED but deliberately not in `paths` yet, each with the
 * reason — asserted to be exactly the complement of the documented set, in
 * the same shape as UNREACHABLE_WHILE_SEND_IS_SUSPENDED above.
 *
 * This map is **empty by design** as of Phase 10.3: every served /v1 route
 * is now documented in `docs/api/openapi.yaml`. If a route is ever added
 * without documentation, list it here with a reason until the document
 * catches up; an undocumented route must never be silent.
 */
const SERVED_BUT_UNDOCUMENTED: Record<string, string> = {};

Deno.test("the document describes no path the router does not serve, and the gap is enumerated", async () => {
  const routerSrc = await Deno.readTextFile(new URL("./v1/router.ts", import.meta.url)) + "\n" +
    await Deno.readTextFile(new URL("./platform/router.ts", import.meta.url));
  const registered = [...routerSrc.matchAll(/^ {4}pattern: "([^"]+)",$/gm)].map((m) => m[1] as string);

  // Anti-false-green: a reformat of the route table would make this sweep
  // find nothing, and an empty sweep satisfies every assertion below.
  assertEquals(
    registered.length >= 7,
    true,
    `The route-table sweep found only ${registered.length} patterns (${registered.join(", ")}). ` +
      "V1_ROUTES or this pattern has changed shape — a sweep that matches nothing looks " +
      "exactly like a sweep that found no problems.",
  );

  const documented = Object.keys(doc.paths ?? {})
    .filter((p: string) => p.startsWith(MOUNT))
    .map((p: string) => p.slice(MOUNT.length));

  // The direction that would mislead a partner into writing a call that 404s.
  const phantom = documented.filter((p: string) => !registered.includes(p)).sort();
  assertEquals(
    phantom,
    [],
    `docs/api/openapi.yaml describes path(s) the router does not serve: ${phantom.join(", ")}.`,
  );

  // The other direction, as an enumerated gap rather than a silence.
  const undocumented = registered.filter((p) => !documented.includes(p)).sort();
  assertEquals(
    undocumented,
    Object.keys(SERVED_BUT_UNDOCUMENTED).sort(),
    "A served /v1 route is missing from docs/api/openapi.yaml without a reason. " +
      "Document it, or add it to SERVED_BUT_UNDOCUMENTED with why.",
  );
});

Deno.test("the page-size bounds the code enforces are the ones the document publishes", async () => {
  const src = await Deno.readTextFile(new URL("./v1/pagination.ts", import.meta.url));
  const constOf = (name: string) => {
    const m = src.match(new RegExp(`export const ${name} = (\\d+);`));
    assertEquals(m !== null, true, `${name} not found in pagination.ts`);
    return Number(m![1]);
  };
  const documented = doc.components.schemas.LimitParameter;
  // A partner reading the document and a partner reading a response must
  // agree about the page they get; clamping to bounds nobody published is
  // how a client's paging loop silently misses rows.
  assertEquals(constOf("LIMIT_MIN"), documented.minimum);
  assertEquals(constOf("LIMIT_MAX"), documented.maximum);
  assertEquals(constOf("LIMIT_DEFAULT"), documented.default);
});

Deno.test("every id prefix the code can emit is accepted by the document's PrefixedId pattern", async () => {
  const src = await Deno.readTextFile(new URL("./v1/ids.ts", import.meta.url));
  const listed = src.match(/export const ID_PREFIXES = \[([^\]]+)\]/);
  assertEquals(listed !== null, true, "ID_PREFIXES not found in ids.ts");
  const prefixes = [...listed![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1] as string);
  assertEquals(prefixes.length >= 7, true, `ID_PREFIXES sweep found only ${prefixes.length}`);

  const pattern = new RegExp(doc.components.schemas.PrefixedId.pattern);
  // A prefix the code emits but the pattern rejects would make the published
  // contract call Postora's own ids malformed.
  const rejected = prefixes.filter((p) => !pattern.test(`${p}_01H8X2K4Y9Z3Q7W6E5R4T3Y2U1`));
  assertEquals(
    rejected,
    [],
    `ids.ts can emit prefix(es) the document's PrefixedId pattern rejects: ${rejected.join(", ")}.`,
  );
});

// ---------------------------------------------------------------------------
// 2. The documented security scheme names the header the code actually reads.
// ---------------------------------------------------------------------------

Deno.test("the handler authenticates with the header the document declares, and with no other", async () => {
  // Read from the document, never hardcoded: hardcoding would keep this test
  // green after someone edited securitySchemes, which is the drift it exists
  // to catch.
  assertEquals(doc.components.securitySchemes.PartnerApiKey.type, "apiKey");
  assertEquals(doc.components.securitySchemes.PartnerApiKey.in, "header");

  // Presenting the documented header reaches the key lookup and gets past
  // authentication — proven by the verdict being about the ACTION, not the
  // credential.
  const accepted = await codeFrom(post("no_such_action", { [DOCUMENTED_AUTH_HEADER]: "pk_live_test" }));
  assertEquals(
    accepted,
    "unknown_action",
    `The documented auth header "${DOCUMENTED_AUTH_HEADER}" did not authenticate.`,
  );

  // The plausible alternative must NOT work. Without this, a build that also
  // accepted a bearer token would pass the assertion above.
  const bearer = await codeFrom(post("no_such_action", { authorization: "Bearer pk_live_test" }));
  assertEquals(
    bearer,
    "invalid_key",
    "A credential in Authorization: Bearer was accepted, but the document declares an " +
      `apiKey scheme in the "${DOCUMENTED_AUTH_HEADER}" header.`,
  );
});

// ---------------------------------------------------------------------------
// 3. Rate-limit header response classes — including the OMISSIONS.
//
// The omissions are a contract, not an oversight: fabricating a budget for a
// response where no limit was resolved leaks whether a key exists. A test that
// only checked presence would pass on a build that leaked a budget to an
// unauthenticated caller.
// ---------------------------------------------------------------------------

const RATE_HEADERS = ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"];

function headerState(res: Response): Record<string, string | null> {
  return Object.fromEntries(RATE_HEADERS.map((h) => [h, res.headers.get(h)]));
}

Deno.test("rate-limit headers are present, with the limiter's own numbers, once a budget is resolved", async () => {
  const res = await handleRequest(post("get_status"), () => stubClient());
  // Values come from consume_partner_rate_v2, never from a local clock — the
  // stub returns remaining 59 / reset 42 and those exact numbers must surface.
  assertEquals(res.headers.get("X-RateLimit-Limit"), String(KEY_ROW.rate_limit_per_min));
  assertEquals(res.headers.get("X-RateLimit-Remaining"), "59");
  assertEquals(res.headers.get("X-RateLimit-Reset"), "42");

  // Documented as exposed to browsers, or a browser caller cannot read them.
  const exposed = res.headers.get("Access-Control-Expose-Headers") ?? "";
  for (const h of RATE_HEADERS) {
    assertEquals(
      exposed.toLowerCase().includes(h.toLowerCase()),
      true,
      `${h} is not in Access-Control-Expose-Headers`,
    );
  }
});

Deno.test("no rate-limit headers on a pre-authentication failure: a budget would leak whether a key exists", async () => {
  // Wrong method — refused before any key is read.
  const notAllowed = await handleRequest(
    new Request("https://partner.example/x", { method: "GET" }),
    () => stubClient(),
  );
  assertEquals(notAllowed.status, 405);
  assertEquals(headerState(notAllowed), { "X-RateLimit-Limit": null, "X-RateLimit-Remaining": null, "X-RateLimit-Reset": null });

  // Unknown credential — the response must be indistinguishable from one for a
  // key that does not exist, so it can carry no budget either.
  const badKey = await handleRequest(
    post("get_status", { "x-postora-key": "pk_live_nope" }),
    () => stubClient({ keyRow: null }),
  );
  assertEquals(badKey.status, 401);
  assertEquals(headerState(badKey), { "X-RateLimit-Limit": null, "X-RateLimit-Remaining": null, "X-RateLimit-Reset": null });
});

Deno.test("no rate-limit headers on a CORS preflight: it presents no credential and consumes no budget", async () => {
  const res = await handleRequest(
    new Request("https://partner.example/x", { method: "OPTIONS" }),
    () => stubClient(),
  );
  assertEquals(res.status, 200);
  assertEquals(headerState(res), { "X-RateLimit-Limit": null, "X-RateLimit-Remaining": null, "X-RateLimit-Reset": null });
});

Deno.test("a limiter outage carries no fabricated budget, and answers with the documented retry advice", async () => {
  // Class B fails CLOSED. The response must not invent numbers for a window
  // that was never resolved.
  const res = await handleRequest(
    post("list_templates"),
    () => stubClient({ limiter: { data: null, error: { message: "boom" } } }),
  );
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error.code, "limiter_unavailable");
  // retryable:true distinguishes it from the 0A suspension, which is also 503
  // but retryable:false. The typed flag is the retry contract, not the status.
  assertEquals(body.error.retryable, true);
  assertEquals(headerState(res), { "X-RateLimit-Limit": null, "X-RateLimit-Remaining": null, "X-RateLimit-Reset": null });
});
