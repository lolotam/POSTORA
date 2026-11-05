import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createOwnedAnalyticsSyncHandler } from "./handler.ts";

function request(platform: "facebook" | "threads" | "all", extra: Record<string, unknown> = {}) {
  return new Request("https://owned-analytics.invalid", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "enqueue-daily", platform, ...extra }) });
}

Deno.test("disabled platforms perform no admission and return a truthful dispatch receipt", async () => {
  const visited: string[] = [];
  const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }),
    app: () => { throw new Error("Disabled collection must not read app credentials"); },
    rpc: (name, args) => {
      assertEquals(name, "next_meta_analytics_dispatch_target");
      assertEquals(args.p_start, false);
      visited.push(String(args.p_platform));
      return Promise.resolve({ data: { state: "disabled" }, error: null });
    }, audit: async () => true });
  const response = await handler(request("all"));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.action, "enqueue-daily");
  assertEquals(body.status, "disabled");
  assertEquals(body.counts, { visited: 0, queued: 0, refused: 0 });
  assertEquals(visited, ["facebook", "threads"]);
});

const STAMP = "2026-11-01T10:00:00.000Z";
const DIGEST = "c".repeat(64);
const ACCOUNT = "c2000000-0000-4000-8000-000000000001";
const OWNER = "c1000000-0000-4000-8000-000000000001";
const authority = { platform_user_id: "793001", credential_generation: 1, token_expires_at: null };
const credential = { account_id: ACCOUNT, user_id: OWNER, authority, access_token: "fixture-op", permission_token: "fixture-op" };
const ticket = { platform: "threads", due_on: "2026-11-01", policy_digest: DIGEST, round: 1, after_account_id: null, account_id: ACCOUNT };
const FOREIGN_APP_TOKEN_ERROR = { type: "OAuthException", code: 100,
  message: "(#100) The App_id in the input_token did not match the Viewing App" };

Deno.test("the shared 50-target cap yields to an unstarted platform on the next invocation", async () => {
  const positions = { facebook: 0, threads: 0 };
  const rounds = { facebook: 0, threads: 0 };
  const committed = new Set<string>();
  const id = (platform: string, index: number) => `${platform === "facebook" ? "c3" : "c4"}000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }),
    app: () => { throw new Error("A current grant does not need another provider request"); }, audit: async () => true,
    rpc: (name, args) => {
      if (name === "next_meta_analytics_dispatch_target") {
        const platform = args.p_platform as "facebook" | "threads";
        if (args.p_start && (rounds[platform] === 0 || positions[platform] === 50)) { rounds[platform]++; positions[platform] = 0; }
        if (!rounds[platform]) return Promise.resolve({ data: { state: "not_started" }, error: null });
        if (positions[platform] === 50) return Promise.resolve({ data: { state: "complete", refused_count: 0, round: rounds[platform], served_at: STAMP }, error: null });
        return Promise.resolve({ data: { state: "target", served_at: STAMP, ticket: { ...ticket, platform, round: rounds[platform],
          after_account_id: positions[platform] ? id(platform, positions[platform] - 1) : null, account_id: id(platform, positions[platform]) } }, error: null });
      }
      assertEquals(name, "commit_meta_analytics_dispatch_target");
      const selected = args.p_ticket as typeof ticket;
      const platform = selected.platform as "facebook" | "threads";
      committed.add(`${platform}:${selected.account_id}`);
      positions[platform]++;
      return Promise.resolve({ data: { state: "advanced", outcome: "queued", complete: positions[platform] === 50, refused_count: 0 }, error: null });
    } });
  const first = await (await handler(request("all"))).json();
  assertEquals(first.counts, { visited: 50, queued: 50, refused: 0 });
  assertEquals(first.status, "partial");
  assertEquals(positions, { facebook: 50, threads: 0 });
  const second = await (await handler(request("all"))).json();
  assertEquals(second.counts, { visited: 50, queued: 50, refused: 0 });
  assertEquals(second.status, "complete");
  assertEquals(positions, { facebook: 50, threads: 50 });
  assertEquals(committed.size, 100);
});

Deno.test("an unknown commit stops the invocation without retrying or claiming a receipt", async () => {
  let writes = 0;
  let committed = false;
  const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => null, audit: async () => true,
    rpc: (name) => {
      if (name === "next_meta_analytics_dispatch_target") return Promise.resolve({ data: { state: "target", ticket, served_at: STAMP }, error: null });
      writes++;
      committed = true;
      return Promise.resolve({ data: null, error: { code: "57014", message: "Unknown response after a synthetic commit" } });
    } });
  const response = await handler(request("threads"));
  const body = await response.json();
  assertEquals(response.status, 503);
  assertEquals(body.reason, "storage_unavailable");
  assertEquals(body.counts, { visited: 1, queued: 0, refused: 0 });
  assertEquals(writes, 1);
  assertEquals(committed, true);
});

Deno.test("dispatch uses actual admission and leaves throttled or unknown work resumable", async (test) => {
  for (const scenario of ["normal", "permission_missing", "rate_limited", "unknown_observation", "stale_commit"] as const) {
    await test.step(scenario, async () => {
      let commits = 0;
      let observes = 0;
      let providerCalls = 0;
      const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "790001", secret: "fixture-app" }), audit: async () => true,
        rpc: (name, args) => {
          if (name === "next_meta_analytics_dispatch_target") return Promise.resolve({ data: { state: "target", ticket, served_at: STAMP }, error: null });
          if (name === "commit_meta_analytics_dispatch_target") {
            commits++;
            if (commits === 1) return Promise.resolve({ data: { state: "needs_admission" }, error: null });
            if (scenario === "stale_commit" && commits === 2) return Promise.resolve({ data: null, error: { code: "MAH04", message: "Synthetic stale dispatch ticket" } });
            assertEquals(args.p_outcome, scenario === "permission_missing" ? "refused" : "enqueue");
            return Promise.resolve({ data: { state: "advanced", outcome: scenario === "permission_missing" ? "refused" : "queued", complete: true,
              refused_count: scenario === "permission_missing" ? 1 : 0 }, error: null });
          }
          if (name === "read_threads_analytics_admission_credential") return Promise.resolve({ data: credential, error: null });
          assertEquals(name, "observe_threads_analytics_permissions");
          observes++;
          return Promise.resolve(scenario === "unknown_observation" ? { data: null, error: { code: "57014", message: "fixture-op" } }
            : { data: { account_id: ACCOUNT, authority, state: "verified" }, error: null });
        }, fetch: async (input) => {
          providerCalls++;
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (scenario === "rate_limited") return Response.json({ error: { code: 190 } }, { status: 429 });
          return Response.json(url.pathname.endsWith("debug_token") ? { data: { is_valid: true, user_id: authority.platform_user_id,
            scopes: scenario === "permission_missing" ? ["threads_basic"] : ["threads_basic", "threads_manage_insights"] } }
            : { id: authority.platform_user_id });
        } });
      const response = await handler(request("threads"));
      const body = await response.json();
      assertEquals(commits, ["rate_limited", "unknown_observation"].includes(scenario) ? 1 : 2);
      assertEquals(response.status, scenario === "unknown_observation" ? 503 : 200);
      assertEquals(body.status, scenario === "normal" ? "complete" : scenario === "unknown_observation" ? "unavailable" : "partial");
      assertEquals(body.counts.queued, scenario === "normal" ? 1 : 0);
      assertEquals(body.counts.refused, scenario === "permission_missing" ? 1 : 0);
      assertEquals(observes, scenario === "rate_limited" ? 0 : 1);
      assertEquals(providerCalls, scenario === "rate_limited" ? 1 : 2);
    });
  }
});

Deno.test("malformed configuration is unavailable and a caller cannot choose dispatch position", async (test) => {
  const unavailable = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => null, audit: async () => true,
    rpc: () => Promise.resolve({ data: null, error: { code: "MAH05", message: "fixture-app" } }) });
  const response = await unavailable(request("threads"));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).reason, "configuration_unavailable");
  for (const extra of [{ user_id: OWNER }, { limit: 1000 }, { due_on: "2026-10-31" }, { accountId: ACCOUNT }]) {
    await test.step(JSON.stringify(extra), async () => {
      let calls = 0;
      const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => null, audit: async () => true,
        rpc: () => { calls++; throw new Error("Untrusted dispatch must not read state"); } });
      assertEquals((await handler(request("all", extra))).status, 400);
      assertEquals(calls, 0);
    });
  }
});

Deno.test("transient or undecodable admission leaves the durable dispatch target resumable", async (test) => {
  for (const stage of ["debug_token", "me"]) for (const failure of ["transport", "server_error", "transient_error", "transient_permission", "transient_auth", "transient_app_mismatch", "invalid_response"]) {
    await test.step(`${stage}: ${failure}`, async () => {
      let commits = 0, observations = 0;
      const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "790001", secret: "fixture-app" }), audit: async () => true,
        rpc: async (name) => {
          if (name === "next_meta_analytics_dispatch_target") return { data: { state: "target", ticket, served_at: STAMP }, error: null };
          if (name === "commit_meta_analytics_dispatch_target") { commits++; return { data: { state: "needs_admission" }, error: null }; }
          if (name === "record_meta_analytics_admission_failure") return { data: { state: "pending", attempts: 1 }, error: null };
          if (name === "read_threads_analytics_admission_credential") return { data: credential, error: null };
          observations++;
          throw new Error("Failed provider verification must not persist a grant");
        }, fetch: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith(`/${stage}`)) {
            if (failure === "transport") throw new TypeError("Synthetic network outage");
            if (failure === "server_error") return Response.json({ error: { code: 2 } }, { status: 503 });
            if (failure === "transient_error") return Response.json({ error: { code: 2, is_transient: true } }, { status: 400 });
            if (failure === "transient_permission") return Response.json({ error: { code: 200, is_transient: true } }, { status: 400 });
            if (failure === "transient_auth") return Response.json({ error: { code: 190, is_transient: true } }, { status: 400 });
            if (failure === "transient_app_mismatch") return Response.json({ error: { ...FOREIGN_APP_TOKEN_ERROR, is_transient: true } }, { status: 500 });
            return Response.json({ unexpected: true });
          }
          return Response.json({ data: { is_valid: true, user_id: authority.platform_user_id, scopes: ["threads_basic", "threads_manage_insights"] } });
        } });
      const response = await handler(request("threads"));
      const receipt = await response.json();
      assertEquals(response.status, 503);
      assertEquals(receipt.status, "unavailable");
      assertEquals(receipt.counts, { visited: 1, queued: 0, refused: 0 });
      assertEquals(commits, 1);
      assertEquals(observations, 0);
    });
  }
});

Deno.test("credential rotation during admission leaves the dispatch ticket uncommitted", async (test) => {
  for (const stage of ["permit", "observation"] as const) await test.step(stage, async () => {
    let commits = 0, reads = 0;
    const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "790001", secret: "fixture-app" }), audit: async () => true,
      rpc: async (name) => {
        if (name === "next_meta_analytics_dispatch_target") return { data: { state: "target", ticket, served_at: STAMP }, error: null };
        if (name === "commit_meta_analytics_dispatch_target") { commits++; return { data: { state: "needs_admission" }, error: null }; }
        if (name === "read_threads_analytics_admission_credential") {
          reads++;
          if (stage !== "permit" || reads < 3) return { data: credential, error: null };
        }
        return { data: null, error: { code: "MAH04" } };
      }, fetch: async (input) => Response.json(String(input).includes("debug_token") ? { data: {
        is_valid: true, user_id: authority.platform_user_id, scopes: ["threads_basic", "threads_manage_insights"],
      } } : { id: authority.platform_user_id }) });
    const response = await handler(request("threads"));
    const receipt = await response.json();
    assertEquals(response.status, 200);
    assertEquals(receipt.status, "partial");
    assertEquals(receipt.reason, "dispatch_changed");
    assertEquals(receipt.counts, { visited: 1, queued: 0, refused: 0 });
    assertEquals(commits, 1);
  });
});

Deno.test("known permission and auth refusals advance without fabricated observations", async (test) => {
  for (const providerError of [{ code: 10 }, { code: 200 }, { code: 190 }, { code: 100, error_subcode: 463 }])
    for (const stage of ["debug_token", "me"]) await test.step(`${JSON.stringify(providerError)}: ${stage}`, async () => {
    let commits = 0;
    const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "790001", secret: "fixture-app" }), audit: async () => true,
      rpc: async (name, args) => {
        if (name === "next_meta_analytics_dispatch_target") return { data: { state: "target", ticket, served_at: STAMP }, error: null };
        if (name === "read_threads_analytics_admission_credential") return { data: credential, error: null };
        assertEquals(name, "commit_meta_analytics_dispatch_target");
        if (++commits === 1) return { data: { state: "needs_admission" }, error: null };
        assertEquals(args.p_outcome, "refused");
        assertEquals(args.p_reason, [10, 200].includes(providerError.code) ? "permission_missing" : "reauth_required");
        return { data: { state: "advanced", outcome: "refused", complete: true, refused_count: 1 }, error: null };
      }, fetch: async (input) => String(input).includes(stage) ? Response.json({ error: providerError }, { status: 400 })
        : Response.json({ data: { is_valid: true, user_id: authority.platform_user_id, scopes: ["threads_basic", "threads_manage_insights"] } }) });
    const response = await handler(request("threads"));
    assertEquals(response.status, 200);
    assertEquals((await response.json()).counts, { visited: 1, queued: 0, refused: 1 });
  });
});

// Production 2026-11-04: Threads tokens issued before THREADS_APP_ID changed kept every
// dispatch target "admission_unavailable" because this HTTP 500 read as transient.
Deno.test("a token minted by another Meta app refuses as app_mismatch instead of retrying", async () => {
  let commits = 0;
  const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "790001", secret: "fixture-app" }), audit: async () => true,
    rpc: async (name, args) => {
      if (name === "next_meta_analytics_dispatch_target") return { data: { state: "target", ticket, served_at: STAMP }, error: null };
      if (name === "read_threads_analytics_admission_credential") return { data: credential, error: null };
      assertEquals(name, "commit_meta_analytics_dispatch_target");
      if (++commits === 1) return { data: { state: "needs_admission" }, error: null };
      assertEquals(args.p_outcome, "refused");
      assertEquals(args.p_reason, "app_mismatch");
      return { data: { state: "advanced", outcome: "refused", complete: true, refused_count: 1 }, error: null };
    }, fetch: async (input) => String(input).includes("debug_token") ? Response.json({ error: FOREIGN_APP_TOKEN_ERROR }, { status: 500 })
      : Response.json({ id: authority.platform_user_id }) });
  const response = await handler(request("threads"));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).counts, { visited: 1, queued: 0, refused: 1 });
});

Deno.test("persisted admission failures release the next account without reporting collection success", async () => {
  let attempts = 0, advanced = false;
  const attemptIds = new Set<unknown>();
  const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "790001", secret: "fixture-app" }), audit: async () => true,
    rpc: async (name, args) => {
      if (name === "next_meta_analytics_dispatch_target") return { data: { state: "target", ticket: advanced
        ? { ...ticket, account_id: "c2000000-0000-4000-8000-000000000002", after_account_id: ACCOUNT } : ticket, served_at: STAMP }, error: null };
      if (name === "commit_meta_analytics_dispatch_target") return { data: advanced
        ? { state: "advanced", outcome: "queued", complete: true, refused_count: 1 } : { state: "needs_admission" }, error: null };
      if (name === "read_threads_analytics_admission_credential") return { data: credential, error: null };
      assertEquals(name, "record_meta_analytics_admission_failure");
      assertEquals(args.p_reason, "provider_unavailable");
      attemptIds.add(args.p_attempt_id);
      attempts++;
      advanced = attempts === 3;
      return { data: advanced ? { state: "advanced", outcome: "refused", complete: false, refused_count: 1 }
        : { state: "pending", attempts }, error: null };
    }, fetch: async () => Response.json({ error: { code: 2 } }, { status: 503 }) });
  for (const expected of [503, 503, 200]) {
    const response = await handler(request("threads"));
    assertEquals(response.status, expected);
    if (expected === 200) {
      const body = await response.json();
      assertEquals(body.status, "partial");
      assertEquals(body.reason, "admission_unavailable");
      assertEquals(body.counts, { visited: 1, queued: 0, refused: 1 });
    }
  }
  assertEquals(attemptIds.size, 3);
  const next = await (await handler(request("threads"))).json();
  assertEquals(next.counts, { visited: 1, queued: 1, refused: 0 });
  assertEquals(next.status, "partial", "A prior refused admission cannot become a successful due date");
});

Deno.test("unknown store contracts never consume a provider failure attempt", async () => {
  let attempts = 0;
  const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "790001", secret: "fixture-app" }), audit: async () => true,
    rpc: async (name) => {
      if (name === "next_meta_analytics_dispatch_target") return { data: { state: "target", ticket, served_at: STAMP }, error: null };
      if (name === "commit_meta_analytics_dispatch_target") return { data: { state: "needs_admission" }, error: null };
      if (name === "read_threads_analytics_admission_credential") return { data: {}, error: null };
      attempts++;
      throw new Error("An unknown store outcome must stop before another write");
    }, fetch: async () => { throw new Error("Unknown credentials cannot reach Meta"); } });
  const response = await handler(request("threads"));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).reason, "invalid_contract");
  assertEquals(attempts, 0);
});

Deno.test("a concurrent verified grant resumes dispatch and preserves round completion", async (test) => {
  for (const complete of [true, false]) for (const refusedCount of [0, 1]) await test.step(`complete=${complete}, prior refusals=${refusedCount}`, async () => {
    let visits = 0, commits = 0, failureWrites = 0;
    const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "790001", secret: "fixture-app" }), audit: async () => true,
      rpc: async (name) => {
        if (name === "next_meta_analytics_dispatch_target") {
          visits++;
          return { data: { state: "target", ticket: visits === 1 ? ticket
            : { ...ticket, account_id: "c2000000-0000-4000-8000-000000000002", after_account_id: ACCOUNT }, served_at: STAMP }, error: null };
        }
        if (name === "commit_meta_analytics_dispatch_target") {
          commits++;
          return { data: commits === 1 ? { state: "needs_admission" }
            : { state: "advanced", outcome: "queued", complete: true, refused_count: refusedCount }, error: null };
        }
        if (name === "read_threads_analytics_admission_credential") return { data: credential, error: null };
        assertEquals(name, "record_meta_analytics_admission_failure");
        failureWrites++;
        return { data: { state: "advanced", outcome: "queued", complete, refused_count: refusedCount }, error: null };
      }, fetch: async () => Response.json({ error: { code: 2 } }, { status: 503 }) });
    const response = await handler(request("threads"));
    const body = await response.json();
    assertEquals(response.status, 200);
    assertEquals(body.reason, null, "A verified queued receipt is not unavailable admission");
    assertEquals(body.status, refusedCount ? "partial" : "complete");
    assertEquals(body.counts, { visited: complete ? 1 : 2, queued: complete ? 1 : 2, refused: 0 });
    assertEquals([visits, commits, failureWrites], [complete ? 1 : 2, complete ? 1 : 2, 1]);
  });
});

Deno.test("an unacknowledged failure-counter write stops before advancing or visiting another target", async (test) => {
  for (const failure of ["lost_response", "invalid_receipt", "unexpected_admission"] as const) await test.step(failure, async () => {
    let visited = 0, commits = 0, failureWrites = 0;
    const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "790001", secret: "fixture-app" }), audit: async () => true,
      rpc: async (name) => {
        if (name === "next_meta_analytics_dispatch_target") { visited++; return { data: { state: "target", ticket, served_at: STAMP }, error: null }; }
        if (name === "commit_meta_analytics_dispatch_target") { commits++; return { data: { state: "needs_admission" }, error: null }; }
        if (name === "read_threads_analytics_admission_credential") return { data: credential, error: null };
        assertEquals(name, "record_meta_analytics_admission_failure");
        failureWrites++;
        return failure === "lost_response" ? { data: null, error: { code: "57014" } }
          : { data: failure === "invalid_receipt" ? { state: "pending", attempts: 3 } : { state: "needs_admission" }, error: null };
      }, fetch: async () => Response.json({ error: { code: 2 } }, { status: 503 }) });
    const response = await handler(request("threads"));
    const body = await response.json();
    assertEquals(response.status, 503);
    assertEquals(body.reason, failure === "lost_response" ? "storage_unavailable" : "invalid_contract");
    assertEquals(body.counts, { visited: 1, queued: 0, refused: 0 });
    assertEquals([visited, commits, failureWrites], [1, 1, 1]);
  });
});

Deno.test("caller abort during provider admission never consumes a failure attempt", async () => {
  let commits = 0, failureWrites = 0;
  const controller = new AbortController();
  const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "790001", secret: "fixture-app" }), audit: async () => true,
    rpc: async (name) => {
      if (name === "next_meta_analytics_dispatch_target") return { data: { state: "target", ticket, served_at: STAMP }, error: null };
      if (name === "commit_meta_analytics_dispatch_target") { commits++; return { data: { state: "needs_admission" }, error: null }; }
      if (name === "read_threads_analytics_admission_credential") return { data: credential, error: null };
      failureWrites++;
      throw new Error("An aborted provider call cannot write an admission failure");
    }, fetch: async () => { controller.abort(); throw new DOMException("Synthetic caller abort", "AbortError"); } });
  const response = await handler(new Request(request("threads"), { signal: controller.signal }));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).counts, { visited: 1, queued: 0, refused: 0 });
  assertEquals([commits, failureWrites], [1, 0]);
});
