import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hashRequest } from "../_shared/partnerApiIdempotency.ts";

const ORIGIN = "https://threads-image-fixture.invalid";
const OWNER = "11000000-0000-4000-8000-000000000001";
const THREADS_ACCOUNT = "22000000-0000-4000-8000-000000000001";
const FACEBOOK_ACCOUNT = "22000000-0000-4000-8000-000000000002";
const POST = "33000000-0000-4000-8000-000000000001";
const IMAGE_ROW = "44000000-0000-4000-8000-000000000001";
const SERVICE = "fixture-service";
const CONTAINER = "fixture-image-container";
const LEASE = "2027-01-01T00:03:00.000Z";
type Handler = (request: Request) => Response | Promise<Response>;
type Row = {
  id: string;
  post_id: string;
  social_account_id: string;
  platform: string;
  status: string;
  platform_post_id: string | null;
  platform_post_url: string | null;
  error_message: string | null;
  response_data: Record<string, unknown>;
};
type Account = {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string;
  access_token: string;
  refresh_token: null;
  is_active: boolean;
  auth_provider: string;
  updated_at: string;
  account_metadata: Record<string, unknown>;
};

function contentFence(post: Record<string, unknown>) {
  const metadata = { ...((post.metadata as Record<string, unknown> | null) ?? {}) };
  delete metadata.pinterest_post_type;
  return {
    user_id: post.user_id,
    caption: post.caption,
    media_file_ids: post.media_file_ids,
    metadata,
    platforms: post.platforms,
    scheduled_at: post.scheduled_at ?? null,
    publish_requested_at: post.publish_requested_at ?? null,
    source: post.source ?? null,
  };
}

function deferred(responseData: Record<string, unknown>) {
  return responseData.deferred as Record<string, unknown>;
}

function matchesPostFilters(post: Record<string, unknown>, url: URL): boolean {
  for (const [column, raw] of url.searchParams) {
    if (column === "select") continue;
    const match = raw.match(/^(eq|is)\.(.*)$/);
    if (!match) continue;
    const actual = post[column];
    const expected = match[2];
    if (expected === "null") {
      if (actual != null) return false;
    } else if (typeof actual === "object" && actual !== null) {
      if (JSON.stringify(actual) !== expected) return false;
    } else if (String(actual) !== expected) return false;
  }
  return true;
}

function matchesPath(row: Row, path: string, expected: string): boolean {
  const parts = path.split("->");
  let value: unknown = row;
  for (const part of parts) {
    const key = part.replace(/>/g, "");
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }
  const normalized = expected === "null" ? null : expected;
  return (value ?? null) === normalized;
}

Deno.test("registered process-post durably completes single-image Threads containers", async (test) => {
  const previousFetch = globalThis.fetch;
  const previousServe = Deno.serve;
  const previousNow = Date.now;
  const environment = new Map(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"].map((key) => [key, Deno.env.get(key)]));
  Deno.env.set("SUPABASE_URL", ORIGIN);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
  Deno.env.set("SUPABASE_ANON_KEY", "fixture-anon");
  let handler: Handler | undefined;
  let clock = 0;
  Date.now = () => clock;

  let post: Record<string, unknown>;
  let accounts: Account[];
  let rows: Row[];
  let logs: Record<string, unknown>[];
  let providerStatuses: Array<Record<string, unknown> | Error>;
  let checkpointMode: "ok" | "error" | "null" | "lost";
  let publishMode: "success" | "timeout" | "rejected";
  let createDuration = 0;
  let statusHook: (() => void) | null = null;
  let checkpointHook: (() => void) | null = null;
  let parentReadError = false;
  let successSettlementFails = false;
  let creates = 0;
  let statusReads = 0;
  let publishes = 0;
  let settlements = 0;
  let outbox = 0;
  const unexpected: string[] = [];

  const threadsAccount = (): Account => ({
    id: THREADS_ACCOUNT,
    user_id: OWNER,
    platform: "threads",
    platform_user_id: "fixture-threads-user",
    platform_username: "fixture",
    access_token: "fixture-provider-token",
    refresh_token: null,
    is_active: true,
    auth_provider: "native",
    updated_at: "2026-01-01T00:00:00.000Z",
    account_metadata: {},
  });
  const facebookAccount = (): Account => ({
    ...threadsAccount(),
    id: FACEBOOK_ACCOUNT,
    platform: "facebook",
    platform_user_id: "fixture-facebook-user",
  });

  function reset() {
    clock = 0;
    post = {
      id: POST,
      user_id: OWNER,
      caption: "Synthetic image caption",
      status: "pending",
      platforms: ["threads"],
      media_file_ids: ["image-a"],
      metadata: { selected_account_ids: [THREADS_ACCOUNT] },
      scheduled_at: null,
      publish_requested_at: null,
      source: "manual",
      processing_started_at: null,
      posted_at: null,
    };
    accounts = [threadsAccount()];
    rows = [];
    logs = [];
    providerStatuses = [{ status: "FINISHED" }];
    checkpointMode = "ok";
    publishMode = "success";
    createDuration = 0;
    statusHook = null;
    checkpointHook = null;
    parentReadError = false;
    successSettlementFails = false;
    creates = 0;
    statusReads = 0;
    publishes = 0;
    settlements = 0;
    outbox = 0;
  }

  function insertCheckpoint(payload: Record<string, unknown>) {
    const responseData = payload.p_response_data as Record<string, unknown>;
    const identity = deferred(responseData);
    const existing = rows.find((row) => deferred(row.response_data)?.container_id === identity.container_id);
    if (existing) return existing;
    const row: Row = {
      id: IMAGE_ROW,
      post_id: POST,
      social_account_id: THREADS_ACCOUNT,
      platform: "threads",
      status: "pending",
      platform_post_id: null,
      platform_post_url: null,
      error_message: null,
      response_data: responseData,
    };
    rows.push(row);
    post.status = "processing";
    return row;
  }

  function settle(payload: Record<string, unknown>) {
    settlements++;
    if (successSettlementFails && payload.p_platform_post_id === IMAGE_ROW && payload.p_status === "success") {
      return Response.json({ message: "fixture success settlement unavailable" }, { status: 500 });
    }
    const id = payload.p_platform_post_id as string | null;
    let row = id ? rows.find((candidate) => candidate.id === id) : undefined;
    if (row && deferred(row.response_data)?.media_type === "IMAGE") {
      const current = deferred(row.response_data);
      const supplied = deferred(payload.p_response_data as Record<string, unknown> || {});
      if (!current.execution_id || supplied?.execution_id !== current.execution_id ||
        supplied?.claimed_until !== current.claimed_until || current.execution_claimed_until !== current.claimed_until) {
        return Response.json({ message: "stale execution" }, { status: 409 });
      }
    }
    if (!row) {
      row = {
        id: `terminal-${rows.length + 1}`,
        post_id: POST,
        social_account_id: String(payload.p_social_account_id),
        platform: String(payload.p_platform),
        status: "pending",
        platform_post_id: null,
        platform_post_url: null,
        error_message: null,
        response_data: {},
      };
      rows.push(row);
    }
    if (row.status !== "pending") return Response.json({ platform_post_id: row.id, settled: false });
    row.status = String(payload.p_status);
    row.platform_post_id = payload.p_provider_post_id as string | null;
    row.platform_post_url = payload.p_provider_post_url as string | null;
    row.error_message = payload.p_error_message as string | null;
    if (payload.p_response_data) row.response_data = payload.p_response_data as Record<string, unknown>;
    outbox++;
    if (rows.every((candidate) => candidate.status !== "pending")) {
      post.status = rows.some((candidate) => candidate.status === "success") ? "completed" : "failed";
    }
    return Response.json({ platform_post_id: row.id, settled: true, post_status: post.status });
  }

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "graph.threads.net") {
      if (request.method === "POST" && url.pathname.endsWith("/threads")) {
        creates++;
        clock += createDuration;
        return Response.json({ id: CONTAINER });
      }
      if (request.method === "POST" && url.pathname.endsWith("/threads_publish")) {
        publishes++;
        if (publishMode === "timeout") throw new DOMException("fixture timeout", "TimeoutError");
        if (publishMode === "rejected") return Response.json({ error: { message: "fixture publish rejection" } });
        return Response.json({ id: "published-image-1" });
      }
      if (request.method === "GET" && url.searchParams.get("fields")?.includes("error_message")) {
        statusReads++;
        statusHook?.();
        const next = providerStatuses.shift() ?? { status: "IN_PROGRESS" };
        if (next instanceof Error) throw next;
        return Response.json(next);
      }
      if (request.method === "GET" && url.searchParams.get("fields")?.includes("permalink")) {
        return Response.json({ id: "published-image-1", permalink: "https://www.threads.net/@fixture/post/image-1" });
      }
      unexpected.push(`Unexpected Threads call ${request.method} ${url.pathname}`);
      throw new Error(unexpected.at(-1));
    }
    if (url.hostname === "graph.facebook.com") {
      if (url.pathname.endsWith("/photos")) return Response.json({ id: "facebook-photo-1" });
      if (url.pathname.endsWith("/facebook-photo-1")) return Response.json({ link: "https://media-fixture.invalid/facebook-photo-1.jpg" });
      if (url.pathname.endsWith("/feed")) return Response.json({ id: "facebook-post-1" });
      unexpected.push(`Unexpected Facebook call ${request.method} ${url.pathname}`);
      throw new Error(unexpected.at(-1));
    }

    assertEquals(url.origin, ORIGIN, "Only registered fake origins may be used");
    const table = url.pathname.replace("/rest/v1/", "");
    if (table === "posts") {
      if (request.method === "PATCH") {
        if (!matchesPostFilters(post, url)) return Response.json([]);
        Object.assign(post, await request.json());
        return Response.json([{ id: POST, processing_started_at: post.processing_started_at }]);
      }
      if (parentReadError && rows.some((row) => row.id === IMAGE_ROW)) {
        return Response.json({ message: "fixture parent read failure" }, { status: 500 });
      }
      return Response.json(post);
    }
    if (table === "social_accounts") return Response.json(accounts);
    if (table === "media_files") {
      return Response.json((post.media_file_ids as string[]).map((id) => ({
        id,
        file_path: `https://media-fixture.invalid/${id}.jpg`,
        file_type: "image",
        storage_bucket: "openinary",
        mime_type: "image/jpeg",
      })));
    }
    if (table === "media_file_providers") return Response.json([]);
    if (table === "app_settings") return Response.json(null);
    if (table === "platform_posts") {
      if (request.method === "PATCH") {
        const body = await request.json() as Record<string, unknown>;
        const candidates = rows.filter((row) => {
          if (url.searchParams.get("id") !== `eq.${row.id}`) return false;
          if (url.searchParams.get("status") && url.searchParams.get("status") !== `eq.${row.status}`) return false;
          for (const [path, raw] of url.searchParams) {
            if (!path.startsWith("response_data->")) continue;
            const expected = raw.replace(/^(eq|is)\./, "");
            if (!matchesPath(row, path, expected)) return false;
          }
          return true;
        });
        for (const row of candidates) Object.assign(row, body);
        return Response.json(candidates.map((row) => ({ id: row.id })));
      }
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      const selected = id ? rows.filter((row) => row.id === id) : rows.filter((row) => row.post_id === POST);
      return Response.json(id ? selected[0] ?? null : selected);
    }
    if (table === "rpc/record_threads_image_checkpoint") {
      const payload = await request.json() as Record<string, unknown>;
      if (checkpointMode === "error") return Response.json({ message: "checkpoint unavailable" }, { status: 500 });
      if (checkpointMode === "null") return Response.json(null);
      if (checkpointMode === "lost") {
        insertCheckpoint(payload);
        return Response.json({ message: "response lost" }, { status: 500 });
      }
      if (payload.p_expected_processing_started_at !== post.processing_started_at || post.status === "pending") {
        return Response.json({ message: "stale publish claim" }, { status: 409 });
      }
      const checkpoint = insertCheckpoint(payload);
      checkpointHook?.();
      return Response.json(checkpoint.id);
    }
    if (table === "rpc/claim_threads_image_execution") {
      const payload = await request.json() as Record<string, unknown>;
      const row = rows.find((candidate) => candidate.id === payload.p_platform_post_id);
      if (!row || row.status !== "pending" || deferred(row.response_data).claimed_until !== payload.p_expected_claimed_until) {
        return Response.json(false);
      }
      if (deferred(row.response_data).execution_id) return Response.json(false);
      Object.assign(deferred(row.response_data), {
        execution_id: payload.p_execution_id,
        execution_claimed_until: payload.p_expected_claimed_until,
      });
      return Response.json(true);
    }
    if (table === "rpc/mark_threads_image_publish_started") {
      const payload = await request.json() as Record<string, unknown>;
      const row = rows.find((candidate) => candidate.id === payload.p_platform_post_id);
      if (!row || row.status !== "pending") return Response.json(false);
      const identity = deferred(row.response_data);
      const account = accounts.find((candidate) => candidate.id === row.social_account_id);
      const fenceMatches = await hashRequest(row.response_data.content_fence) === await hashRequest(payload.p_expected_content) &&
        await hashRequest(contentFence(post)) === await hashRequest(payload.p_expected_content);
      const active = post.status === "processing" && post.processing_started_at === identity.attempt_started_at &&
        identity.claimed_until === payload.p_expected_claimed_until && identity.execution_id === payload.p_execution_id &&
        identity.execution_claimed_until === payload.p_expected_claimed_until && !identity.publish_attempt_id &&
        account?.is_active && account.updated_at === row.response_data.account_updated_at && fenceMatches;
      if (!active) return Response.json(false);
      identity.publish_attempt_id = payload.p_execution_id;
      return Response.json(true);
    }
    if (table === "rpc/partner_settle_platform_post") return settle(await request.json());
    if (table === "rpc/record_deferred_platform_post") {
      const payload = await request.json();
      return Response.json(insertCheckpoint(payload).id);
    }
    if (table === "system_logs") {
      logs.push(await request.json());
      return new Response(null, { status: 201 });
    }
    if (table === "profiles") return Response.json({ id: OWNER, preferred_timezone: "UTC" });
    if (["user_rate_limits", "user_subscriptions", "tier_rate_limits", "rate_limit_settings"].includes(table)) return Response.json([]);
    if (table === "api_logs") return request.method === "HEAD" ? new Response(null, { headers: { "content-range": "*/0" } }) : new Response(null, { status: 201 });
    unexpected.push(`Unexpected persistence call ${request.method} ${url.pathname}`);
    throw new Error(unexpected.at(-1));
  };

  async function invoke(options: { at?: number; resume?: string; platforms?: string[]; accountIds?: string[] } = {}) {
    clock = options.at ?? 0;
    return await handler!(new Request(`${ORIGIN}/functions/v1/process-post`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
      body: JSON.stringify({
        post_id: POST,
        ...(options.resume ? { resume_platform_post_id: options.resume } : {}),
        ...(options.platforms ? { platforms: options.platforms } : {}),
        ...(options.accountIds ? { account_ids: options.accountIds } : {}),
      }),
    }));
  }

  function addFailedRow(kind: "uncertain" | "facebook") {
    rows.push({
      id: kind === "uncertain" ? IMAGE_ROW : "facebook-failed-old",
      post_id: POST,
      social_account_id: kind === "uncertain" ? THREADS_ACCOUNT : FACEBOOK_ACCOUNT,
      platform: kind === "uncertain" ? "threads" : "facebook",
      status: "failed",
      platform_post_id: null,
      platform_post_url: null,
      error_message: kind === "uncertain" ? "Manual reconciliation required" : "fixture proven failure",
      response_data: kind === "uncertain" ? { deferred: { media_type: "IMAGE", publish_outcome: "uncertain" } } : {},
    });
  }

  function leaseImageRow() {
    const row = rows.find((candidate) => candidate.id === IMAGE_ROW)!;
    Object.assign(deferred(row.response_data), {
      claimed_until: LEASE,
      execution_id: null,
      execution_claimed_until: null,
      next_check_at: "2026-01-01T00:00:00.000Z",
    });
    post.status = "processing";
    return row;
  }

  try {
    reset();
    Deno.serve = ((registered: Handler) => {
      handler = registered;
      return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
    }) as typeof Deno.serve;
    await import("./index.ts?threads-image-resume-handler-test");
    Deno.serve = previousServe;
    assert(handler);

    await test.step("a 9.22 second create at the clipped deadline checkpoints IMAGE before any GET or publish", async () => {
      reset();
      createDuration = 9_220;
      const response = await invoke({ at: 78_000 });
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json();
      assertEquals(body.status, "processing");
      assertEquals({ creates, statusReads, publishes }, { creates: 1, statusReads: 0, publishes: 0 });
      assertEquals(rows.length, 1);
      assertEquals(rows[0].status, "pending");
      assertEquals(deferred(rows[0].response_data).media_type, "IMAGE");
      assertEquals(deferred(rows[0].response_data).container_id, CONTAINER);
      assertEquals(rows[0].platform_post_id, null);
      assertEquals(post.status, "processing");
    });

    await test.step("resume publishes the same checkpoint once and settles the same row", async () => {
      leaseImageRow();
      providerStatuses = [{ status: "FINISHED" }];
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals({ creates, publishes }, { creates: 1, publishes: 1 });
      assertEquals(rows.length, 1);
      assertEquals(rows[0].id, IMAGE_ROW);
      assertEquals(rows[0].status, "success");
      assertEquals(rows[0].platform_post_id, "published-image-1");
      assertEquals(post.status, "completed");
      assertEquals(outbox, 1);
    });

    await test.step("a fast new image uses the same immediate handoff", async () => {
      reset();
      createDuration = 1;
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals({ creates, statusReads, publishes }, { creates: 1, statusReads: 0, publishes: 0 });
      assertEquals(rows[0].status, "pending");
      assertEquals(deferred(rows[0].response_data).media_type, "IMAGE");
      assert(!logs.some((entry) => entry.metadata &&
        (entry.metadata as Record<string, unknown>).event === "threads_image_handoff_stale"),
      "An unchanged checkpoint must not be misclassified as stale by REST content filters");
    });

    await test.step("PUBLISHED settles without a resend or a fabricated provider post ID", async () => {
      leaseImageRow();
      providerStatuses = [{ status: "PUBLISHED" }];
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(publishes, 0);
      assertEquals(rows[0].status, "success");
      assertEquals(rows[0].platform_post_id, null);
    });

    await test.step("an acknowledged image stays pending when success settlement fails and reconciles without resend", async () => {
      reset();
      await invoke({ at: 1_000 });
      leaseImageRow();
      successSettlementFails = true;
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 503);
      assertEquals(rows[0].status, "pending");
      assertEquals(settlements, 1, "A failed success write must never fall through to a retryable failure write");
      assertEquals(publishes, 1);
      successSettlementFails = false;
      leaseImageRow();
      providerStatuses = [{ status: "PUBLISHED" }];
      const reconciled = await invoke({ resume: IMAGE_ROW });
      assertEquals(reconciled.status, 200);
      assertEquals(rows[0].status, "success");
      assertEquals(publishes, 1);
    });

    await test.step("a sibling Pinterest history stamp does not abandon the unchanged Threads image", async () => {
      reset();
      await invoke({ at: 1_000 });
      post.metadata = { ...(post.metadata as Record<string, unknown>), pinterest_post_type: "image" };
      leaseImageRow();
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 200);
      assertEquals(rows[0].status, "success");
      assertEquals(publishes, 1);
    });

    await test.step("a missing image lease persists a refusal log before returning", async () => {
      reset();
      await invoke({ at: 1_000 });
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 503);
      assert(logs.some((entry) => (entry.metadata as Record<string, unknown> | undefined)?.event === "threads_image_lease_missing"));
      assertEquals(publishes, 0);
    });

    await test.step("an unanswered publish reconciles PUBLISHED without sending twice", async () => {
      reset();
      await invoke({ at: 1_000 });
      leaseImageRow();
      publishMode = "timeout";
      providerStatuses = [{ status: "FINISHED" }];
      const first = await invoke({ resume: IMAGE_ROW });
      assertEquals(first.status, 200, await first.clone().text());
      assertEquals(publishes, 1);
      assertEquals(rows[0].status, "pending");
      assertEquals(deferred(rows[0].response_data).publish_outcome, "uncertain");
      leaseImageRow();
      providerStatuses = [{ status: "PUBLISHED" }];
      const second = await invoke({ resume: IMAGE_ROW });
      assertEquals(second.status, 200, await second.clone().text());
      assertEquals(publishes, 1);
      assertEquals(rows[0].status, "success");
    });

    await test.step("FINISHED after an unanswered publish never authorizes a blind resend and expires unresolved", async () => {
      reset();
      await invoke({ at: 1_000 });
      leaseImageRow();
      publishMode = "timeout";
      providerStatuses = [{ status: "FINISHED" }];
      await invoke({ resume: IMAGE_ROW });
      leaseImageRow();
      providerStatuses = [{ status: "FINISHED" }];
      const pending = await invoke({ resume: IMAGE_ROW });
      assertEquals(pending.status, 200, await pending.clone().text());
      assertEquals(publishes, 1);
      assertEquals(rows[0].status, "pending");
      const row = leaseImageRow();
      deferred(row.response_data).give_up_at = "2020-01-01T00:00:00.000Z";
      const expired = await invoke({ resume: IMAGE_ROW });
      assertEquals(expired.status, 200, await expired.clone().text());
      assertEquals(publishes, 1);
      assertEquals(row.status, "failed");
      assert(row.error_message?.includes("Manual reconciliation"));
      assertEquals(deferred(row.response_data).publish_outcome, "uncertain");
    });

    await test.step("duplicate resumes have one execution owner and one provider write", async () => {
      reset();
      await invoke({ at: 1_000 });
      leaseImageRow();
      providerStatuses = [{ status: "FINISHED" }, { status: "FINISHED" }];
      const responses = await Promise.all([invoke({ resume: IMAGE_ROW }), invoke({ resume: IMAGE_ROW })]);
      assertEquals(responses.map((response) => response.status), [200, 200]);
      assertEquals(publishes, 1);
      assertEquals(rows.filter((row) => row.status === "success").length, 1);
      assert(logs.some((entry) => (entry.metadata as Record<string, unknown> | undefined)?.event === "threads_image_execution_refused"));
    });

    await test.step("waiting keeps the same image checkpoint and increments bounded attempts", async () => {
      reset();
      await invoke({ at: 1_000 });
      const row = leaseImageRow();
      providerStatuses = [{ status: "IN_PROGRESS" }];
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals((await response.json()).status, "processing");
      assertEquals(publishes, 0);
      assertEquals(row.status, "pending");
      assertEquals(deferred(row.response_data).attempts, 1);
      assertEquals(deferred(row.response_data).container_id, CONTAINER);
    });

    for (const status of ["ERROR", "EXPIRED"] as const) {
      await test.step(`${status} without a prior send settles the actual provider reason on the checkpoint`, async () => {
        reset();
        await invoke({ at: 1_000 });
        const row = leaseImageRow();
        providerStatuses = [{ status, error_message: "synthetic provider detail" }];
        const response = await invoke({ resume: IMAGE_ROW });
        assertEquals(response.status, 200, await response.clone().text());
        assertEquals(publishes, 0);
        assertEquals(row.status, "failed");
        assert(row.error_message?.includes(`${status}: synthetic provider detail`));
      });
    }

    await test.step("a status-read failure after an unanswered send cannot authorize another publish", async () => {
      reset();
      await invoke({ at: 1_000 });
      leaseImageRow();
      publishMode = "timeout";
      providerStatuses = [{ status: "FINISHED" }];
      await invoke({ resume: IMAGE_ROW });
      const row = leaseImageRow();
      providerStatuses = [new Error("fixture status outage")];
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(publishes, 1);
      assertEquals(row.status, "pending");
      assertEquals(deferred(row.response_data).publish_outcome, "uncertain");
    });

    await test.step("a stale execution loses its conditional publish mark and cannot overwrite the new owner", async () => {
      reset();
      await invoke({ at: 1_000 });
      const row = leaseImageRow();
      providerStatuses = [{ status: "FINISHED" }];
      statusHook = () => {
        Object.assign(deferred(row.response_data), { execution_id: "new-owner", execution_claimed_until: LEASE });
      };
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 503);
      assertEquals(publishes, 0);
      assertEquals(row.status, "pending");
      assertEquals(deferred(row.response_data).execution_id, "new-owner");
      assertEquals(deferred(row.response_data).publish_attempt_id, undefined);
    });

    for (const conflict of ["edit-before-send", "cancel-before-send", "account-before-send"] as const) {
      await test.step(`${conflict} fails the atomic pre-send guard without a provider write`, async () => {
        reset();
        await invoke({ at: 1_000 });
        const row = leaseImageRow();
        providerStatuses = [{ status: "FINISHED" }];
        statusHook = () => {
          if (conflict === "edit-before-send") post.caption = "changed after the status read";
          else if (conflict === "cancel-before-send") post.status = "failed";
          else accounts = [];
        };
        const response = await invoke({ resume: IMAGE_ROW });
        assertEquals(response.status, 503);
        assertEquals(publishes, 0);
        assertEquals(row.status, "pending");
        assertEquals(deferred(row.response_data).publish_attempt_id, undefined);
      });
    }

    await test.step("edited content and cancelled posts refuse new provider work without resurrection", async () => {
      for (const change of ["edit", "cancel"] as const) {
        reset();
        await invoke({ at: 1_000 });
        leaseImageRow();
        if (change === "edit") post.caption = "changed synthetic caption";
        else post.status = "failed";
        const response = await invoke({ resume: IMAGE_ROW });
        assertEquals(response.status, 200, await response.clone().text());
        assertEquals({ statusReads, publishes }, { statusReads: 0, publishes: 0 });
        assertEquals(rows[0].status, "failed");
        assertEquals(post.status, "failed");
      }
    });

    await test.step("wrong account scope and credential refresh conflicts retain pending state without provider calls", async () => {
      for (const conflict of ["account", "credential"] as const) {
        reset();
        await invoke({ at: 1_000 });
        leaseImageRow();
        if (conflict === "account") accounts = [];
        else accounts[0].updated_at = "2026-01-02T00:00:00.000Z";
        const response = await invoke({ resume: IMAGE_ROW });
        assertEquals(response.status, 503);
        assertEquals({ statusReads, publishes }, { statusReads: 0, publishes: 0 });
        assertEquals(rows[0].status, "pending");
        assertEquals(post.status, "processing");
      }
    });

    for (const kind of ["threads", "threads_carousel"] as const) {
      await test.step(`legacy ${kind} resume keeps its original media fallback and publish behavior`, async () => {
        reset();
        await invoke({ at: 1_000 });
        const row = leaseImageRow();
        deferred(row.response_data).kind = kind;
        delete deferred(row.response_data).media_type;
        providerStatuses = [{ status: "FINISHED" }];
        const response = await invoke({ resume: IMAGE_ROW });
        assertEquals(response.status, 200, await response.clone().text());
        assertEquals({ creates, publishes }, { creates: 1, publishes: 1 });
        assertEquals(row.status, "success");
      });
    }

    for (const mode of ["error", "null", "lost"] as const) {
      await test.step(`checkpoint ${mode} refuses provider publish without failure settlement or duplicate rows`, async () => {
        reset();
        checkpointMode = mode;
        const response = await invoke({ at: 1_000 });
        assertEquals(response.status, 503);
        assertEquals(publishes, 0);
        assertEquals(settlements, 0);
        assertEquals(rows.filter((row) => row.status === "failed").length, 0);
        assertEquals(rows.length, mode === "lost" ? 1 : 0);
        assert(logs.some((entry) => JSON.stringify(entry).includes("checkpoint")));
        if (mode === "lost") {
          leaseImageRow();
          providerStatuses = [{ status: "FINISHED" }];
          const recovered = await invoke({ resume: IMAGE_ROW });
          assertEquals(recovered.status, 200, await recovered.clone().text());
          assertEquals({ creates, publishes }, { creates: 1, publishes: 1 });
          assertEquals(rows[0].status, "success");
        }
      });
    }

    await test.step("an earlier Facebook success cannot roll up the parent before the Threads checkpoint", async () => {
      reset();
      accounts = [facebookAccount(), threadsAccount()];
      post.platforms = ["facebook", "threads"];
      post.metadata = { selected_account_ids: [FACEBOOK_ACCOUNT, THREADS_ACCOUNT] };
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(rows.filter((row) => row.platform === "facebook" && row.status === "success").length, 1);
      assertEquals(rows.filter((row) => row.id === IMAGE_ROW && row.status === "pending").length, 1);
      assertEquals(post.status, "processing");
      assertEquals(outbox, 1);
    });

    await test.step("reconciler completion before the original response is not rolled back to processing", async () => {
      reset();
      checkpointHook = () => {
        rows[0].status = "success";
        post.status = "completed";
      };
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals((await response.json()).status, "completed");
      assertEquals(post.status, "completed");
      assert(logs.some((entry) => entry.metadata && (entry.metadata as Record<string, unknown>).event === "threads_image_handoff_stale"));
    });

    await test.step("a newer claim and edit during handoff win over the original parent write", async () => {
      reset();
      checkpointHook = () => {
        post.processing_started_at = "newer-claim";
        post.caption = "newer edit";
      };
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(post.processing_started_at, "newer-claim");
      assertEquals(post.caption, "newer edit");
      assert(logs.some((entry) => entry.metadata && (entry.metadata as Record<string, unknown>).event === "threads_image_handoff_stale"));
    });

    await test.step("a handoff state read error returns 503 and preserves the parent and checkpoint", async () => {
      reset();
      parentReadError = true;
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 503);
      assertEquals(post.status, "processing");
      assertEquals(rows[0].status, "pending");
      assert(logs.some((entry) => entry.metadata && (entry.metadata as Record<string, unknown>).event === "threads_image_handoff_state_unreadable"));
    });

    await test.step("direct process-post overrides cannot replace an uncertain image or delete its evidence", async () => {
      reset();
      post.status = "failed";
      addFailedRow("uncertain");
      const response = await invoke({ accountIds: [THREADS_ACCOUNT], platforms: ["threads"] });
      assertEquals(response.status, 409);
      assertEquals({ creates, publishes, settlements }, { creates: 0, publishes: 0, settlements: 0 });
      assertEquals(rows[0].status, "failed");
      assertEquals(deferred(rows[0].response_data).publish_outcome, "uncertain");
      assertEquals(post.status, "failed");
    });

    await test.step("a proven Facebook failure proceeds while the uncertain Threads target is withheld", async () => {
      reset();
      accounts = [facebookAccount(), threadsAccount()];
      post.platforms = ["facebook", "threads"];
      post.metadata = { selected_account_ids: [FACEBOOK_ACCOUNT, THREADS_ACCOUNT] };
      post.status = "failed";
      addFailedRow("facebook");
      addFailedRow("uncertain");
      const response = await invoke({ accountIds: [FACEBOOK_ACCOUNT, THREADS_ACCOUNT], platforms: ["facebook", "threads"] });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals({ creates, publishes, settlements }, { creates: 0, publishes: 0, settlements: 1 });
      assertEquals(rows.find((row) => row.id === IMAGE_ROW)?.status, "failed");
      assertEquals(rows.some((row) => row.platform === "facebook" && row.status === "success"), true);
      assertEquals(post.status, "completed");
    });

    await test.step("JSONB key ordering does not look like an edit to the saved image", async () => {
      reset();
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT], nested: { second: 2, first: 1 } };
      await invoke({ at: 1_000 });
      const row = leaseImageRow();
      const fence = row.response_data.content_fence as Record<string, unknown>;
      row.response_data.content_fence = Object.fromEntries(Object.entries(fence).reverse());
      (row.response_data.content_fence as Record<string, unknown>).metadata = {
        nested: { first: 1, second: 2 }, selected_account_ids: [THREADS_ACCOUNT],
      };
      providerStatuses = [{ status: "FINISHED" }];
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(rows[0].status, "success");
      assertEquals(publishes, 1);
    });

    assertEquals(unexpected, []);
  } finally {
    globalThis.fetch = previousFetch;
    Deno.serve = previousServe;
    Date.now = previousNow;
    for (const [key, previous] of environment) {
      if (previous === undefined) Deno.env.delete(key);
      else Deno.env.set(key, previous);
    }
  }
});
