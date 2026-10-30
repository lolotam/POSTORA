/**
 * The HTTP boundary of the competitor tracking report.
 *
 * WHAT THIS SUITE PROVES
 *
 *   - POST only, plus the CORS preflight.
 *   - The body is strict: an unknown key, a key that does not belong to the
 *     action, a malformed body and an oversized body are all refusals.
 *   - The owner comes from the VERIFIED identity and never from the body, and
 *     a service credential is refused.
 *   - The verified bearer reaches the reader unchanged.
 *   - A missing entry and another owner's entry are the SAME 404.
 *   - A malformed upstream payload is a 502 and never an empty report.
 *   - Every dependency is bounded: a hanging read is refused inside the
 *     five second dependency ceiling, not at the fifteen second total.
 *   - The audit record carries no token and no request body.
 *   - The read succeeds from stored data: there is no collection gate and no
 *     provider call on this path.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  COMPETITOR_REPORT_MAX_BODY_BYTES,
  type CompetitorReport,
  type CompetitorReportRequest,
} from "./contracts.ts";
import {
  createCompetitorTrackingReportHandler,
  type CompetitorReportHandlerDeps,
  type CompetitorReportLogEvent,
} from "./handler.ts";
import { CompetitorReportStoreError } from "./reportStore.ts";

const BEARER = "synthetic.owner.bearer";
const USER_ID = "0f100001-0000-4000-8000-000000000001";

interface Harness {
  readonly handler: (request: Request) => Promise<Response>;
  readonly events: CompetitorReportLogEvent[];
  readonly reads: Array<{ request: CompetitorReportRequest; bearer: string }>;
}

function report(): CompetitorReport {
  return {
    version: 1,
    as_of: "2026-10-30T11:59:59.123456+00:00",
    capture_timezone: "Asia/Kuwait",
    quota: {
      max_tracked_competitors: 20,
      unlimited: false,
      tracked_active: 3,
      remaining: 17,
    },
    next_cursor: null,
    entries: [],
  };
}

function harness(
  overrides: Partial<CompetitorReportHandlerDeps> = {},
): Harness {
  const events: CompetitorReportLogEvent[] = [];
  const reads: Array<{ request: CompetitorReportRequest; bearer: string }> = [];

  const deps: CompetitorReportHandlerDeps = {
    authenticate: async () => ({ userId: USER_ID, isServiceRole: false }),
    readReport: async (request, bearer) => {
      reads.push({ request, bearer });
      return report();
    },
    nowFn: () => new Date("2026-10-30T12:00:00.000Z"),
    log: (event) => events.push(event),
    ...overrides,
  };

  return {
    handler: createCompetitorTrackingReportHandler(deps),
    events,
    reads,
  };
}

function request(
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
): Request {
  return new Request("https://api.postora.invalid/functions/v1/competitor-tracking-report", {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BEARER}`,
      ...headers,
    },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

/* -------------------------------------------------------------------------- */
/* The method and the preflight                                                  */
/* -------------------------------------------------------------------------- */

Deno.test("the preflight is a preflight and nothing else", async () => {
  const { handler, reads } = harness();

  const response = await handler(
    new Request("https://api.postora.invalid/functions/v1/competitor-tracking-report", {
      method: "OPTIONS",
    }),
  );

  assertEquals(response.status, 204);
  assertEquals(reads.length, 0);
});

Deno.test("a method other than POST is refused", async () => {
  const { handler, reads } = harness();

  const response = await handler(request({}, {}, "GET"));

  assertEquals(response.status, 405);
  assertEquals(response.headers.get("Allow"), "POST, OPTIONS");
  assertEquals(reads.length, 0);
  assertEquals((await payload(response)).error !== undefined, true);
});

/* -------------------------------------------------------------------------- */
/* The body                                                                      */
/* -------------------------------------------------------------------------- */

Deno.test("an unknown body key is refused", async () => {
  const { handler, reads } = harness();

  const response = await handler(
    request({ action: "list", state: "active", user_id: USER_ID }),
  );

  assertEquals(response.status, 400);
  assertEquals(reads.length, 0);
  assertEquals(await payload(response), { error: { code: "INVALID_REQUEST" } });
});

Deno.test("a key that does not belong to the action is refused", async () => {
  const { handler, reads } = harness();

  const response = await handler(
    request({
      action: "list",
      state: "active",
      watchlist_id: "0f1c0002-0000-4000-8000-000000000012",
    }),
  );

  assertEquals(response.status, 400);
  assertEquals(reads.length, 0);
});

Deno.test("a malformed body is refused", async () => {
  const { handler, reads } = harness();

  const response = await handler(
    new Request("https://api.postora.invalid/functions/v1/competitor-tracking-report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BEARER}`,
      },
      body: "{not json",
    }),
  );

  assertEquals(response.status, 400);
  assertEquals(reads.length, 0);
});

Deno.test("a body over the cap is refused", async () => {
  const { handler, reads } = harness();

  const response = await handler(
    request({ action: "list", state: "active", cursor: "x".repeat(COMPETITOR_REPORT_MAX_BODY_BYTES) }),
  );

  assertEquals(response.status, 413);
  assertEquals(reads.length, 0);
  assertEquals(await payload(response), { error: { code: "INVALID_REQUEST" } });
});

Deno.test("a limit outside the bounds is refused", async () => {
  const { handler } = harness();

  assertEquals((await handler(request({ action: "list", state: "active", limit: 0 }))).status, 400);
  assertEquals((await handler(request({ action: "list", state: "active", limit: 51 }))).status, 400);
  assertEquals(
    (await handler(request({ action: "list", state: "active", limit: 1.5 }))).status,
    400,
  );
});

Deno.test("the default limit is twenty and the maximum is fifty", async () => {
  const { handler, reads } = harness();

  await handler(request({ action: "list", state: "active" }));
  assertEquals(reads[0]!.request.limit, 20);

  await handler(request({ action: "list", state: "active", limit: 50 }));
  assertEquals(reads[1]!.request.limit, 50);
});

/* -------------------------------------------------------------------------- */
/* The identity                                                                  */
/* -------------------------------------------------------------------------- */

Deno.test("a request without a bearer is refused", async () => {
  const { handler, reads } = harness();

  const response = await handler(
    new Request("https://api.postora.invalid/functions/v1/competitor-tracking-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list", state: "active" }),
    }),
  );

  assertEquals(response.status, 401);
  assertEquals(reads.length, 0);
  assertEquals(await payload(response), { error: { code: "UNAUTHORIZED" } });
});

Deno.test("a service credential is refused", async () => {
  const { handler, reads } = harness({
    authenticate: async () => ({ userId: "", isServiceRole: true }),
  });

  const response = await handler(request({ action: "list", state: "active" }));

  assertEquals(response.status, 403);
  assertEquals(reads.length, 0);
  assertEquals(await payload(response), { error: { code: "UNAUTHORIZED" } });
});

Deno.test("an identity that cannot be verified is refused", async () => {
  const { handler, reads } = harness({
    authenticate: async () => {
      throw new Error("Unauthorized: invalid or expired token");
    },
  });

  const response = await handler(request({ action: "list", state: "active" }));

  assertEquals(response.status, 401);
  assertEquals(reads.length, 0);
});

/* -------------------------------------------------------------------------- */
/* The read                                                                      */
/* -------------------------------------------------------------------------- */

Deno.test("the verified bearer reaches the reader unchanged", async () => {
  const { handler, reads } = harness();

  const response = await handler(request({ action: "list", state: "active" }));

  assertEquals(response.status, 200);
  assertEquals(reads.length, 1);
  assertEquals(reads[0]!.bearer, BEARER);
});

Deno.test("a missing entry and another owner's entry are the same 404", async () => {
  const { handler } = harness({
    readReport: async () => {
      throw new CompetitorReportStoreError("not_found", "P0002");
    },
  });

  const response = await handler(
    request({
      action: "detail",
      watchlist_id: "0f1c0002-0000-4000-8000-000000000012",
      period_days: 7,
    }),
  );

  assertEquals(response.status, 404);
  assertEquals(await payload(response), { error: { code: "NOT_FOUND" } });
});

Deno.test("a malformed upstream payload is a 502 and never an empty report", async () => {
  const { handler } = harness({
    readReport: async () => {
      throw new Error("the projection is broken");
    },
  });

  const response = await handler(request({ action: "list", state: "active" }));

  assertEquals(response.status, 502);
  assertEquals(await payload(response), { error: { code: "REPORT_UNAVAILABLE" } });
});

Deno.test("an undeployed reader is a 502 and never an empty report", async () => {
  const { handler } = harness({
    readReport: async () => {
      throw new CompetitorReportStoreError("unavailable", "PGRST202");
    },
  });

  const response = await handler(request({ action: "list", state: "active" }));

  assertEquals(response.status, 502);
  assertEquals(await payload(response), { error: { code: "REPORT_UNAVAILABLE" } });
});

Deno.test("a refused request from the database is a 400", async () => {
  const { handler } = harness({
    readReport: async () => {
      throw new CompetitorReportStoreError("invalid", "22023");
    },
  });

  const response = await handler(request({ action: "list", state: "active" }));

  assertEquals(response.status, 400);
  assertEquals(await payload(response), { error: { code: "INVALID_REQUEST" } });
});

Deno.test("every dependency is bounded by the dependency ceiling", async () => {
  const { handler } = harness({
    readReport: (_request, _bearer, _now) => new Promise<CompetitorReport>(() => undefined),
  });

  const startedAt = Date.now();
  const response = await handler(request({ action: "list", state: "active" }));
  const elapsed = Date.now() - startedAt;

  assertEquals(response.status, 503);
  assertEquals(await payload(response), { error: { code: "REPORT_UNAVAILABLE" } });
  // The documented budgets, as literals: the five second dependency ceiling
  // and the fifteen second total budget of the whole request.
  assert(elapsed < 7_000);
  assert(elapsed < 15_000);
});

/* -------------------------------------------------------------------------- */
/* The audit record                                                              */
/* -------------------------------------------------------------------------- */

Deno.test("every refusal is audited", async () => {
  const { handler, events } = harness({
    readReport: async () => {
      throw new CompetitorReportStoreError("not_found", "P0002");
    },
  });

  await handler(request({ action: "list", state: "active" }));
  assertEquals(events.length, 1);
  assertEquals(events[0]!.outcome, "NOT_FOUND");
  assertEquals(events[0]!.status, 404);
  assertEquals(events[0]!.action, "list");
  assertEquals(events[0]!.user_id, USER_ID);
});

Deno.test("the audit record carries no token and no body", async () => {
  const { handler, events } = harness();

  await handler(request({ action: "list", state: "active" }));

  const serialized = JSON.stringify(events[0]);
  assertEquals(serialized.includes(BEARER), false);
  assertEquals(serialized.includes("Authorization"), false);
  assertEquals(serialized.includes("active"), false);
});

/* -------------------------------------------------------------------------- */
/* The read boundary                                                             */
/* -------------------------------------------------------------------------- */

Deno.test("the read succeeds from stored data and calls nothing else", async () => {
  const { handler, reads } = harness();

  const response = await handler(request({ action: "list", state: "active" }));
  const body = await payload(response);

  assertEquals(response.status, 200);
  // The endpoint has no provider call, no enqueue and no settings gate: the
  // read is the only thing it does, so the reader is called exactly once.
  assertEquals(reads.length, 1);
  assertEquals(body.version, 1);
  assertEquals(body.capture_timezone, "Asia/Kuwait");
  // One owner's private history is never stored by a cache.
  assertEquals(response.headers.get("Cache-Control"), "no-store");
});
