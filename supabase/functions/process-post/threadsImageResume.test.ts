import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hashRequest } from "../_shared/partnerApiIdempotency.ts";
import { runReconcile } from "../reconcile-deferred-publishes/run.ts";

const ORIGIN = "https://threads-image-fixture.invalid";
const OWNER = "11000000-0000-4000-8000-000000000001";
const THREADS_ACCOUNT = "22000000-0000-4000-8000-000000000001";
const THREADS_ACCOUNT_2 = "22000000-0000-4000-8000-000000000003";
const FACEBOOK_ACCOUNT = "22000000-0000-4000-8000-000000000002";
const POST = "33000000-0000-4000-8000-000000000001";
const IMAGE_ROW = "44000000-0000-4000-8000-000000000001";
const IMAGE_ROW_2 = "44000000-0000-4000-8000-000000000002";
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
  created_at?: string;
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

function normalizeTestMetadata(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const metadata = { ...(raw ?? {}) };
  for (const key of [
    "pinterest_post_type",
    "final_notified_at",
    "settlement_rollup_at",
    "settlement_rollup_status",
    "settlement_rollup_processing_started_at",
    "attempt_target_account_ids",
    "attempt_retained_account_ids",
    "attempt_retained_platform_post_ids",
    "attempt_started_at",
    "attempt_scope",
    "final_notification_intent",
  ]) {
    delete metadata[key];
  }
  return metadata;
}

function normalizeFence(fence: unknown): Record<string, unknown> | null {
  if (!fence || typeof fence !== "object") return null;
  const obj = fence as Record<string, unknown>;
  return {
    user_id: obj.user_id,
    caption: obj.caption,
    media_file_ids: obj.media_file_ids,
    metadata: normalizeTestMetadata(obj.metadata as Record<string, unknown> | null),
    platforms: obj.platforms,
    scheduled_at: obj.scheduled_at ?? null,
    publish_requested_at: obj.publish_requested_at ?? null,
    source: obj.source ?? null,
  };
}

function contentFence(post: Record<string, unknown>) {
  return {
    user_id: post.user_id,
    caption: post.caption,
    media_file_ids: post.media_file_ids,
    metadata: normalizeTestMetadata(post.metadata as Record<string, unknown> | null),
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
    let actual: unknown;
    if (column.includes("->")) {
      const parts = column.split("->");
      actual = post;
      for (const part of parts) {
        const key = part.replace(/>/g, "");
        actual = actual && typeof actual === "object" ? (actual as Record<string, unknown>)[key] : undefined;
      }
    } else {
      actual = post[column];
    }
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
  const previousDate = globalThis.Date;
  const environment = new Map(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"].map((key) => [key, Deno.env.get(key)]));
  Deno.env.set("SUPABASE_URL", ORIGIN);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
  Deno.env.set("SUPABASE_ANON_KEY", "fixture-anon");
  let handler: Handler | undefined;
  let clock = 0;
  const BASE_CLOCK = 1_767_225_600_000;
  class MockDate extends previousDate {
    constructor(...args: [] | [string | number | Date] | [number, number, number?, number?, number?, number?, number?]) {
      const instant = args.length === 0
        ? new previousDate(BASE_CLOCK + clock)
        : Reflect.construct(previousDate, args) as Date;
      super(instant.getTime());
    }
    static override now() {
      return BASE_CLOCK + clock;
    }
  }
  globalThis.Date = MockDate as unknown as DateConstructor;
  Date.now = () => BASE_CLOCK + clock;

  let post: Record<string, unknown>;
  let accounts: Account[];
  let rows: Row[];
  let logs: Record<string, unknown>[];
  let providerStatuses: Array<Record<string, unknown> | Error>;
  let checkpointMode: "ok" | "error" | "null" | "lost";
  let inlineClaimMode: "ok" | "refused" | "error" | "lost";
  let releaseMode: "ok" | "false" | "error" | "lost";
  let markMode: "ok" | "error" | "lost";
  let finalizerMode: "ok" | "error" | "lost";
  let publishMode: "success" | "timeout" | "rejected" | "null";
  let createMode: "ok" | "error";
  let facebookFail = false;
  let createDuration = 0;
  let markDuration = 0;
  let statusHook: (() => void) | null = null;
  let beforeCheckpointHook: (() => void | Promise<void>) | null = null;
  let checkpointHook: (() => void) | null = null;
  let parentReadError = false;
  let successSettlementFails = false;
  let successSettlementLost = false;
  let creates = 0;
  let statusReads = 0;
  let publishes = 0;
  let settlements = 0;
  let inlineClaims = 0;
  let releases = 0;
  let pendingReschedules = 0;
  let finalNotificationClaims = 0;
  let finalizerCalls = 0;
  let webhookFailure: "none" | "http" | "transport" = "none";
  let deliveredNotifications: Array<{ url: string; event: string; body: unknown }> = [];
  let outbox = 0;
  let containerIdOverride: string | null = null;
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
  const secondThreadsAccount = (): Account => ({
    ...threadsAccount(),
    id: THREADS_ACCOUNT_2,
    platform_user_id: "fixture-threads-user-2",
    platform_username: "fixture-2",
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
      metadata: { selected_account_ids: [THREADS_ACCOUNT], webhook_url: "https://webhook-fixture.invalid/hook" },
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
    inlineClaimMode = "ok";
    releaseMode = "ok";
    markMode = "ok";
    finalizerMode = "ok";
    publishMode = "success";
    createMode = "ok";
    facebookFail = false;
    createDuration = 0;
    markDuration = 0;
    statusHook = null;
    beforeCheckpointHook = null;
    checkpointHook = null;
    parentReadError = false;
    successSettlementFails = false;
    successSettlementLost = false;
    creates = 0;
    statusReads = 0;
    publishes = 0;
    settlements = 0;
    inlineClaims = 0;
    releases = 0;
    pendingReschedules = 0;
    finalNotificationClaims = 0;
    finalizerCalls = 0;
    webhookFailure = "none";
    deliveredNotifications = [];
    outbox = 0;
    containerIdOverride = null;
  }

  function insertCheckpoint(payload: Record<string, unknown>) {
    const responseData = payload.p_response_data as Record<string, unknown>;
    const identity = deferred(responseData);
    const existing = rows.find((row) => row.social_account_id === payload.p_social_account_id &&
      deferred(row.response_data)?.container_id === identity.container_id);
    if (existing) return existing;
    const row: Row = {
      id: payload.p_social_account_id === THREADS_ACCOUNT_2 ? IMAGE_ROW_2 : IMAGE_ROW,
      post_id: POST,
      social_account_id: String(payload.p_social_account_id),
      platform: "threads",
      status: "pending",
      platform_post_id: null,
      platform_post_url: null,
      error_message: null,
      response_data: responseData,
      created_at: new Date().toISOString(),
    };
    rows.push(row);
    post.status = "processing";
    return row;
  }

  async function settle(payload: Record<string, unknown>) {
    settlements++;
    if (successSettlementFails && !successSettlementLost && payload.p_platform_post_id === IMAGE_ROW && payload.p_status === "success") {
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
        created_at: new Date().toISOString(),
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
      const identity = deferred(row.response_data);
      const managedAttempt = rows.some((candidate) => {
        const current = deferred(candidate.response_data);
        return current?.kind === "threads" && current.media_type === "IMAGE" &&
          current.attempt_started_at === post.processing_started_at;
      });
      const threadsInPlatforms = (post.platforms as string[]).includes("threads");
      const threadsTerminal = rows.some(candidate => candidate.platform === "threads" && ["success", "failed"].includes(candidate.status));
      const threadsSuppressed = threadsInPlatforms && !threadsTerminal;
      const ownsParent = !managedAttempt && !threadsSuppressed && (identity?.media_type !== "IMAGE" ||
        (post.processing_started_at === identity.attempt_started_at &&
          await hashRequest(contentFence(post)) === await hashRequest(row.response_data.content_fence)));
      if (ownsParent) {
        post.status = rows.some((candidate) => candidate.status === "success") ? "completed" : "failed";
        post.metadata = { ...(post.metadata as Record<string, unknown> || {}), settlement_rollup_at: new Date().toISOString() };
      }
    }
    if (successSettlementFails && successSettlementLost && payload.p_platform_post_id === IMAGE_ROW && payload.p_status === "success") {
      return Response.json({ message: "fixture committed settlement response lost" }, { status: 500 });
    }
    return Response.json({ platform_post_id: row.id, settled: true, post_status: post.status });
  }

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://webhook-fixture.invalid") {
      if (webhookFailure === "http") return new Response("fixture unavailable", { status: 503 });
      if (webhookFailure === "transport") throw new TypeError("fixture delivery connection lost");
      deliveredNotifications.push({
        url: request.url,
        event: request.headers.get("X-Postora-Event") ?? "",
        body: await request.clone().json(),
      });
      return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.includes("/functions/v1/send-subscription-email")) {
      deliveredNotifications.push({
        url: request.url,
        event: "email.post_failed",
        body: await request.clone().json(),
      });
      return Response.json({ success: true });
    }
    if (url.hostname === "graph.threads.net") {
      if (request.method === "POST" && url.pathname.endsWith("/threads")) {
        if (createMode === "error") {
          return Response.json({ error: { message: "fixture container creation failed" } }, { status: 400 });
        }
        creates++;
        clock += createDuration;
        return Response.json({
          id: url.pathname.includes("fixture-threads-user-2")
            ? `${CONTAINER}-2`
            : (containerIdOverride === "dynamic" ? `${CONTAINER}-${creates}` : (containerIdOverride ?? CONTAINER)),
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/threads_publish")) {
        publishes++;
        if (publishMode === "timeout") throw new DOMException("fixture timeout", "TimeoutError");
        if (publishMode === "null") return Response.json(null);
        if (publishMode === "rejected") return Response.json({ error: { message: "fixture publish rejection" } });
        return Response.json({ id: url.searchParams.get("creation_id")?.endsWith("-2") ? "published-image-2" : "published-image-1" });
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
      if (facebookFail) throw new Error("fixture facebook error");
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
        const update = await request.json() as Record<string, unknown>;
        if (update.status === "processing" && update.processing_started_at &&
          update.processing_started_at !== post.processing_started_at && rows.some((row) =>
            row.status === "pending" && row.platform === "threads" && deferred(row.response_data)?.media_type === "IMAGE")) {
          return Response.json({ message: "Resume the existing Threads image checkpoint" }, { status: 409 });
        }
        Object.assign(post, update);
        if ((update.metadata as Record<string, unknown> | undefined)?.final_notified_at) {
          finalNotificationClaims++;
          if (post.metadata && typeof post.metadata === "object") {
            const intent = (post.metadata as Record<string, unknown>).final_notification_intent as Record<string, unknown> | undefined;
            if (intent) intent.notified = true;
          }
        }
        return Response.json([{ id: POST, processing_started_at: post.processing_started_at }]);
      }
      if (parentReadError && url.searchParams.get("select") !== "*") {
        return Response.json({ message: "fixture parent read failure" }, { status: 500 });
      }
      return Response.json(post);
    }
    if (table === "social_accounts") {
      let filtered = [...accounts];
      for (const [key, raw] of url.searchParams) {
        if (key === "select") continue;
        const eqMatch = raw.match(/^eq\.(.*)$/);
        const inMatch = raw.match(/^in\.\((.*)\)$/);
        if (eqMatch) {
          const val = eqMatch[1];
          filtered = filtered.filter((a) => {
            const actual = (a as Record<string, unknown>)[key];
            return String(actual) === val;
          });
        } else if (inMatch) {
          const set = inMatch[1].split(",").map((s) => s.replace(/^["']|["']$/g, ""));
          filtered = filtered.filter((a) => {
            const actual = (a as Record<string, unknown>)[key];
            return set.includes(String(actual));
          });
        }
      }
      return Response.json(filtered);
    }
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
        for (const row of candidates) {
          Object.assign(row, body);
          if (row.status === "pending" && body.response_data) pendingReschedules++;
        }
        return Response.json(candidates.map((row) => ({ id: row.id })));
      }
      const statusParam = url.searchParams.get("status")?.replace(/^eq\./, "");
      const inMatch = url.searchParams.get("id")?.match(/^in\.\((.*)\)$/);
      if (inMatch) {
        const ids = inMatch[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
        let selected = rows.filter(row => row.post_id === POST && ids.includes(row.id));
        if (statusParam) selected = selected.filter(row => row.status === statusParam);
        return Response.json(selected);
      }
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      let selected = id ? rows.filter((row) => row.id === id) : rows.filter((row) => row.post_id === POST);
      if (statusParam) selected = selected.filter(row => row.status === statusParam);
      return Response.json(id ? selected[0] ?? null : selected);
    }
    if (table === "rpc/record_threads_image_checkpoint") {
      const payload = await request.json() as Record<string, unknown>;
      await beforeCheckpointHook?.();
      if (checkpointMode === "error") return Response.json({ message: "checkpoint unavailable" }, { status: 500 });
      if (checkpointMode === "null") return Response.json(null);
      if (checkpointMode === "lost") {
        insertCheckpoint(payload);
        return Response.json({ message: "response lost" }, { status: 500 });
      }
      const sameAttemptRollup = ["completed", "failed"].includes(String(post.status)) &&
        typeof (post.metadata as Record<string, unknown>)?.settlement_rollup_at === "string" &&
        Date.parse(String((post.metadata as Record<string, unknown>).settlement_rollup_at)) >= Date.parse(String(payload.p_expected_processing_started_at)) &&
        rows.some((row) => ["success", "failed"].includes(row.status));
      if (!sameAttemptRollup && ["failed", "canceled"].includes(String(post.status))) {
        return Response.json({ message: `record_threads_image_checkpoint: post is in status ${post.status}, expected processing` }, { status: 409 });
      }
      if (payload.p_expected_processing_started_at !== post.processing_started_at || post.status === "pending" ||
          (!sameAttemptRollup && post.status !== "processing")) {
        return Response.json({ message: "stale publish claim" }, { status: 409 });
      }
      if (Array.isArray(payload.p_target_account_ids)) {
        post.metadata = {
          ...(post.metadata as Record<string, unknown> || {}),
          attempt_target_account_ids: payload.p_target_account_ids,
        };
      }
      if (Array.isArray(payload.p_retained_platform_post_ids)) {
        post.metadata = {
          ...(post.metadata as Record<string, unknown> || {}),
          attempt_retained_platform_post_ids: payload.p_retained_platform_post_ids,
        };
      }
      if (Array.isArray(payload.p_retained_account_ids)) {
        post.metadata = {
          ...(post.metadata as Record<string, unknown> || {}),
          attempt_retained_account_ids: payload.p_retained_account_ids,
        };
      }
      const checkpoint = insertCheckpoint(payload);
      if (sameAttemptRollup) post.status = "processing";
      checkpointHook?.();
      return Response.json(checkpoint.id);
    }
    if (table === "rpc/claim_threads_image_inline_execution") {
      inlineClaims++;
      const payload = await request.json() as Record<string, unknown>;
      const row = rows.find((candidate) => candidate.id === payload.p_platform_post_id);
      const identity = row ? deferred(row.response_data) : null;
      const account = accounts.find((candidate) => candidate.id === row?.social_account_id);
      const fenceMatches = row && await hashRequest(normalizeFence(row.response_data.content_fence)) === await hashRequest(normalizeFence(payload.p_expected_content)) &&
        await hashRequest(contentFence(post)) === await hashRequest(normalizeFence(payload.p_expected_content));
      const active = row?.status === "pending" && identity && !identity.execution_id && !identity.publish_attempt_id &&
        (!identity.claimed_until || Date.parse(String(identity.claimed_until)) <= BASE_CLOCK + clock) &&
        identity.container_id === payload.p_expected_container_id &&
        identity.attempt_started_at === payload.p_expected_processing_started_at &&
        payload.p_post_id === post.id && payload.p_social_account_id === row.social_account_id &&
        post.status === "processing" && post.processing_started_at === payload.p_expected_processing_started_at &&
        account?.is_active && account.updated_at === row.response_data.account_updated_at && fenceMatches;
      if (!active || inlineClaimMode === "refused") return Response.json(null);
      const claimedUntil = new Date(BASE_CLOCK + clock + 180_000).toISOString();
      Object.assign(identity, {
        claimed_until: claimedUntil,
        execution_id: payload.p_execution_id,
        execution_claimed_until: claimedUntil,
      });
      if (inlineClaimMode === "error") return Response.json({ message: "inline claim unavailable" }, { status: 500 });
      if (inlineClaimMode === "lost") return Response.json({ message: "lost inline claim acknowledgement" }, { status: 500 });
      return Response.json({ platform_post_id: row.id, response_data: row.response_data });
    }
    if (table === "rpc/release_threads_image_publish_unsent") {
      const payload = await request.json() as Record<string, unknown>;
      const row = rows.find((candidate) => candidate.id === payload.p_platform_post_id);
      const identity = row ? deferred(row.response_data) : null;
      const account = accounts.find((candidate) => candidate.id === row?.social_account_id);
      const fenceMatches = row && await hashRequest(normalizeFence(row.response_data.content_fence)) === await hashRequest(normalizeFence(payload.p_expected_content)) &&
        await hashRequest(contentFence(post)) === await hashRequest(normalizeFence(payload.p_expected_content));
      const active = row?.status === "pending" && identity &&
        identity.container_id === payload.p_expected_container_id &&
        identity.attempt_started_at === payload.p_expected_processing_started_at &&
        identity.claimed_until === payload.p_expected_claimed_until &&
        identity.execution_claimed_until === payload.p_expected_claimed_until &&
        identity.execution_id === payload.p_execution_id &&
        identity.publish_attempt_id === payload.p_publish_attempt_id && !identity.publish_outcome &&
        post.status === "processing" && post.processing_started_at === payload.p_expected_processing_started_at &&
        account?.is_active && account.updated_at === row.response_data.account_updated_at && fenceMatches;
      if (!active || releaseMode === "false") return Response.json(false);
      delete identity.publish_attempt_id;
      releases++;
      if (releaseMode === "error") return Response.json({ message: "release unavailable" }, { status: 500 });
      if (releaseMode === "lost") return Response.json({ message: "lost release acknowledgement" }, { status: 500 });
      return Response.json(true);
    }
    if (table === "rpc/finalize_threads_image_attempt") {
      finalizerCalls++;
      const payload = await request.json() as Record<string, unknown>;
      if (parentReadError || finalizerMode === "error") return Response.json({ message: "fixture parent read failure" }, { status: 500 });
      const currentContent = contentFence(post);
      const expectedContent = normalizeFence(payload.p_expected_content);
      const stale = post.processing_started_at !== payload.p_expected_processing_started_at ||
        await hashRequest(currentContent) !== await hashRequest(expectedContent);
      if (stale) return Response.json({ status: post.status, stale: true, notify: false });
      const metadata = { ...((post.metadata as Record<string, unknown> | null) ?? {}) };
      const alreadyNotified = typeof metadata.final_notified_at === "string" &&
        Date.parse(metadata.final_notified_at) >= Date.parse(String(payload.p_expected_processing_started_at));

      if (["completed", "failed"].includes(String(post.status))) {
        return Response.json({
          status: post.status,
          stale: false,
          notify: false,
          authorized_platform_post_ids: (metadata.final_notification_intent as Record<string, unknown> | undefined)?.authorized_platform_post_ids,
        });
      }

      if (post.status !== "processing") {
        return Response.json({ status: post.status, stale: true, notify: false });
      }

      let targetAccountIds: string[] = [];
      if (Array.isArray(payload.p_expected_account_ids) && payload.p_expected_account_ids.length > 0) {
        targetAccountIds = payload.p_expected_account_ids as string[];
      } else if (Array.isArray(metadata.attempt_target_account_ids) && (metadata.attempt_target_account_ids as string[]).length > 0) {
        targetAccountIds = metadata.attempt_target_account_ids as string[];
      } else if (Array.isArray(metadata.selected_account_ids) && metadata.selected_account_ids.length > 0) {
        const selected = metadata.selected_account_ids as string[];
        targetAccountIds = accounts.filter(a => selected.includes(a.id) && a.is_active).map(a => a.id);
      } else {
        const postPlatforms = post.platforms as string[];
        targetAccountIds = accounts.filter(a => postPlatforms.includes(a.platform) && a.is_active).map(a => a.id);
      }

      const retainedAccountIds = Array.isArray(metadata.attempt_retained_account_ids)
        ? (metadata.attempt_retained_account_ids as string[])
        : [];
      const retainedRowIds: string[] = Array.isArray(metadata.attempt_retained_platform_post_ids)
        ? (metadata.attempt_retained_platform_post_ids as string[])
        : rows.filter(r => retainedAccountIds.includes(r.social_account_id) && r.status === "success").map(r => r.id);

      const started = String(payload.p_expected_processing_started_at);
      const missingTargets = targetAccountIds.filter(targetId => {
        if (retainedAccountIds.includes(targetId) || rows.some(r => retainedRowIds.includes(r.id) && r.social_account_id === targetId)) {
          return false;
        }
        return !rows.some(row =>
          row.social_account_id === targetId &&
          row.post_id === POST &&
          (deferred(row.response_data)?.attempt_started_at === started || (row.created_at ?? "") >= started)
        );
      });
      if (missingTargets.length > 0) {
        return Response.json({ status: "processing", stale: false, notify: false });
      }

      const attemptRows = rows.filter(row =>
        row.post_id === POST &&
        (
          retainedRowIds.includes(row.id) ||
          retainedAccountIds.includes(row.social_account_id) ||
          (targetAccountIds.includes(row.social_account_id) &&
            (deferred(row.response_data)?.attempt_started_at === started || (row.created_at ?? "") >= started))
        )
      );

      if (attemptRows.length === 0 && retainedAccountIds.length === 0 && retainedRowIds.length === 0) {
        return Response.json({ status: post.status, stale: false, notify: false });
      }
      if (attemptRows.some((row) => row.status === "pending")) {
        return Response.json({ status: "processing", stale: false, notify: false });
      }

      const hasSuccess = retainedAccountIds.length > 0 || retainedRowIds.length > 0 || attemptRows.some((row) => row.status === "success");
      post.status = hasSuccess ? "completed" : "failed";
      const authorizedRowIds = [
        ...retainedRowIds,
        ...attemptRows.filter(r => !retainedRowIds.includes(r.id)).map(r => r.id)
      ];
      post.metadata = {
        ...(post.metadata as Record<string, unknown> || {}),
        final_notification_intent: {
          created_at: new Date(clock).toISOString(),
          notified: false,
          final_status: post.status,
          authorized_platform_post_ids: authorizedRowIds,
        },
      };

      if (finalizerMode === "lost") {
        return Response.json({ message: "lost finalizer acknowledgement" }, { status: 500 });
      }

      const notify = !alreadyNotified;
      return Response.json({
        status: post.status,
        stale: false,
        notify,
        authorized_platform_post_ids: authorizedRowIds,
      });
    }
    if (table === "rpc/claim_threads_image_notification") {
      const payload = await request.json() as Record<string, unknown>;
      if (post.status !== payload.p_expected_status || post.processing_started_at !== payload.p_expected_processing_started_at) {
        return Response.json({ claimed: false, status: post.status, error: "cycle_or_status_mismatch" });
      }
      const meta = (post.metadata ?? {}) as Record<string, unknown>;
      const intent = meta.final_notification_intent as Record<string, unknown> | undefined;
      if (!intent || intent.notified === true) {
        return Response.json({ claimed: false, status: post.status, error: "intent_unusable" });
      }
      const claimedUntil = intent.claimed_until ? Date.parse(String(intent.claimed_until)) : null;
      if (claimedUntil && claimedUntil > BASE_CLOCK + clock) {
        return Response.json({ claimed: false, status: post.status, error: "lease_held" });
      }
      finalNotificationClaims++;
      intent.claimed_until = new Date(BASE_CLOCK + clock + 180_000).toISOString();
      intent.claim_id = crypto.randomUUID();
      return Response.json({
        claimed: true,
        status: post.status,
        claim_id: intent.claim_id,
        authorized_platform_post_ids: intent.authorized_platform_post_ids,
      });
    }
    if (table === "rpc/confirm_threads_image_notification") {
      const payload = await request.json() as Record<string, unknown>;
      if (post.status !== payload.p_expected_status || post.processing_started_at !== payload.p_expected_processing_started_at) {
        return Response.json({ confirmed: false, status: post.status, error: "cycle_or_status_mismatch" });
      }
      const meta = (post.metadata ?? {}) as Record<string, unknown>;
      const intent = meta.final_notification_intent as Record<string, unknown> | undefined;
      if (!intent || intent.claim_id !== payload.p_claim_id || Date.parse(String(intent.claimed_until)) <= BASE_CLOCK + clock) {
        return Response.json({ confirmed: false, status: post.status, error: "intent_owner_mismatch" });
      }
      meta.final_notified_at = new Date(BASE_CLOCK + clock).toISOString();
      if (intent) {
        intent.notified = true;
        intent.notified_at = meta.final_notified_at;
        intent.claimed_until = null;
      }
      return Response.json({ confirmed: true, status: post.status });
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
      const fenceMatches = await hashRequest(normalizeFence(row.response_data.content_fence)) === await hashRequest(normalizeFence(payload.p_expected_content)) &&
        await hashRequest(contentFence(post)) === await hashRequest(normalizeFence(payload.p_expected_content));
      const active = post.status === "processing" && post.processing_started_at === identity.attempt_started_at &&
        identity.claimed_until === payload.p_expected_claimed_until && identity.execution_id === payload.p_execution_id &&
        identity.execution_claimed_until === payload.p_expected_claimed_until && !identity.publish_attempt_id &&
        account?.is_active && account.updated_at === row.response_data.account_updated_at && fenceMatches;
      if (!active) return Response.json(false);
      if (markMode === "error") return Response.json({ message: "mark unavailable" }, { status: 500 });
      identity.publish_attempt_id = payload.p_execution_id;
      clock += markDuration;
      if (markMode === "lost") return Response.json({ message: "committed mark response lost" }, { status: 500 });
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

  async function checkpointForResume() {
    inlineClaimMode = "refused";
    try {
      return await invoke({ at: 1_000 });
    } finally {
      inlineClaimMode = "ok";
    }
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

  function claimDeferredPublishes(limit = 10, leaseMs = 180_000): Row[] {
    const claimed: Row[] = [];
    const currentClock = BASE_CLOCK + clock;
    for (const row of rows) {
      if (claimed.length >= limit) break;
      const def = deferred(row.response_data);
      if (!def) continue;
      const claimedUntil = def.claimed_until ? Date.parse(String(def.claimed_until)) : -Infinity;
      if (claimedUntil > currentClock) continue;

      const isPendingDue = row.status === "pending" &&
        (!def.next_check_at || Date.parse(String(def.next_check_at)) <= clock);

      const isTerminalManagedImage = ["success", "failed"].includes(row.status) &&
        def.kind === "threads" && def.media_type === "IMAGE" &&
        (post.status === "processing" || (
          ["completed", "failed"].includes(String(post.status)) &&
          Boolean(post.metadata) &&
          ((post.metadata as Record<string, unknown>).final_notification_intent as Record<string, unknown> | undefined)?.notified === false
        ));

      if (isPendingDue || isTerminalManagedImage) {
        const leaseIso = new Date(currentClock + leaseMs).toISOString();
        Object.assign(def, {
          claimed_until: leaseIso,
          execution_id: null,
          execution_claimed_until: null,
        });
        claimed.push(row);
      }
    }
    return claimed;
  }

  function leaseImageRow(id = IMAGE_ROW): Row {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`Row ${id} not found to lease`);
    const def = deferred(row.response_data);
    if (def) {
      def.claimed_until = null;
      def.execution_id = null;
      def.execution_claimed_until = null;
      def.next_check_at = new Date(clock).toISOString();
    }
    const claimed = claimDeferredPublishes(10);
    const target = claimed.find((r) => r.id === id) ?? row;
    if (!deferred(target.response_data)?.claimed_until) {
      Object.assign(deferred(target.response_data), {
        claimed_until: new Date(BASE_CLOCK + clock + 180_000).toISOString(),
        execution_id: null,
        execution_claimed_until: null,
      });
    }
    return target;
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
      assertEquals({ creates, statusReads, publishes, inlineClaims }, { creates: 1, statusReads: 0, publishes: 0, inlineClaims: 1 });
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

    await test.step("a fast new image checkpoints, claims, checks once, publishes and settles inline", async () => {
      reset();
      createDuration = 1;
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals({ creates, statusReads, publishes, inlineClaims }, { creates: 1, statusReads: 1, publishes: 1, inlineClaims: 1 });
      assertEquals(rows.length, 1);
      assertEquals(rows[0].id, IMAGE_ROW);
      assertEquals(rows[0].status, "success");
      assertEquals(rows[0].platform_post_id, "published-image-1");
      assertEquals(deferred(rows[0].response_data).media_type, "IMAGE");
      assertEquals(outbox, 1);
      assertEquals(finalNotificationClaims, 1);
      assert(!logs.some((entry) => entry.metadata &&
        (entry.metadata as Record<string, unknown>).event === "threads_image_handoff_stale"),
      "An unchanged checkpoint must not be misclassified as stale by REST content filters");
    });

    for (const mode of ["refused", "error", "lost"] as const) {
      await test.step(`inline claim ${mode} performs no status or publish traffic and preserves durable recovery`, async () => {
        reset();
        inlineClaimMode = mode;
        const response = await invoke({ at: 1_000 });
        assertEquals(response.status, mode === "refused" ? 200 : 503);
        assertEquals({ creates, statusReads, publishes, settlements }, { creates: 1, statusReads: 0, publishes: 0, settlements: 0 });
        assertEquals(rows.length, 1);
        assertEquals(rows[0].status, "pending");
        assertEquals(pendingReschedules, 0);
      });
    }

    for (const mode of ["error", "lost"] as const) {
      await test.step(`pre-send mark ${mode} acknowledgement sends nothing and preserves the durable marker decision`, async () => {
        reset();
        markMode = mode;
        const response = await invoke({ at: 1_000 });
        assertEquals(response.status, 503);
        assertEquals(publishes, 0);
        assertEquals(rows[0].status, "pending");
        assertEquals(pendingReschedules, 0);
        assertEquals(deferred(rows[0].response_data).publish_attempt_id !== undefined, mode === "lost");
        if (mode === "lost") {
          markMode = "ok";
          leaseImageRow();
          providerStatuses = [{ status: "FINISHED" }];
          const reconciled = await invoke({ resume: IMAGE_ROW });
          assertEquals(reconciled.status, 200, await reconciled.clone().text());
          assertEquals(publishes, 0);
          assertEquals(rows[0].status, "pending");
          assertEquals(deferred(rows[0].response_data).publish_outcome, "uncertain");
        }
      });
    }

    await test.step("a waiting inline image reschedules its authoritative checkpoint after one observation", async () => {
      reset();
      providerStatuses = [{ status: "IN_PROGRESS" }];
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals({ statusReads, publishes, inlineClaims }, { statusReads: 1, publishes: 0, inlineClaims: 1 });
      assertEquals(rows[0].status, "pending");
      assertEquals(deferred(rows[0].response_data).attempts, 1);
      assertEquals(deferred(rows[0].response_data).container_id, CONTAINER);
      assertEquals(pendingReschedules, 1);
      assertEquals(finalNotificationClaims, 0);
    });

    await test.step("inline acknowledged success never falls through to failed settlement when recording fails", async () => {
      reset();
      successSettlementFails = true;
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 503);
      assertEquals({ publishes, settlements }, { publishes: 1, settlements: 1 });
      assertEquals(rows[0].status, "pending");
      assertEquals(finalNotificationClaims, 0);
      successSettlementFails = false;
      leaseImageRow();
      providerStatuses = [{ status: "PUBLISHED" }];
      const reconciled = await invoke({ resume: IMAGE_ROW });
      assertEquals(reconciled.status, 200);
      assertEquals(rows[0].status, "success");
      assertEquals(publishes, 1);
    });

    await test.step("a committed but unacknowledged success settlement recovers finalization without provider traffic", async () => {
      reset();
      successSettlementFails = true;
      successSettlementLost = true;
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 503);
      assertEquals(rows[0].status, "success");
      assertEquals(post.status, "processing");
      assertEquals({ creates, statusReads, publishes, outbox }, { creates: 1, statusReads: 1, publishes: 1, outbox: 1 });
      assertEquals(finalNotificationClaims, 0);
      successSettlementFails = false;
      successSettlementLost = false;
      const recovered = await invoke({ resume: IMAGE_ROW });
      assertEquals(recovered.status, 200, await recovered.clone().text());
      const body = await recovered.json();
      assertEquals(body.post_status, "completed");
      assertEquals(body.notified, true);
      assertEquals({ creates, statusReads, publishes, outbox }, { creates: 1, statusReads: 1, publishes: 1, outbox: 1 });
      assertEquals(finalNotificationClaims, 1);
    });

    await test.step("an 8 second inline marker releases proven-unsent state and later cron sends exactly once", async () => {
      reset();
      markDuration = 8_000;
      statusHook = () => { clock = 110_000; };
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals({ creates, statusReads, publishes, releases }, { creates: 1, statusReads: 1, publishes: 0, releases: 1 });
      assertEquals(rows[0].status, "pending");
      assertEquals(deferred(rows[0].response_data).publish_attempt_id, undefined);
      assertEquals(pendingReschedules, 1);
      markDuration = 0;
      statusHook = null;
      leaseImageRow();
      providerStatuses = [{ status: "FINISHED" }];
      const recovered = await invoke({ resume: IMAGE_ROW });
      assertEquals(recovered.status, 200, await recovered.clone().text());
      assertEquals(publishes, 1);
      assertEquals(rows[0].status, "success");
    });

    for (const mode of ["false", "error", "lost"] as const) {
      await test.step(`definitely-unsent release ${mode} cannot send or reschedule stale JSON`, async () => {
        reset();
        markDuration = 8_000;
        releaseMode = mode;
        statusHook = () => { clock = 110_000; };
        const response = await invoke({ at: 1_000 });
        assertEquals(response.status, 503);
        assertEquals(publishes, 0);
        assertEquals(rows[0].status, "pending");
        assertEquals(pendingReschedules, 0);
        assertEquals(finalNotificationClaims, 0);
        if (mode === "lost") {
          markDuration = 0;
          statusHook = null;
          releaseMode = "ok";
          leaseImageRow();
          providerStatuses = [{ status: "FINISHED" }];
          const recovered = await invoke({ resume: IMAGE_ROW });
          assertEquals(recovered.status, 200, await recovered.clone().text());
          assertEquals(publishes, 1);
          assertEquals(rows[0].status, "success");
        }
      });
    }

    await test.step("two Threads accounts keep independent inline rows and one final notification", async () => {
      reset();
      accounts = [threadsAccount(), secondThreadsAccount()];
      providerStatuses = [{ status: "FINISHED" }, { status: "FINISHED" }];
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT, THREADS_ACCOUNT_2] };
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals({ creates, statusReads, publishes, settlements }, { creates: 2, statusReads: 2, publishes: 2, settlements: 2 });
      assertEquals(rows.map((row) => row.id).sort(), [IMAGE_ROW, IMAGE_ROW_2].sort());
      assertEquals(rows.map((row) => row.status), ["success", "success"]);
      assertEquals(rows.map((row) => row.social_account_id).sort(), [THREADS_ACCOUNT, THREADS_ACCOUNT_2].sort());
      assertEquals(rows.map((row) => row.platform_post_id).sort(), ["published-image-1", "published-image-2"]);
      assertEquals(outbox, 2);
      assertEquals(finalNotificationClaims, 1);
    });

    await test.step("an inline Threads success followed by Facebook preserves sibling order and effects", async () => {
      reset();
      accounts = [threadsAccount(), facebookAccount()];
      post.platforms = ["threads", "facebook"];
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT, FACEBOOK_ACCOUNT] };
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json();
      assertEquals(body.platform_results.map((result: Record<string, unknown>) => result.platform), ["threads", "facebook"]);
      assertEquals(rows.filter((row) => row.status === "success").length, 2);
      assertEquals(outbox, 2);
      assertEquals(finalNotificationClaims, 1);
    });

    await test.step("PUBLISHED settles without a resend or a fabricated provider post ID", async () => {
      reset();
      await checkpointForResume();
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
      await checkpointForResume();
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
      await checkpointForResume();
      post.metadata = { ...(post.metadata as Record<string, unknown>), pinterest_post_type: "image" };
      leaseImageRow();
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 200);
      assertEquals(rows[0].status, "success");
      assertEquals(publishes, 1);
    });

    await test.step("a missing image lease persists a refusal log before returning", async () => {
      reset();
      await checkpointForResume();
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 503);
      assert(logs.some((entry) => (entry.metadata as Record<string, unknown> | undefined)?.event === "threads_image_lease_missing"));
      assertEquals(publishes, 0);
    });

    await test.step("an unanswered publish reconciles PUBLISHED without sending twice", async () => {
      reset();
      await checkpointForResume();
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

    await test.step("JSON null from publish is an unknown outcome and never permits a second send", async () => {
      reset();
      await checkpointForResume();
      leaseImageRow();
      publishMode = "null";
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 200);
      assertEquals(rows[0].status, "pending");
      assertEquals(deferred(rows[0].response_data).publish_outcome, "uncertain");
      leaseImageRow();
      providerStatuses = [{ status: "FINISHED" }];
      await invoke({ resume: IMAGE_ROW });
      assertEquals(publishes, 1);
    });

    await test.step("a direct override cannot replace the attempt owning a pending image checkpoint", async () => {
      reset();
      await checkpointForResume();
      const firstClaim = post.processing_started_at;
      const response = await invoke({ at: 2_000, accountIds: [THREADS_ACCOUNT] });
      assertEquals(response.status, 500);
      assertEquals(post.processing_started_at, firstClaim);
      assertEquals(creates, 1);
      assertEquals(rows[0].status, "pending");
    });

    await test.step("FINISHED after an unanswered publish never authorizes a blind resend and expires unresolved", async () => {
      reset();
      await checkpointForResume();
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
      await checkpointForResume();
      leaseImageRow();
      providerStatuses = [{ status: "FINISHED" }, { status: "FINISHED" }];
      const responses = await Promise.all([invoke({ resume: IMAGE_ROW }), invoke({ resume: IMAGE_ROW })]);
      assertEquals(responses.map((response) => response.status), [200, 200]);
      assertEquals(publishes, 1);
      assertEquals(rows.filter((row) => row.status === "success").length, 1);
      assert(logs.some((entry) => (entry.metadata as Record<string, unknown> | undefined)?.event === "threads_image_execution_refused"));
    });

    await test.step("a duplicate first request loses a stale checkpoint race without touching the winner", async () => {
      reset();
      containerIdOverride = "dynamic";
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT], webhook_url: "https://webhook-fixture.invalid/hook" };
      let notifyFirstAtCheckpoint!: () => void;
      const firstAtCheckpoint = new Promise<void>((resolve) => { notifyFirstAtCheckpoint = resolve; });
      let releaseFirstCheckpoint!: () => void;
      const firstCheckpointHeld = new Promise<void>((resolve) => { releaseFirstCheckpoint = resolve; });
      let checkpointCalls = 0;
      beforeCheckpointHook = () => {
        checkpointCalls++;
        if (checkpointCalls === 1) {
          notifyFirstAtCheckpoint();
          return firstCheckpointHeld;
        }
      };
      const staleRequest = invoke({ at: 1_000 });
      await firstAtCheckpoint;
      const winner = await invoke({ at: 2_000 });
      assertEquals(winner.status, 200, await winner.clone().text());
      const winningExecution = deferred(rows[0].response_data).execution_id;
      releaseFirstCheckpoint();
      const stale = await staleRequest;
      console.log("DEBUG stale status:", stale.status, "text:", await stale.clone().text());
      assertEquals(stale.status, 503);
      assert((await stale.text()).includes("Threads container checkpoint could not be confirmed"));
      assert(logs.some((entry) => (entry.metadata as Record<string, unknown> | undefined)?.event === "threads_checkpoint_refused"));
      assertEquals(publishes, 1);
      assertEquals(rows.filter((row) => row.id === IMAGE_ROW).length, 1);
      assertEquals(rows[0].status, "success");
      assertEquals(deferred(rows[0].response_data).execution_id, winningExecution);
      assertEquals(outbox, 1);
      assertEquals(finalNotificationClaims, 1);
      assertEquals(deliveredNotifications.length, 1);
      assertEquals(deliveredNotifications[0].event, "post.completed");
    });

    await test.step("waiting keeps the same image checkpoint and increments bounded attempts", async () => {
      reset();
      await checkpointForResume();
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
        await checkpointForResume();
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
      await checkpointForResume();
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
      await checkpointForResume();
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
        await checkpointForResume();
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
        await checkpointForResume();
        leaseImageRow();
        if (change === "edit") post.caption = "changed synthetic caption";
        else post.status = "failed";
        const response = await invoke({ resume: IMAGE_ROW });
        assertEquals(response.status, 200, await response.clone().text());
        assertEquals({ statusReads, publishes }, { statusReads: 0, publishes: 0 });
        assertEquals(rows[0].status, "failed");
        assertEquals(post.status, change === "edit" ? "processing" : "failed");
      }
    });

    await test.step("wrong account scope and credential refresh conflicts retain pending state without provider calls", async () => {
      for (const conflict of ["account", "credential"] as const) {
        reset();
        await checkpointForResume();
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
        await checkpointForResume();
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
        const response = await checkpointForResume();
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
      const response = await checkpointForResume();
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(rows.filter((row) => row.platform === "facebook" && row.status === "success").length, 1);
      assertEquals(rows.filter((row) => row.id === IMAGE_ROW && row.status === "pending").length, 1);
      assertEquals(post.status, "processing");
      assertEquals(outbox, 1);
    });

    await test.step("same-attempt reconciler completion is finalized once without a stale-parent warning", async () => {
      reset();
      checkpointHook = () => {
        rows[0].status = "success";
        post.status = "completed";
        post.metadata = { ...(post.metadata as Record<string, unknown>), final_notified_at: post.processing_started_at };
        finalNotificationClaims++;
      };
      const response = await checkpointForResume();
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals((await response.json()).status, "completed");
      assertEquals(post.status, "completed");
      assertEquals(finalNotificationClaims, 1);
      assert(!logs.some((entry) => entry.metadata && (entry.metadata as Record<string, unknown>).event === "threads_image_handoff_stale"));
    });

    await test.step("a newer claim and edit during handoff win over the original parent write", async () => {
      reset();
      checkpointHook = () => {
        post.processing_started_at = "newer-claim";
        post.caption = "newer edit";
      };
      const response = await checkpointForResume();
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(post.processing_started_at, "newer-claim");
      assertEquals(post.caption, "newer edit");
      assert(logs.some((entry) => entry.metadata && (entry.metadata as Record<string, unknown>).event === "threads_image_handoff_stale"));
    });

    await test.step("stale PUBLISHED settlement preserves a newer parent and sends no stale notification", async () => {
      reset();
      await checkpointForResume();
      const row = leaseImageRow();
      providerStatuses = [{ status: "PUBLISHED" }];
      statusHook = () => {
        post.processing_started_at = "newer-parent-claim";
        post.caption = "newer parent content";
      };
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(row.status, "success");
      assertEquals(post.status, "processing");
      assertEquals(post.processing_started_at, "newer-parent-claim");
      assertEquals(post.caption, "newer parent content");
      assertEquals(finalNotificationClaims, 0);
    });

    await test.step("status-only cancellation survives old image settlement and finalization", async () => {
      reset();
      await checkpointForResume();
      const row = leaseImageRow();
      providerStatuses = [{ status: "PUBLISHED" }];
      statusHook = () => { post.status = "pending"; };
      const response = await invoke({ resume: IMAGE_ROW });
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(row.status, "success");
      assertEquals(post.status, "pending");
      assertEquals(post.caption, "Synthetic image caption");
      assertEquals(finalNotificationClaims, 0);
    });

    await test.step("a handoff state read error returns 503 and preserves the parent and checkpoint", async () => {
      reset();
      parentReadError = true;
      const response = await checkpointForResume();
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
      await checkpointForResume();
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

    await test.step("A02: status-only failed cancellation rejects admission and leaves post failed with zero sends", async () => {
      reset();
      accounts = [threadsAccount(), facebookAccount()];
      post.platforms = ["threads", "facebook"];
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT, FACEBOOK_ACCOUNT], webhook_url: "https://webhook-fixture.invalid/hook" };

      let notifyFirstAtCheckpoint!: () => void;
      const firstAtCheckpoint = new Promise<void>((resolve) => { notifyFirstAtCheckpoint = resolve; });
      let releaseFirstCheckpoint!: () => void;
      const firstCheckpointHeld = new Promise<void>((resolve) => { releaseFirstCheckpoint = resolve; });
      let checkpointCalls = 0;
      beforeCheckpointHook = () => {
        checkpointCalls++;
        if (checkpointCalls === 1) {
          notifyFirstAtCheckpoint();
          return firstCheckpointHeld;
        }
      };

      const runningRequest = invoke({ at: 1_000 });
      await firstAtCheckpoint;

      // Status-only cancellation without settlement_rollup_at
      post.status = "failed";

      releaseFirstCheckpoint();
      const response = await runningRequest;
      assertEquals(post.status, "failed");
      assertEquals(publishes, 0);
      assert(rows.every((row) => row.status !== "success"));

      // Sub-case: cancellation after sibling rollup strips provenance and refuses admission
      reset();
      accounts = [facebookAccount(), threadsAccount()];
      post.platforms = ["facebook", "threads"];
      post.metadata = { selected_account_ids: [FACEBOOK_ACCOUNT, THREADS_ACCOUNT] };
      beforeCheckpointHook = () => {
        // Sibling failure rolled up parent:
        post.status = "failed";
        post.metadata = {
          ...(post.metadata as Record<string, unknown> || {}),
          settlement_rollup_at: post.processing_started_at,
          settlement_rollup_status: "failed",
          settlement_rollup_processing_started_at: post.processing_started_at,
        };
        // Owner status-only cancellation fires trigger: deletes settlement_rollup provenance
        delete (post.metadata as Record<string, unknown>).settlement_rollup_at;
        delete (post.metadata as Record<string, unknown>).settlement_rollup_status;
        delete (post.metadata as Record<string, unknown>).settlement_rollup_processing_started_at;
      };
      const cancelledResp = await invoke({ at: 1_000 });
      assertEquals(cancelledResp.status, 409);
      assertEquals(post.status, "failed");
      assertEquals(publishes, 0);

      // Sub-case: paired legitimate failure-first admission success (Facebook fails, rollup preserved, Threads admitted and succeeds)
      reset();
      accounts = [facebookAccount(), threadsAccount()];
      post.platforms = ["facebook", "threads"];
      post.metadata = { selected_account_ids: [FACEBOOK_ACCOUNT, THREADS_ACCOUNT] };
      beforeCheckpointHook = () => {
        // Legitimate sibling rollup preserved
        post.status = "failed";
        post.metadata = {
          ...(post.metadata as Record<string, unknown> || {}),
          settlement_rollup_at: post.processing_started_at,
          settlement_rollup_status: "failed",
          settlement_rollup_processing_started_at: post.processing_started_at,
        };
      };
      const legitimateRun = await invoke({ at: 1_000 });
      assertEquals(legitimateRun.status, 200, await legitimateRun.clone().text());
      assertEquals(rows.some((r) => r.platform === "threads" && r.status === "success"), true);
      assertEquals(post.status, "completed");
      assertEquals(publishes, 1);
    });

    await test.step("A03: lost settlement ACK recovers terminal row via ordinary cron reconciliation and delivers one notification", async () => {
      reset();
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT], webhook_url: "https://webhook-fixture.invalid/hook" };
      successSettlementFails = true;
      successSettlementLost = true;
      const initialResponse = await invoke({ at: 1_000 });
      assertEquals(initialResponse.status, 503);
      assertEquals(rows[0].status, "success");
      assertEquals(post.status, "processing");
      assertEquals(finalNotificationClaims, 0);
      assertEquals(deliveredNotifications.length, 0);

      // Ordinary cron reconciliation path: row is claimed by claim_deferred_publishes
      successSettlementFails = false;
      successSettlementLost = false;
      leaseImageRow();
      const recovered = await invoke({ resume: IMAGE_ROW });
      assertEquals(recovered.status, 200, await recovered.clone().text());
      const body = await recovered.json();
      assertEquals(body.post_status, "completed");
      assertEquals(body.notified, true);
      assertEquals(finalNotificationClaims, 1);
      assertEquals(deliveredNotifications.length, 1);
      assertEquals(deliveredNotifications[0].event, "post.completed");
    });

    await test.step("A03: lost finalizer ACK commits parent and cron claims terminal row to deliver notification once without resend", async () => {
      reset();
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT], webhook_url: "https://webhook-fixture.invalid/hook" };
      finalizerMode = "lost";
      const initialResponse = await invoke({ at: 1_000 });
      assertEquals(initialResponse.status, 503);
      assertEquals(rows[0].status, "success");
      assertEquals(post.status, "completed");
      assertEquals(deliveredNotifications.length, 0);
      assertEquals(((post.metadata as Record<string, unknown>).final_notification_intent as Record<string, unknown>)?.notified, false);

      // Cron claims the terminal row via claimDeferredPublishes after lease expiry
      clock += 181_000;
      finalizerMode = "ok";
      const claimedRows = claimDeferredPublishes(10);
      assertEquals(claimedRows.length, 1);
      assertEquals(claimedRows[0].id, IMAGE_ROW);

      const recovered = await invoke({ resume: IMAGE_ROW });
      assertEquals(recovered.status, 200, await recovered.clone().text());
      const body = await recovered.json();
      assertEquals(body.post_status, "completed");
      assertEquals(body.notified, true);
      assertEquals(deliveredNotifications.length, 1);
      assertEquals(deliveredNotifications[0].event, "post.completed");
      assertEquals(((post.metadata as Record<string, unknown>).final_notification_intent as Record<string, unknown>)?.notified, true);
      assertEquals(publishes, 1);
    });

    await test.step("A03: lost finalizer ACK or failed outcome read does not permanently consume notification", async () => {
      reset();
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT], webhook_url: "https://webhook-fixture.invalid/hook" };
      await checkpointForResume();
      const row = leaseImageRow();
      row.status = "success";
      // First recovery attempt: outcome read fails
      parentReadError = true;
      const failedRecovery = await invoke({ resume: IMAGE_ROW });
      assertEquals(failedRecovery.status, 200);
      const failedBody = await failedRecovery.json();
      assertEquals(failedBody.notified, false);
      assertEquals(finalNotificationClaims, 0);
      assertEquals(deliveredNotifications.length, 0);
      assertEquals((post.metadata as Record<string, unknown>).final_notified_at, undefined);

      // Second recovery attempt: outcome read succeeds
      parentReadError = false;
      const successRecovery = await invoke({ resume: IMAGE_ROW });
      assertEquals(successRecovery.status, 200);
      const successBody = await successRecovery.json();
      assertEquals(successBody.notified, true);
      assertEquals(finalNotificationClaims, 1);
      assertEquals(deliveredNotifications.length, 1);
      assertEquals(deliveredNotifications[0].event, "post.completed");
    });

    await test.step("A03: multi-account request preserves sibling fan-out when Threads checkpoint is unavailable", async () => {
      reset();
      accounts = [threadsAccount(), facebookAccount()];
      post.platforms = ["threads", "facebook"];
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT, FACEBOOK_ACCOUNT] };
      checkpointMode = "error";
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json();
      assertEquals(body.platform_results.map((r: Record<string, unknown>) => ({ platform: r.platform, status: r.status })), [
        { platform: "threads", status: "pending" },
        { platform: "facebook", status: "success" },
      ]);
      assertEquals(rows.some((r) => r.platform === "facebook" && r.status === "success"), true);
      assertEquals(post.status, "processing");
    });

    await test.step("A04: sibling completeness validates actual target accounts from current attempt", async () => {
      // (a) Omitted IDs (targets all active accounts for post.platforms)
      reset();
      accounts = [threadsAccount(), facebookAccount()];
      post.platforms = ["threads", "facebook"];
      delete (post.metadata as Record<string, unknown>).selected_account_ids;
      // Retained old row from previous attempt
      rows.push({
        id: "facebook-old-row",
        post_id: POST,
        social_account_id: FACEBOOK_ACCOUNT,
        platform: "facebook",
        status: "success",
        platform_post_id: "old-fb",
        platform_post_url: null,
        error_message: null,
        response_data: {},
        created_at: "2025-01-01T00:00:00.000Z",
      });
      await checkpointForResume();
      rows = rows.filter((r) => r.id === IMAGE_ROW || r.id === "facebook-old-row");
      const row = leaseImageRow();
      row.status = "success";
      // Finalize check while Facebook has no row for CURRENT attempt: returns processing
      const resp1 = await invoke({ resume: IMAGE_ROW });
      assertEquals(resp1.status, 200);
      assertEquals((await resp1.json()).post_status, "processing");
      assertEquals(finalNotificationClaims, 0);

      // Now Facebook admits row for current attempt:
      rows.push({
        id: "facebook-current-row",
        post_id: POST,
        social_account_id: FACEBOOK_ACCOUNT,
        platform: "facebook",
        status: "success",
        platform_post_id: "curr-fb",
        platform_post_url: null,
        error_message: null,
        response_data: {},
        created_at: String(post.processing_started_at),
      });
      const resp2 = await invoke({ resume: IMAGE_ROW });
      assertEquals(resp2.status, 200);
      assertEquals((await resp2.json()).post_status, "completed");
      assertEquals(finalNotificationClaims, 1);

      // (b) Inactive account in metadata.selected_account_ids does not block finalization
      reset();
      const inactiveAccount: Account = {
        ...facebookAccount(),
        id: "22000000-0000-4000-8000-000000000099",
        is_active: false,
      };
      accounts = [threadsAccount(), inactiveAccount];
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT, inactiveAccount.id] };
      const respInactive = await invoke({ at: 1_000 });
      assertEquals(respInactive.status, 200);
      assertEquals(post.status, "completed");
      assertEquals(finalNotificationClaims, 1);

      // (c) Two Threads accounts: both must have rows before finalization
      reset();
      accounts = [threadsAccount(), secondThreadsAccount()];
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT, THREADS_ACCOUNT_2] };
      await checkpointForResume();
      rows = rows.filter((r) => r.id === IMAGE_ROW);
      const rowT1 = leaseImageRow();
      rowT1.status = "success";
      const respTwoT1 = await invoke({ resume: IMAGE_ROW });
      assertEquals(respTwoT1.status, 200);
      assertEquals((await respTwoT1.json()).post_status, "processing");
      assertEquals(finalNotificationClaims, 0);

      rows.push({
        id: IMAGE_ROW_2,
        post_id: POST,
        social_account_id: THREADS_ACCOUNT_2,
        platform: "threads",
        status: "success",
        platform_post_id: "published-image-2",
        platform_post_url: null,
        error_message: null,
        response_data: {},
        created_at: String(post.processing_started_at),
      });
      const respTwoT2 = await invoke({ resume: IMAGE_ROW });
      assertEquals(respTwoT2.status, 200);
      assertEquals((await respTwoT2.json()).post_status, "completed");
      assertEquals(finalNotificationClaims, 1);
    });

    await test.step("A04: targeted retry with retained sibling success completes and delivers one notification without re-running sibling", async () => {
      reset();
      accounts = [threadsAccount(), facebookAccount()];
      post.platforms = ["threads", "facebook"];
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT, FACEBOOK_ACCOUNT], webhook_url: "https://webhook-fixture.invalid/hook" };

      // Sibling Facebook already succeeded in previous attempt
      rows.push({
        id: "facebook-prior-row",
        post_id: POST,
        social_account_id: FACEBOOK_ACCOUNT,
        platform: "facebook",
        status: "success",
        platform_post_id: "facebook-post-prior",
        platform_post_url: null,
        error_message: null,
        response_data: {},
        created_at: "2026-01-01T00:00:00.000Z",
      });

      // Targeted retry only targets Threads account
      const retryResp = await invoke({ at: 1_000, accountIds: [THREADS_ACCOUNT] });
      assertEquals(retryResp.status, 200, await retryResp.clone().text());
      assertEquals(rows.some(r => r.platform === "threads" && r.status === "success"), true);
      assertEquals(post.status, "completed");
      assertEquals(deliveredNotifications.length, 1);
      assertEquals(deliveredNotifications[0].event, "post.completed");
      assertEquals(finalNotificationClaims, 1);
    });

    await test.step("A06: Threads checkpoint lost ACK and owner cancellation before sibling completes preserves cancellation", async () => {
      reset();
      accounts = [threadsAccount(), facebookAccount()];
      post.platforms = ["threads", "facebook"];
      post.metadata = { selected_account_ids: [THREADS_ACCOUNT, FACEBOOK_ACCOUNT], webhook_url: "https://webhook-fixture.invalid/hook" };

      checkpointMode = "lost";

      // Hook before Facebook photo creation to simulate owner cancellation
      let cancelOnce = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.hostname === "graph.facebook.com" && !cancelOnce) {
          cancelOnce = true;
          post.status = "canceled";
        }
        return await originalFetch(input, init);
      };

      try {
        const response = await invoke({ at: 1_000 });
        assertEquals(post.status, "canceled");
        assertEquals(deliveredNotifications.length, 0);
        assertEquals(finalNotificationClaims, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    for (const failure of ["http", "transport"] as const) {
      await test.step(`failed ${failure} webhook delivery leaves the intent recoverable without republishing`, async () => {
        reset();
        webhookFailure = failure;
        const initial = await invoke({ at: 1_000 });
        assertEquals(initial.status, 200);
        const intent = (post.metadata as Record<string, unknown>).final_notification_intent as Record<string, unknown>;
        assertEquals(intent.notified, false);
        assertEquals((post.metadata as Record<string, unknown>).final_notified_at, undefined);
        assertEquals(deliveredNotifications.length, 0);
        assertEquals(publishes, 1);

        webhookFailure = "none";
        clock += 181_000;
        let freshHandler: Handler | undefined;
        Deno.serve = ((registered: Handler) => {
          freshHandler = registered;
          return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
        }) as typeof Deno.serve;
        try {
          if (failure === "http") await import("./index.ts?notification-recovery-http");
          else await import("./index.ts?notification-recovery-transport");
        } finally {
          Deno.serve = previousServe;
        }
        const summary = await runReconcile({
          claim: async (limit) => claimDeferredPublishes(limit).map((row) => ({ platform_post_id: row.id, post_id: row.post_id })),
          resume: async (row) => {
            const response = await freshHandler!(new Request(`${ORIGIN}/functions/v1/process-post`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
              body: JSON.stringify({ post_id: row.post_id, resume_platform_post_id: row.platform_post_id }),
            }));
            const body = await response.json();
            return { ok: response.ok, status: body.status };
          },
          sweep: async () => ({ posts: 0, rows_failed: 0 }),
          log: async () => {},
        });
        assertEquals(summary.claimed, 1);
        assertEquals(summary.resume_errors, 0);
        assertEquals(((post.metadata as Record<string, unknown>).final_notification_intent as Record<string, unknown>).notified, true);
        assertEquals(deliveredNotifications.length, 1);
        assertEquals(deliveredNotifications[0].event, "post.completed");
        assertEquals(publishes, 1);
      });
    }

    await test.step("200 independent ready first requests complete inline without cron or duplicate effects", async () => {
      const totals = { creates: 0, statusReads: 0, publishes: 0, settlements: 0, outbox: 0, notifications: 0, deliveredNotifications: 0 };
      for (let request = 0; request < 200; request++) {
        reset();
        createDuration = 1;
        const response = await invoke({ at: 1_000 });
        assertEquals(response.status, 200, `request ${request}: ${await response.clone().text()}`);
        assertEquals(rows.length, 1, `request ${request} uses one stable row`);
        assertEquals(rows[0].id, IMAGE_ROW);
        assertEquals(rows[0].status, "success", `request ${request} settles inline`);
        totals.creates += creates;
        totals.statusReads += statusReads;
        totals.publishes += publishes;
        totals.settlements += settlements;
        totals.outbox += outbox;
        totals.notifications += finalNotificationClaims;
        totals.deliveredNotifications += deliveredNotifications.length;
      }
      assertEquals(totals, { creates: 200, statusReads: 200, publishes: 200, settlements: 200, outbox: 200, notifications: 200, deliveredNotifications: 200 });
    });

    await test.step("A06: legacy pending sibling rollup restores parent status to processing", async () => {
      reset();
      const attemptAt = new Date().toISOString();
      post.processing_started_at = attemptAt;
      post.status = "completed";
      post.metadata = {
        settlement_rollup_at: attemptAt,
        settlement_rollup_processing_started_at: attemptAt,
        settlement_rollup_status: "completed",
      };
      const response = await fetch(`${ORIGIN}/rest/v1/posts?id=eq.${POST}&status=eq.completed&processing_started_at=eq.${attemptAt}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "processing" }),
      });
      assertEquals(response.ok, true);
      assertEquals(post.status, "processing");
    });

    await test.step("A06: native Threads text post does not call image checkpoint or finalizer", async () => {
      reset();
      let checkpointCalled = false;
      checkpointHook = () => { checkpointCalled = true; };
      post.media_file_ids = [];
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200);
      assertEquals(checkpointCalled, false);
      assertEquals(finalizerCalls, 0);
    });

    await test.step("A06: definite create failure has no image finalizer", async () => {
      reset();
      createMode = "error";
      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.status, "failed");
      assertEquals(finalizerCalls, 0);
      createMode = "ok";
    });

    await test.step("A04: two historical rows for same account: only authorized row included", async () => {
      reset();
      accounts = [threadsAccount(), secondThreadsAccount()];
      const priorSuccessRowId = "44000000-0000-4000-8000-000000000091";
      const priorFailedRowId = "44000000-0000-4000-8000-000000000092";
      rows.push({
        id: priorSuccessRowId,
        post_id: POST,
        social_account_id: THREADS_ACCOUNT_2,
        platform: "threads",
        status: "success",
        platform_post_id: "prior-success",
        platform_post_url: "https://threads.net/p/prior-success",
        error_message: null,
        response_data: {},
        created_at: new Date(Date.now() - 3600_000).toISOString(),
      });
      rows.push({
        id: priorFailedRowId,
        post_id: POST,
        social_account_id: THREADS_ACCOUNT_2,
        platform: "threads",
        status: "failed",
        platform_post_id: null,
        platform_post_url: null,
        error_message: "old failure",
        response_data: {},
        created_at: new Date(Date.now() - 1800_000).toISOString(),
      });

      post.metadata = {
        selected_account_ids: [THREADS_ACCOUNT],
        webhook_url: "https://webhook-fixture.invalid/hook",
      };

      const response = await invoke({ at: 1_000 });
      assertEquals(response.status, 200);
      const intent = (post.metadata as Record<string, unknown>).final_notification_intent as Record<string, unknown>;
      assert(intent);
      const authorizedIds = intent.authorized_platform_post_ids as string[];
      assert(authorizedIds.includes(priorSuccessRowId));
      assert(!authorizedIds.includes(priorFailedRowId));
    });

    assertEquals(unexpected, []);
  } finally {
    globalThis.fetch = previousFetch;
    Deno.serve = previousServe;
    Date.now = previousNow;
    globalThis.Date = previousDate;
    for (const [key, previous] of environment) {
      if (previous === undefined) Deno.env.delete(key);
      else Deno.env.set(key, previous);
    }
  }
});
