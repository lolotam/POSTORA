// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";
import { type LimiterRiskClass } from "../../_shared/partnerApiMetering.ts";
import { withPartnerAuth } from "../v1/authenticated.ts";
import { withPlatformAuth } from "./authenticated.ts";
import { PLATFORM_ACTION_RISK, PLATFORM_ACTION_SCOPES } from "./policy.ts";

const PRESENTED = "pl_live_0123456789abcdef0123456789abcdef";
const WORKSPACE_KEY = "pk_live_0123456789abcdef0123456789abcdef";
const REQUEST_ID = "platform-auth-test";

async function rowFor(scopes = ["platform:workspaces.manage"], key = PRESENTED) {
  return {
    id: "platform-key-1",
    principal_id: "principal-1",
    key_prefix: key.slice(0, 12),
    key_hash: await hashPartnerKey(key),
    environment: "production",
    scopes,
    rate_limit_per_min: 30,
    expires_at: null as string | null,
    revoked_at: null as string | null,
  };
}

interface StubOptions {
  rows?: Record<string, unknown>[];
  lookupError?: { message: string };
  limiter?: { data: unknown; error: unknown };
}

// Only the Supabase boundary is stubbed. Filtering by the actual digest makes
// a prefix lookup or a fixture with an invented hash fail the success path.
function stub(opts: StubOptions = {}) {
  const lookups: string[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const inserts: unknown[] = [];
  const admin = {
    rpc(name: string, args: unknown) {
      rpcs.push({ name, args });
      return Promise.resolve(opts.limiter ?? {
        data: { allowed: true, remaining: 29, reset_seconds: 42 }, error: null,
      });
    },
    from(table: string) {
      const filters: [string, unknown][] = [];
      return {
        select() { lookups.push(table); return this; },
        eq(column: string, value: unknown) { filters.push([column, value]); return this; },
        is(column: string, value: unknown) { filters.push([column, value]); return this; },
        maybeSingle() {
          const matches = (opts.rows ?? []).filter((row) =>
            filters.every(([column, value]) => row[column] === value)
          );
          return Promise.resolve({
            data: matches.length === 1 ? matches[0] : null,
            error: opts.lookupError ?? (matches.length > 1 ? { message: "multiple rows" } : null),
          });
        },
        insert(row: unknown) { inserts.push(row); return Promise.resolve({ error: null }); },
      };
    },
  };
  return { admin, lookups, rpcs, inserts };
}

function request(key = PRESENTED, header = "authorization") {
  return new Request("https://partner.example/v1/platform/workspaces", {
    method: "POST",
    headers: { [header]: header === "authorization" ? `Bearer ${key}` : key },
  });
}

const ok = () => Promise.resolve(new Response("{}", { status: 200 }));

async function assertError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  const body = await res.json();
  assertEquals(body.error.code, code);
  assertEquals(body.error.request_id, REQUEST_ID);
  assertEquals(res.headers.get("X-Postora-Request-Id"), REQUEST_ID);
}

for (const header of ["authorization", "x-postora-key"]) {
  Deno.test(`scoped platform key via ${header} reaches handler with context and budget`, async () => {
    const row = await rowFor();
    // Same display prefix, different complete hash: both keys must coexist.
    const other = await rowFor([], PRESENTED.slice(0, -1) + "x");
    const { admin, rpcs } = stub({ rows: [row, other] });
    let reached = false;
    const route = withPlatformAuth("create_workspace", "C", (_req, ctx, params) => {
      reached = true;
      assertEquals(ctx.record.principalId, row.principal_id);
      assertEquals(ctx.record.id, row.id);
      assertEquals(ctx.requestId, REQUEST_ID);
      assertEquals(ctx.rateHeaders["X-RateLimit-Remaining"], "29");
      assertEquals(params, { workspaceId: "ws-1" });
      return ok();
    }, () => admin);
    const res = await route(request(PRESENTED, header), REQUEST_ID, { workspaceId: "ws-1" });
    assertEquals(res.status, 200);
    assertEquals(reached, true);
    assertEquals(res.headers.get("X-RateLimit-Limit"), "30");
    assertEquals(res.headers.get("X-RateLimit-Remaining"), "29");
    assertEquals(res.headers.get("X-RateLimit-Reset"), "42");
    assertEquals(res.headers.get("Retry-After"), null);
    assertEquals(rpcs, [{ name: "consume_partner_platform_rate", args: { p_key_id: row.id, p_limit: 30 } }]);
  });

  for (const door of ["platform", "workspace"]) {
    // The two doors read different header sets, and that asymmetry is the
    // contract, not an oversight.
    //
    // The platform door reads BOTH, so it recognises a misdirected workspace
    // key however it arrives and answers 404 without confirming the tier.
    //
    // The workspace door reads ONLY x-postora-key. openapi.yaml's
    // PartnerApiKey scheme says so outright -- "NOT `Authorization: Bearer`
    // -- that header is never read by the alias and does not exist as a key
    // transport" -- and this function runs behind a gateway that can attach
    // its own Authorization header, so reading it would break every existing
    // workspace call.
    //
    // A platform key sent to the workspace door as Bearer therefore presents
    // no credential at all, and gets the ordinary 401. That leaks nothing:
    // the answer is identical to sending no credential, so it still does not
    // confirm the platform tier exists.
    const workspaceDoorIgnoresHeader = door === "workspace" && header === "authorization";
    const expectedStatus = workspaceDoorIgnoresHeader ? 401 : 404;
    const expectedCode = workspaceDoorIgnoresHeader ? "invalid_key" : "resource_not_found";

    Deno.test(
      `wrong-tier key at ${door} door via ${header} returns ${expectedStatus} before lookup`,
      async () => {
        const { admin, lookups, rpcs, inserts } = stub();
        let reached = false;
        const handler = () => { reached = true; return ok(); };
        const route = door === "platform"
          ? withPlatformAuth("create_workspace", "C", handler, () => admin)
          : withPartnerAuth("list_accounts", "A", handler, () => admin);
        const res = await route(
          request(door === "platform" ? WORKSPACE_KEY : PRESENTED, header),
          REQUEST_ID,
          {},
        );
        await assertError(res, expectedStatus, expectedCode);
        assertEquals(reached, false);
        // Whichever answer it is, it must be reached WITHOUT a database
        // lookup: that is what makes the tier non-enumerable by timing.
        assertEquals(lookups, []);
        assertEquals(rpcs, []);
        assertEquals(inserts, []);
      },
    );
  }
}

Deno.test("the workspace door never reads Authorization, even with no x-postora-key", async () => {
  // Pins the contract directly. A gateway that attaches its own Authorization
  // header must not be able to authenticate a workspace call, and a valid
  // workspace key presented ONLY as Bearer must not work either.
  const { admin, lookups } = stub();
  let reached = false;
  const route = withPartnerAuth("list_accounts", "A", () => { reached = true; return ok(); }, () => admin);
  const req = new Request("https://x/v1/accounts", {
    headers: { authorization: `Bearer ${WORKSPACE_KEY}` },
  });
  const res = await route(req, REQUEST_ID, {});
  await assertError(res, 401, "invalid_key");
  assertEquals(reached, false);
  assertEquals(lookups, [], "no credential was presented, so nothing should be looked up");
});

// Credential boundaries: absent/unknown, missing or legacy scope, expiry,
// revocation, prefix environment, stored environment, failed database read.
for (const scenario of ["missing", "unknown", "scope", "legacy scope", "expired", "revoked", "staging prefix", "staging row", "missing environment", "lookup error"]) {
  Deno.test(`platform authentication refuses ${scenario} without running handler or limiter`, async () => {
    const row = await rowFor();
    let key = PRESENTED;
    if (scenario === "missing") key = "";
    if (scenario === "scope") row.scopes = ["platform:workspaces.read"];
    if (scenario === "legacy scope") row.scopes = ["whatsapp:template.send"];
    if (scenario === "expired") row.expires_at = "2000-01-01T00:00:00Z";
    if (scenario === "revoked") row.revoked_at = "2000-01-01T00:00:00Z";
    if (scenario === "staging prefix") key = PRESENTED.replace("pl_live_", "pl_test_");
    if (scenario === "staging row") row.environment = "staging";
    const stored: Record<string, unknown> = { ...row };
    if (scenario === "missing environment") delete stored.environment;
    const { admin, rpcs, lookups } = stub({
      rows: scenario === "unknown" ? [] : [stored],
      lookupError: scenario === "lookup error" ? { message: "private database failure" } : undefined,
    });
    let reached = false;
    const route = withPlatformAuth("create_workspace", "C", () => { reached = true; return ok(); }, () => admin);
    const res = await route(request(key), REQUEST_ID, {});
    const scopeFailure = scenario === "scope" || scenario === "legacy scope";
    await assertError(res, scopeFailure ? 403 : scenario === "lookup error" ? 500 : 401,
      scopeFailure ? "insufficient_scope" : scenario === "lookup error" ? "internal_error" : "invalid_key");
    assertEquals(reached, false);
    assertEquals(rpcs, []);
    if (scenario === "staging prefix" || scenario === "missing") assertEquals(lookups, []);
  });
}

const malformedResults = [null, [], [{ allowed: true, remaining: 29, reset_seconds: 42 }, {}],
  { allowed: "true" }, { allowed: true, remaining: 30, reset_seconds: 42 },
  { allowed: true, remaining: 29, reset_seconds: 0 }];
for (const risk of ["A", "B", "C"] as LimiterRiskClass[]) {
  Deno.test(`platform limiter outages and malformed results follow class ${risk} policy`, async () => {
    const row = await rowFor(["platform:workspaces.read"]);
    for (const limiter of [{ data: null, error: { message: "unavailable" } },
      ...malformedResults.map((data) => ({ data, error: null }))]) {
      const { admin } = stub({ rows: [row], limiter });
      let reached = false;
      const route = withPlatformAuth("list_platform_workspaces", risk, () => { reached = true; return ok(); }, () => admin);
      const res = await route(request(), REQUEST_ID, {});
      if (risk === "A") assertEquals(res.status, 200);
      else await assertError(res, 503, "limiter_unavailable");
      assertEquals(reached, risk === "A");
      for (const name of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]) {
        assertEquals(res.headers.get(name), null);
      }
    }
  });
}

Deno.test("platform limiter refusal publishes only database-computed reset and retry headers", async () => {
  for (const reset of [42, undefined]) {
    const { admin } = stub({ rows: [await rowFor()], limiter: {
      data: { allowed: false, remaining: 0, reset_seconds: reset }, error: null,
    } });
    let reached = false;
    const route = withPlatformAuth("create_workspace", "C", () => { reached = true; return ok(); }, () => admin);
    const res = await route(request(), REQUEST_ID, {});
    await assertError(res, 429, "rate_limited");
    assertEquals(reached, false);
    assertEquals(res.headers.get("X-RateLimit-Limit"), "30");
    assertEquals(res.headers.get("X-RateLimit-Remaining"), "0");
    assertEquals(res.headers.get("X-RateLimit-Reset"), reset === undefined ? null : "42");
    assertEquals(res.headers.get("Retry-After"), reset === undefined ? null : "42");
  }
});

Deno.test("platform handler failure is sanitized and retains successful limiter headers", async () => {
  const { admin } = stub({ rows: [await rowFor()] });
  const route = withPlatformAuth("create_workspace", "C", () => {
    throw new Error("private handler detail");
  }, () => admin);
  const res = await route(request(), REQUEST_ID, {});
  await assertError(res, 500, "internal_error");
  assertEquals(res.headers.get("X-RateLimit-Remaining"), "29");
});

Deno.test("platform door factory overrides wrapper factory", async () => {
  const { admin } = stub({ rows: [await rowFor()] });
  const route = withPlatformAuth("create_workspace", "C", ok, () => { throw new Error("wrong factory"); });
  assertEquals((await route(request(), REQUEST_ID, {}, () => admin)).status, 200);
});

Deno.test("platform policy has identical scope and risk action sets and unknown actions fail closed", async () => {
  assertEquals(Object.keys(PLATFORM_ACTION_SCOPES).sort(), Object.keys(PLATFORM_ACTION_RISK).sort());
  const { admin, rpcs } = stub({ rows: [await rowFor()] });
  const route = withPlatformAuth("unknown_action", "C", ok, () => admin);
  await assertError(await route(request(), REQUEST_ID, {}), 500, "internal_error");
  assertEquals(rpcs, []);
});
