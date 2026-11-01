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
