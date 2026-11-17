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
    "legacy_notification_candidate",
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
  let emailMode: "ok" | "semantic_failure" | "invalid" = "ok";
  let registeredEndpoints: string[] = [];
  let failingRegisteredEndpoint = false;
  let priorSuccessReadFailure = false;
  let newerClaimOnReadFailure = false;
  let profileEmailEnabled = false;
  let legacyVideoMode = false;
  let beforeLegacyRestore: (() => void) | null = null;
  let legacyRestoreFailure = false;
  let legacyNotificationClaimFailure: "none" | "read" | "read_persistent" | "missing" | "update" = "none";
  let legacyNotificationClaimReads = 0;
  let recoveryRowReadFailure = false;
  let recoveryClaims = 0;
  let refreshCandidateOnClaim = false;
  let instagramFeedFailureMode: "none" | "error" | "missing" | "ok" = "none";
  let instagramStoryPublishes = 0;
  let enrollmentFailure: "none" | "error" | "lost" = "none";
  let missingMedia = false;
  let closedRetainedIds: string[] = [];
  let closedFanoutCalls = 0;
  let legacySiblingReadSnapshot = false;
  let notificationScopeMode: "ok" | "missing" | "empty" | "deleted" | "changed" | "parent_changed" | "content_changed" | "settings_changed" | "attempt_changed" | "content_read_error" = "ok";
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
    emailMode = "ok";
    notificationScopeMode = "ok";
    registeredEndpoints = [];
    failingRegisteredEndpoint = false;
    priorSuccessReadFailure = false;
    newerClaimOnReadFailure = false;
    profileEmailEnabled = false;
    legacyVideoMode = false;
    beforeLegacyRestore = null;
    legacyRestoreFailure = false;
    legacyNotificationClaimFailure = "none";
    legacyNotificationClaimReads = 0;
    recoveryRowReadFailure = false;
    recoveryClaims = 0;
    refreshCandidateOnClaim = false;
    instagramFeedFailureMode = "none";
    instagramStoryPublishes = 0;
    enrollmentFailure = "none";
    missingMedia = false;
    closedRetainedIds = [];
    closedFanoutCalls = 0;
    legacySiblingReadSnapshot = false;
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
    if (instagramFeedFailureMode !== "none" && payload.p_platform === "instagram" && payload.p_status === "failed") {
      if (instagramFeedFailureMode === "error") return Response.json({ message: "fixture feed failure write unavailable" }, { status: 500 });
      if (instagramFeedFailureMode === "missing") return Response.json({});
    }
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
        post.metadata = { ...(post.metadata as Record<string, unknown> || {}), settlement_rollup_at: new Date().toISOString(),
          settlement_rollup_status: post.status, settlement_rollup_processing_started_at: post.processing_started_at };
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
      if (failingRegisteredEndpoint && url.pathname === "/bad") return new Response("gone", { status: 410 });
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
      if (emailMode === "invalid") return Response.json(null);
      if (emailMode === "semantic_failure") {
        return Response.json({ success: false, message: "Email not configured" });
      }
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
      if (instagramFeedFailureMode !== "none") {
        if (request.method === "POST" && url.pathname.endsWith("/fixture-instagram-user/media")) {
          const body = await request.json();
          return body.media_type === "STORIES" ? Response.json({ id: "fixture-story-container" }) :
            Response.json({ error: { message: "fixture feed rejected" } });
        }
        if (url.pathname.endsWith("/fixture-story-container")) return Response.json({ status_code: "FINISHED" });
        if (request.method === "POST" && url.pathname.endsWith("/fixture-instagram-user/media_publish")) {
          instagramStoryPublishes++;
          return Response.json({ id: "fixture-live-story" });
        }
        if (url.pathname.endsWith("/fixture-live-story")) return Response.json({ permalink: "https://instagram.fixture/live-story" });
      }
      if (legacyVideoMode && request.method === "POST" && url.pathname.endsWith("/fixture-instagram-user/media")) {
        clock += 40_000;
        return Response.json({ id: "fixture-instagram-container" });
      }
      if (legacyVideoMode && url.pathname.endsWith("/fixture-instagram-container")) {
        clock += 40_000;
        return Response.json({ status_code: "IN_PROGRESS" });
      }
      if (legacyVideoMode && url.pathname.endsWith("/videos") && !facebookFail) return Response.json({ id: "facebook-video-1" });
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
        if (legacyNotificationClaimFailure === "update" &&
          (update.metadata as Record<string, unknown> | undefined)?.final_notified_at) {
          return Response.json({ message: "fixture legacy marker update unavailable" }, { status: 500 });
        }
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
      if (legacySiblingReadSnapshot && url.searchParams.get("select") === "*") {
        legacySiblingReadSnapshot = false;
        // The sibling read processing before the image's concurrent finalization.
        const snapshot = structuredClone(post);
        snapshot.status = "processing";
        delete (snapshot.metadata as Record<string, unknown>).final_notification_intent;
        return Response.json(snapshot);
      }
      if (url.searchParams.get("select") === "metadata,processing_started_at") {
        legacyNotificationClaimReads++;
        if (legacyNotificationClaimFailure === "missing") return Response.json(null);
        if (legacyNotificationClaimFailure === "read_persistent" ||
          (legacyNotificationClaimFailure === "read" && legacyNotificationClaimReads === 1)) {
          return Response.json({ message: "fixture legacy marker read unavailable" }, { status: 500 });
        }
      }
      if (notificationScopeMode === "content_read_error" && finalNotificationClaims > 0 && url.searchParams.get("select") === "*") {
        return Response.json({ message: "fixture notification content read unavailable" }, { status: 500 });
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
      if (missingMedia) return Response.json([]);
      return Response.json((post.media_file_ids as string[]).map((id) => ({
        id,
        file_path: `https://media-fixture.invalid/${id}.${legacyVideoMode ? "mp4" : "jpg"}`,
        file_type: legacyVideoMode ? "video" : "image",
        storage_bucket: "openinary",
        mime_type: legacyVideoMode ? "video/mp4" : "image/jpeg",
      })));
    }
    if (table === "media_file_providers") return Response.json([]);
    if (table === "app_settings") {
      if (url.searchParams.get("key")?.startsWith("like.n8n_webhook_")) {
        return Response.json(registeredEndpoints.map(webhook_url => ({ value: { webhook_url, is_active: true, events: ["*"] } })));
      }
      return Response.json(null);
    }
    if (table === "platform_posts") {
      if (recoveryRowReadFailure && request.method === "GET") return Response.json({ message: "fixture result read unavailable" }, { status: 500 });
      if (priorSuccessReadFailure && request.method === "GET" && url.searchParams.get("status") === "eq.success") {
        if (newerClaimOnReadFailure) post.processing_started_at = new Date(BASE_CLOCK + clock + 1).toISOString();
        return Response.json({ message: "fixture prior success read failed" }, { status: 500 });
      }
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
          attempt_started_at: payload.p_expected_processing_started_at,
        };
      }
      if (Array.isArray(payload.p_retained_platform_post_ids)) {
        for (const rid of payload.p_retained_platform_post_ids as string[]) {
          const match = rows.find(r => r.id === rid && r.post_id === post.id && r.status === "success");
          if (!match) {
            return Response.json({ message: "record_threads_image_checkpoint: retained result is not an authoritative success for this post" }, { status: 400 });
          }
        }
        post.metadata = {
          ...(post.metadata as Record<string, unknown> || {}),
          attempt_retained_platform_post_ids: payload.p_retained_platform_post_ids,
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
      if (releaseMode === "error") return Response.json({ message: "release unavailable" }, { status: 500 });
      delete identity.publish_attempt_id;
      releases++;
      if (releaseMode === "lost") return Response.json({ message: "lost release acknowledgement" }, { status: 500 });
      return Response.json(true);
    }
    if (table === "rpc/finalize_threads_image_attempt") {
      finalizerCalls++;
      const payload = await request.json() as Record<string, unknown>;
      if (finalizerMode === "error") return Response.json({ message: "fixture parent read failure" }, { status: 500 });
      const currentContent = contentFence(post);
      const expectedContent = normalizeFence(payload.p_expected_content);
      const stale = post.processing_started_at !== payload.p_expected_processing_started_at ||
        await hashRequest(currentContent) !== await hashRequest(expectedContent);
      if (stale) return Response.json({ status: post.status, stale: true, notify: false });
      const metadata = { ...((post.metadata as Record<string, unknown> | null) ?? {}) };
      const candidate = metadata.legacy_notification_candidate as Record<string, unknown> | undefined;
      if (candidate?.requires_image_fanout_closure === true && candidate.fanout_closed !== true) {
        return Response.json({ status: post.status, stale: false, notify: false, reason: "fanout_not_closed" });
      }
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

      const retainedRowIds: string[] = metadata.attempt_started_at === payload.p_expected_processing_started_at && Array.isArray(metadata.attempt_retained_platform_post_ids)
        ? (metadata.attempt_retained_platform_post_ids as string[])
        : [];

      const started = String(payload.p_expected_processing_started_at);
      const missingTargets = targetAccountIds.filter(targetId => {
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
          (retainedRowIds.includes(row.id) && row.status === "success") ||
          (targetAccountIds.includes(row.social_account_id) &&
            (deferred(row.response_data)?.attempt_started_at === started || (row.created_at ?? "") >= started))
        )
      );

      if (attemptRows.length === 0 && retainedRowIds.length === 0) {
        return Response.json({ status: post.status, stale: false, notify: false });
      }
      if (attemptRows.some((row) => row.status === "pending")) {
        return Response.json({ status: "processing", stale: false, notify: false });
      }

      const hasSuccess = attemptRows.some((row) => row.status === "success");
      post.status = hasSuccess ? "completed" : "failed";
      const authorizedRowIds = [
        ...attemptRows.map(r => r.id)
      ];
      post.metadata = {
        ...(post.metadata as Record<string, unknown> || {}),
        final_notification_intent: {
          created_at: new Date().toISOString(),
          notified: false,
          status: post.status,
          attempt_started_at: payload.p_expected_processing_started_at,
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
      const candidate = meta.legacy_notification_candidate as Record<string, unknown> | undefined;
      if (candidate?.requires_image_fanout_closure === true && candidate.fanout_closed !== true) {
        return Response.json({ claimed: false, status: post.status, error: "fanout_not_closed" });
      }
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
      const authorizedIds = intent.authorized_platform_post_ids as string[];
      const statuses = Object.fromEntries(rows.filter(row => authorizedIds.includes(row.id)).map(row => [row.id, row.status]));
      if (notificationScopeMode === "deleted") rows = rows.filter(row => row.id !== authorizedIds[0]);
      if (notificationScopeMode === "changed") rows.find(row => row.id === authorizedIds[0])!.status = "failed";
      if (notificationScopeMode === "parent_changed") post.status = post.status === "completed" ? "failed" : "completed";
      if (notificationScopeMode === "content_changed") post.caption = "Owner edited caption after notification claim";
      if (notificationScopeMode === "settings_changed") post.metadata = { ...meta, instagram_share_to_feed: false };
      if (notificationScopeMode === "attempt_changed") post.processing_started_at = new Date(BASE_CLOCK + clock + 86_400_000).toISOString();
      return Response.json({
        claimed: true,
        status: post.status,
        claim_id: intent.claim_id,
        ...(notificationScopeMode === "missing" ? {} : {
          authorized_platform_post_ids: notificationScopeMode === "empty" ? [] : authorizedIds,
          authorized_platform_post_statuses: statuses,
          delivery_acks: intent.delivery_acks ?? {},
        }),
      });
    }
    if (table === "rpc/record_deferred_platform_post") {
      const payload = await request.json() as Record<string, unknown>;
      const account = accounts.find(a => a.id === payload.p_social_account_id && a.user_id === post.user_id);
      assert(account);
      const id = crypto.randomUUID();
      rows.push({ id, post_id: POST, social_account_id: account.id, platform: account.platform, status: "pending",
        platform_post_id: null, platform_post_url: null, error_message: null,
        response_data: payload.p_response_data as Record<string, unknown>, created_at: new Date().toISOString() });
      return Response.json(id);
    }
    if (table === "rpc/restore_legacy_pending_post") {
      beforeLegacyRestore?.();
      if (legacyRestoreFailure) return Response.json({ message: "fixture restore unavailable" }, { status: 500 });
      const payload = await request.json() as Record<string, unknown>;
      if (!post || post.id !== payload.p_post_id) {
        return Response.json({ restored: false, reason: "not_found" });
      }
      if (await hashRequest(contentFence(post)) !== await hashRequest(normalizeFence(payload.p_expected_content))) {
        return Response.json({ restored: false, reason: "content_mismatch", current_status: post.status });
      }
      if (post.status === "processing" && post.processing_started_at === payload.p_expected_processing_started_at) {
        if (payload.p_has_success && !post.posted_at) {
          post.posted_at = new Date(BASE_CLOCK + clock).toISOString();
        }
        return Response.json({ restored: true, status: "processing", already_processing: true });
      }
      if (post.processing_started_at !== payload.p_expected_processing_started_at) {
        return Response.json({ restored: false, reason: "attempt_mismatch", current_status: post.status });
      }
      if (!["completed", "failed"].includes(String(post.status))) {
        return Response.json({ restored: false, reason: "status_ineligible", current_status: post.status });
      }
      const meta = (post.metadata ?? {}) as Record<string, unknown>;
      if (!meta.settlement_rollup_at) {
        return Response.json({ restored: false, reason: "missing_rollup_provenance", current_status: post.status });
      }
      if (meta.settlement_rollup_processing_started_at !== payload.p_expected_processing_started_at) {
        return Response.json({ restored: false, reason: "rollup_attempt_mismatch", current_status: post.status });
      }
      const currentFence = contentFence(post);
      const expectedFence = normalizeFence(payload.p_expected_content);
      if (await hashRequest(currentFence) !== await hashRequest(expectedFence)) {
        return Response.json({ restored: false, reason: "content_mismatch", current_status: post.status });
      }
      const priorStatus = post.status;
      post.status = "processing";
      if (payload.p_has_success) {
        post.posted_at = post.posted_at || new Date(BASE_CLOCK + clock).toISOString();
      }
      return Response.json({ restored: true, status: "processing", prior_status: priorStatus });
    }
    if (table === "rpc/ack_threads_image_notification_delivery") {
      const payload = await request.json() as Record<string, unknown>;
      const meta = post.metadata as Record<string, unknown>;
      const intent = meta.final_notification_intent as Record<string, unknown> | undefined;
      if (!intent || intent.claim_id !== payload.p_claim_id || post.processing_started_at !== payload.p_expected_processing_started_at ||
          Date.parse(String(intent.claimed_until)) <= BASE_CLOCK + clock) return Response.json(false);
      intent.delivery_acks = { ...(intent.delivery_acks as Record<string, boolean> ?? {}), [String(payload.p_delivery_key)]: true };
      return Response.json(true);
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
    if (table === "rpc/record_published_story" && instagramFeedFailureMode !== "none") {
      const payload = await request.json();
      const id = "77000000-0000-4000-8000-000000000100";
      rows.push({ id, post_id: POST, social_account_id: payload.p_social_account_id, platform: "instagram",
        status: "success", platform_post_id: payload.p_story_id, platform_post_url: payload.p_story_url,
        error_message: null, created_at: new Date().toISOString(), response_data: { ig_post_subtype: "story" } });
      return Response.json({ recorded: true, platform_post_id: id });
    }
    if (table === "rpc/partner_settle_platform_post") return settle(await request.json());
    if (table === "rpc/record_deferred_platform_post") {
      const payload = await request.json();
      return Response.json(insertCheckpoint(payload).id);
    }
    if (table === "rpc/enroll_post_notification_recovery") {
      const payload = await request.json() as Record<string, unknown>;
      if (enrollmentFailure === "error") return Response.json({ message: "fixture enrollment unavailable" }, { status: 500 });
      const candidateId = crypto.randomUUID();
      const meta = (post.metadata ?? {}) as Record<string, unknown>;
      meta.legacy_notification_candidate = {
        candidate_id: candidateId,
        attempt_started_at: payload.p_expected_processing_started_at,
        ready: false,
        fanout_closed: false,
        requires_image_fanout_closure: accounts.some(account => account.platform === "instagram") &&
          (meta.instagram_share_to_story === true || (Array.isArray(meta.instagram_post_type) &&
            meta.instagram_post_type.includes("story") && meta.instagram_post_type.some(type => ["feed", "reel"].includes(type)))),
      };
      if (enrollmentFailure === "lost") return Response.json({ message: "fixture enrollment response lost" }, { status: 500 });
      return Response.json({ enrolled: true, candidate_id: candidateId,
        requires_image_fanout_closure: (meta.legacy_notification_candidate as Record<string, unknown>).requires_image_fanout_closure });
    }
    if (table === "rpc/close_post_fanout") {
      closedFanoutCalls++;
      const payload = await request.json() as Record<string, unknown>;
      const meta = (post.metadata ?? {}) as Record<string, unknown>;
      const cand = (meta.legacy_notification_candidate ?? {}) as Record<string, unknown>;
      closedRetainedIds = payload.p_retained_platform_post_ids as string[];
      const ids = [...payload.p_exact_platform_post_ids as string[], ...closedRetainedIds];
      const scoped = rows.filter(row => ids.includes(row.id));
      const managed = rows.some(row => deferred(row.response_data)?.media_type === "IMAGE");
      cand.fanout_closed = true;
      cand.exact_platform_post_ids = payload.p_exact_platform_post_ids;
      cand.retained_platform_post_ids = closedRetainedIds;
      cand.ready = !managed && scoped.length === ids.length && scoped.every(row => row.status !== "pending");
      cand.authorized_platform_post_ids = ids;
      cand.authorized_platform_post_statuses = Object.fromEntries(scoped.map(row => [row.id, row.status]));
      if (cand.ready) post.status = scoped.some(row => row.status === "success") ? "completed" : "failed";
      return Response.json({ closed: true, ready: cand.ready, status: post.status });
    }
    if (table === "rpc/claim_legacy_notification_candidate") {
      recoveryClaims++;
      const payload = await request.json() as Record<string, unknown>;
      const meta = (post.metadata ?? {}) as Record<string, unknown>;
      const cand = (meta.legacy_notification_candidate ?? {}) as Record<string, unknown>;
      assertEquals(payload.p_candidate_id, cand.candidate_id, "every recovery claim binds the prepared candidate");
      const currentStatuses = Object.fromEntries(rows.filter(row =>
        (cand.authorized_platform_post_ids as string[]).includes(row.id)).map(row => [row.id, row.status]));
      if (JSON.stringify(cand.authorized_platform_post_statuses) !== JSON.stringify(currentStatuses)) {
        cand.authorized_platform_post_statuses = currentStatuses;
        cand.candidate_id = crypto.randomUUID();
        post.status = Object.values(currentStatuses).includes("success") ? "completed" : "failed";
        return Response.json({ claimed: false, reason: "candidate_refreshed" });
      }
      if (refreshCandidateOnClaim) {
        cand.candidate_id = crypto.randomUUID();
        return Response.json({ claimed: false, reason: "candidate_refreshed" });
      }
      cand.consumed = true;
      meta.final_notified_at = new Date(BASE_CLOCK + clock).toISOString();
      return Response.json({ claimed: true, status: post.status, authorized_platform_post_ids: cand.authorized_platform_post_ids });
    }
    if (table === "rpc/stamp_pinterest_post_type") {
      const payload = await request.json() as Record<string, unknown>;
      const meta = (post.metadata ?? {}) as Record<string, unknown>;
      meta.pinterest_post_type = payload.p_post_type;
      return Response.json(true);
    }
    if (table === "system_logs") {
      logs.push(await request.json());
      return new Response(null, { status: 201 });
    }
    if (table === "profiles") return Response.json({ id: OWNER, preferred_timezone: "UTC", email_notifications_enabled: profileEmailEnabled });
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
        (!def.next_check_at || Date.parse(String(def.next_check_at)) <= currentClock);

      const isTerminalManagedImage = ["success", "failed"].includes(row.status) &&
        def.kind === "threads" && def.media_type === "IMAGE" &&
        !(((post.metadata as Record<string, unknown>)?.legacy_notification_candidate as Record<string, unknown> | undefined)?.requires_image_fanout_closure === true &&
          ((post.metadata as Record<string, unknown>)?.legacy_notification_candidate as Record<string, unknown>).fanout_closed !== true) &&
        ((post.status === "processing" && def.attempt_started_at === post.processing_started_at) || (
          ["completed", "failed"].includes(String(post.status)) &&
          def.attempt_started_at === post.processing_started_at &&
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

  // Worker-boundary fixtures arrange an expired lease; actual SQL contention is tested in PostgreSQL.
  function leaseImageRow(id = IMAGE_ROW): Row {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`Row ${id} not found to lease`);
    const def = deferred(row.response_data);
    if (def) {
      def.claimed_until = new Date(BASE_CLOCK + clock - 1).toISOString();
      def.execution_claimed_until = def.claimed_until;
      def.next_check_at = new Date(BASE_CLOCK + clock).toISOString();
    }
    const target = claimDeferredPublishes(10).find(candidate => candidate.id === id);
    if (!target) throw new Error(`Scheduler did not select ${id}`);
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
      finalizerMode = "error";
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

        const deliveryFailureLog = logs.find(entry => (entry.metadata as Record<string, unknown> | undefined)?.event === "threads_image_notification_delivery_failed");
        assert(deliveryFailureLog, "Delivery refusal must persist its diagnostic before returning");
        const diagnostic = deliveryFailureLog.metadata as Record<string, unknown>;
        assertEquals(diagnostic.post_id, POST);
        assertEquals(typeof diagnostic.notification_claim_id, "string");
        assertEquals(typeof diagnostic.delivery_error, "string");
        assert(String(diagnostic.delivery_error).length > 0);
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

    for (const reverse of [false, true]) {
      for (const mutation of ["none", "canceled", "caption", "metadata", "new_claim", "rpc_error"] as const) {
        await test.step(`legacy video handoff (${reverse ? "Instagram first" : "Facebook first"}, ${mutation})`, async () => {
          reset();
          legacyVideoMode = true;
          const instagram = { ...threadsAccount(), id: THREADS_ACCOUNT_2, platform: "instagram", platform_user_id: "fixture-instagram-user" };
          accounts = reverse ? [instagram, facebookAccount()] : [facebookAccount(), instagram];
          post.platforms = ["facebook", "instagram"];
          post.metadata = { selected_account_ids: accounts.map(a => a.id), instagram_post_type: ["reel"] };
          beforeLegacyRestore = () => {
            const metadata = post.metadata as Record<string, unknown>;
            if (mutation === "canceled") {
              post.status = "failed";
              delete metadata.settlement_rollup_at;
              delete metadata.settlement_rollup_processing_started_at;
            }
            if (mutation === "caption") post.caption = "Owner edit during deferred handoff";
            if (mutation === "metadata") metadata.instagram_disable_comments = true;
            if (mutation === "new_claim") post.processing_started_at = new Date(BASE_CLOCK + clock + 1).toISOString();
          };
          legacyRestoreFailure = mutation === "rpc_error";
          const response = await invoke();
          assertEquals(response.status, mutation === "rpc_error" ? 503 : 200, await response.clone().text());
          assertEquals(rows.some(row => row.platform === "facebook" && row.status === "success"), true);
          assertEquals(rows.some(row => row.platform === "instagram" && row.status === "pending"), true);
          assertEquals(finalizerCalls, 0);
          if (mutation === "none") assertEquals(post.status, "processing");
          if (mutation === "canceled") assertEquals(post.status, "failed");
          if (["caption", "metadata", "new_claim"].includes(mutation) && !reverse) assertEquals(post.status, "completed");
          assertEquals(deliveredNotifications.length, 0);
        });
      }
    }

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
      assertEquals(deliveredNotifications.length, 1);
      const deliveredBody = JSON.stringify(deliveredNotifications[0].body);
      assert(deliveredBody.includes("https://threads.net/p/prior-success"));
      assert(!deliveredBody.includes("old failure"));
    });

    for (const mode of ["missing", "empty", "deleted", "changed", "parent_changed", "content_changed", "settings_changed", "attempt_changed", "content_read_error"] as const) {
      for (const resumed of [false, true]) {
        await test.step(`managed notification refuses ${mode} leased result scope (${resumed ? "resumed" : "original"})`, async () => {
          reset();
          if (resumed) {
            await checkpointForResume();
            leaseImageRow();
          }
          notificationScopeMode = mode;
          const response = await invoke(resumed ? { resume: IMAGE_ROW } : {});
          assertEquals(response.status, 200, await response.clone().text());
          assertEquals(publishes, 1);
          assertEquals(deliveredNotifications.length, 0);
          assertEquals((post.metadata as Record<string, unknown>).final_notified_at, undefined);
          assertEquals(((post.metadata as Record<string, unknown>).final_notification_intent as Record<string, unknown>).notified, false);
        });
      }
    }

    for (const mode of ["semantic_failure", "invalid", "ok", "opt_out"] as const) {
      await test.step(`managed failure email requires a semantic ACK (${mode})`, async () => {
        reset();
        accounts = [threadsAccount(), facebookAccount()];
        post.platforms = ["threads", "facebook"];
        post.metadata = { selected_account_ids: accounts.map(a => a.id) };
        facebookFail = true;
        emailMode = mode === "opt_out" ? "semantic_failure" : mode;
        profileEmailEnabled = mode !== "opt_out";
        const response = await invoke();
        assertEquals(response.status, 200, await response.clone().text());
        const intent = (post.metadata as Record<string, unknown>).final_notification_intent as Record<string, unknown>;
        assertEquals(intent.notified, mode === "ok" || mode === "opt_out");
        assertEquals(publishes, 1);
      });
    }

    for (const failure of ["read", "update"] as const) {
      for (const failed of [false, true]) {
        await test.step(`legacy ${failed ? "failure" : "success"} notification survives a ${failure} marker error`, async () => {
          reset();
          accounts = [facebookAccount()];
          post.platforms = ["facebook"];
          post.metadata = { selected_account_ids: [FACEBOOK_ACCOUNT], webhook_url: "https://webhook-fixture.invalid/hook" };
          facebookFail = failed;
          profileEmailEnabled = true;
          legacyNotificationClaimFailure = failure;
          const background: Promise<unknown>[] = [];
          const runtime = globalThis as Record<string, unknown>;
          const previous = runtime.EdgeRuntime;
          runtime.EdgeRuntime = { waitUntil: (promise: Promise<unknown>) => { background.push(promise); } };
          try {
            const response = await invoke();
            assertEquals(response.status, 200);
            await Promise.all(background);
            assertEquals(deliveredNotifications.filter(entry => entry.event === (failed ? "post.failed" : "post.completed")).length, 1);
            assertEquals(deliveredNotifications.filter(entry => entry.event === "email.post_failed").length, failed ? 1 : 0);
            assertEquals(post.status, failed ? "failed" : "completed");
          } finally {
            if (previous === undefined) delete runtime.EdgeRuntime;
            else runtime.EdgeRuntime = previous;
          }
        });
      }
    }

    for (const failure of ["read", "read_persistent", "missing"] as const) {
      await test.step(`legacy deferred sibling cannot bypass managed notice ownership (${failure})`, async () => {
        reset();
        webhookFailure = "http";
        assertEquals((await invoke()).status, 200);
        const intent = structuredClone((post.metadata as Record<string, unknown>).final_notification_intent);
        assertEquals((intent as Record<string, unknown>).notified, false);
        assertEquals(deliveredNotifications.length, 0);
        const sibling = structuredClone(rows[0]);
        sibling.id = "44000000-0000-4000-8000-000000000099";
        sibling.status = "pending";
        sibling.platform_post_id = null;
        sibling.platform_post_url = null;
        deferred(sibling.response_data).media_type = "VIDEO";
        rows.push(sibling);
        webhookFailure = "none";
        legacyNotificationClaimFailure = failure;
        legacySiblingReadSnapshot = true;
        assertEquals((await invoke({ resume: sibling.id, at: 2_000 })).status, 200);
        assertEquals(deliveredNotifications.length, 0);
        assertEquals((post.metadata as Record<string, unknown>).final_notification_intent, intent);
      });
    }

    for (const newerClaim of [false, true]) {
      await test.step(`prior result read failure releases only its own unpublished claim (${newerClaim})`, async () => {
        reset();
        priorSuccessReadFailure = true;
        newerClaimOnReadFailure = newerClaim;
        const response = await invoke();
        assertEquals(response.status, 503);
        assertEquals(post.status, newerClaim ? "processing" : "pending");
        assertEquals(creates, 0);
        assert(logs.some(entry => (entry.metadata as Record<string, unknown>)?.event === "prior_publication_read_failed"));
      });
    }

    await test.step("failed destination cannot block or replay acknowledged webhooks and email across notification leases", async () => {
      reset();
      accounts = [threadsAccount(), facebookAccount()];
      post.platforms = ["threads", "facebook"];
      post.metadata = { selected_account_ids: accounts.map(account => account.id) };
      facebookFail = true;
      profileEmailEnabled = true;
      registeredEndpoints = ["https://webhook-fixture.invalid/bad", "https://webhook-fixture.invalid/healthy"];
      failingRegisteredEndpoint = true;
      assertEquals((await invoke()).status, 200);
      assertEquals(deliveredNotifications.filter(entry => entry.url.endsWith("/healthy")).length, 1);
      assertEquals(deliveredNotifications.filter(entry => entry.event === "email.post_failed").length, 1);
      for (const retry of [1, 2]) {
        clock = retry * 181_000;
        if (retry === 2) failingRegisteredEndpoint = false;
        let freshHandler: Handler | undefined;
        const savedServe = Deno.serve;
        Deno.serve = ((registered: Handler) => {
          freshHandler = registered;
          return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
        }) as typeof Deno.serve;
        try {
          if (retry === 1) await import("./index.ts?notification-destination-recovery");
          else await import("./index.ts?notification-destination-final-recovery");
        } finally { Deno.serve = savedServe; }
        await runReconcile({
          claim: async limit => claimDeferredPublishes(limit).map(row => ({ platform_post_id: row.id, post_id: row.post_id })),
          resume: async row => {
            const response = await freshHandler!(new Request(`${ORIGIN}/functions/v1/process-post`, {
              method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
              body: JSON.stringify({ post_id: row.post_id, resume_platform_post_id: row.platform_post_id }),
            }));
            return { ok: response.ok, status: (await response.json()).status };
          },
          sweep: async () => ({ posts: 0, rows_failed: 0 }),
          log: async () => {},
        });
        assertEquals(deliveredNotifications.filter(entry => entry.url.endsWith("/healthy")).length, 1);
        assertEquals(deliveredNotifications.filter(entry => entry.event === "email.post_failed").length, 1);
        assertEquals(((post.metadata as Record<string, unknown>).final_notification_intent as Record<string, unknown>).notified, retry === 2);
      }
      assertEquals(deliveredNotifications.filter(entry => entry.url.endsWith("/bad")).length, 1);
      assertEquals(publishes, 1);
    });

    for (const mode of ["error", "lost"] as const) {
      await test.step(`unconfirmed enrollment (${mode}) restores the unpublished claim`, async () => {
        reset();
        const originalStatus = post.status;
        enrollmentFailure = mode;
        const response = await invoke();
        assertEquals(response.status, 503);
        assertEquals(post.status, originalStatus);
        assertEquals({ creates, statusReads, publishes, settlements }, { creates: 0, statusReads: 0, publishes: 0, settlements: 0 });
        assert(logs.some(entry => (entry.metadata as Record<string, unknown>)?.event === "notification_enrollment_unconfirmed"));
      });
    }
    for (const retained of [false, true]) {
      await test.step(`media preparation closes failed targets and preserves Instagram successes (${retained})`, async () => {
        reset();
        accounts = [{ ...facebookAccount(), platform: "instagram" }];
        post.platforms = ["instagram"];
        post.metadata = { ...post.metadata as Record<string, unknown>, selected_account_ids: [FACEBOOK_ACCOUNT] };
        if (retained) {
          addFailedRow("facebook");
          rows[0].platform = "instagram";
          rows[0].status = "success";
          rows[0].response_data = { ig_post_subtype: "feed" };
          post.status = "failed";
        }
        missingMedia = true;
        const response = await invoke({ accountIds: [FACEBOOK_ACCOUNT], platforms: ["instagram"] });
        assertEquals(response.status, 422);
        assertEquals(post.status, retained ? "completed" : "failed");
        assertEquals(closedRetainedIds, retained ? ["facebook-failed-old"] : []);
        assertEquals(closedFanoutCalls, 1);
        assertEquals({ creates, statusReads, publishes }, { creates: 0, statusReads: 0, publishes: 0 });
      });
    }
    for (const mode of ["missing_identity", "combined", "identity_without_mode"] as const) {
      await test.step(`notification routing ${mode} is refused with a persistent diagnostic`, async () => {
        reset();
        const response = await handler!(new Request(`${ORIGIN}/functions/v1/process-post`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
          body: JSON.stringify({ post_id: POST,
            ...(mode === "identity_without_mode" ? { attempt_started_at: new Date(BASE_CLOCK).toISOString() } : { notification_only: true }),
            ...(mode === "combined" ? { resume_platform_post_id: IMAGE_ROW } : {}),
          }),
        }));
        assertEquals(response.status, 400);
        assert(logs.some(entry => (entry.metadata as Record<string, unknown>)?.event === "notification_route_refused"));
        assertEquals({ creates, statusReads, publishes, settlements, recoveryClaims }, { creates: 0, statusReads: 0, publishes: 0, settlements: 0, recoveryClaims: 0 });
      });
    }
    for (const order of ["none", "threads_first", "threads_last"] as const) {
      for (const mode of ["error", "missing", "ok"] as const) {
        await test.step(`live Instagram Story cannot hide an unrecorded feed failure (${mode}, ${order})`, async () => {
          reset();
          instagramFeedFailureMode = mode;
          profileEmailEnabled = true;
          const instagram = { ...threadsAccount(), id: THREADS_ACCOUNT_2, platform: "instagram", platform_user_id: "fixture-instagram-user" };
          accounts = order === "none" ? [instagram] : order === "threads_first" ? [threadsAccount(), instagram] : [instagram, threadsAccount()];
          post.platforms = order === "none" ? ["instagram"] : ["instagram", "threads"];
          post.metadata = { ...post.metadata as Record<string, unknown>, selected_account_ids: accounts.map(account => account.id), instagram_post_type: ["story", "feed"] };
          const background: Promise<unknown>[] = [];
          const runtime = globalThis as Record<string, unknown>;
          const previous = runtime.EdgeRuntime;
          runtime.EdgeRuntime = { waitUntil: (promise: Promise<unknown>) => { background.push(promise); } };
          try {
            const response = await invoke();
            await Promise.all(background);
            assertEquals(response.status, mode === "ok" ? 200 : 503, await response.clone().text());
            assertEquals(instagramStoryPublishes, 1);
            assertEquals(rows.filter(row => row.response_data.ig_post_subtype === "story" && row.status === "success").length, 1);
            assertEquals(closedFanoutCalls, mode === "ok" ? 1 : 0);
            assertEquals(recoveryClaims, mode === "ok" && order === "none" ? 1 : 0);
            if (mode !== "ok") {
              assertEquals(deliveredNotifications.length, 0);
              assertEquals((post.metadata as Record<string, unknown>).final_notified_at, undefined);
              assert(logs.some(entry => (entry.metadata as Record<string, unknown>)?.event === "notification_fanout_write_failed"));
              if (order !== "none") {
                const before = { creates, statusReads, publishes, settlements };
                clock = 181_000;
                assertEquals(claimDeferredPublishes(10).length, 0);
                let freshHandler: Handler | undefined;
                const savedServe = Deno.serve;
                Deno.serve = ((registered: Handler) => {
                  freshHandler = registered;
                  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
                }) as typeof Deno.serve;
                try {
                  if (order === "threads_first") {
                    if (mode === "error") await import("./index.ts?incomplete-managed-first-error");
                    else await import("./index.ts?incomplete-managed-first-missing");
                  } else {
                    if (mode === "error") await import("./index.ts?incomplete-managed-last-error");
                    else await import("./index.ts?incomplete-managed-last-missing");
                  }
                } finally { Deno.serve = savedServe; }
                const resumed = await freshHandler!(new Request(`${ORIGIN}/functions/v1/process-post`, {
                  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
                  body: JSON.stringify({ post_id: POST, resume_platform_post_id: IMAGE_ROW }),
                }));
                assertEquals(resumed.status, 200, await resumed.clone().text());
                await Promise.all(background);
                assertEquals(post.status, "processing");
                assertEquals(deliveredNotifications.length, 0);
                assertEquals((post.metadata as Record<string, unknown>).final_notification_intent, undefined);
                assertEquals({ creates, statusReads, publishes, settlements }, before);
              }
            } else {
              const notice = deliveredNotifications.find(entry => entry.event === "post.completed")!;
              const body = notice.body as { data: { platform_results_list: Array<{ status: string }> } };
              assertEquals(body.data.platform_results_list.map(row => row.status).sort(), order === "none" ? ["failed", "success"] : ["failed", "success", "success"]);
              assertEquals(deliveredNotifications.filter(entry => entry.event === "email.post_failed").length, 1);
            }
          } finally {
            if (previous === undefined) delete runtime.EdgeRuntime;
            else runtime.EdgeRuntime = previous;
          }
        });
      }
    }
    for (const mode of ["ok", "read_error", "missing_row", "refreshed", "changed_status"] as const) {
      await test.step(`notification-only recovery ${mode} never enters publishing and retains pre-claim work on degraded reads`, async () => {
        reset();
        addFailedRow("facebook");
        const resultId = rows[0].id;
        rows[0].status = "success";
        rows[0].platform_post_url = "https://facebook.fixture/recovered";
        post.status = "completed";
        post.processing_started_at = new Date(BASE_CLOCK).toISOString();
        let candidateId = "77000000-0000-4000-8000-000000000001";
        const claimId = "77000000-0000-4000-8000-000000000002";
        post.metadata = { ...post.metadata as Record<string, unknown>, legacy_notification_candidate: {
          candidate_id: candidateId, authorized_platform_post_ids: [resultId], ready: true,
          authorized_platform_post_statuses: { [resultId]: "success" },
        } };
        const call = () => handler!(new Request(`${ORIGIN}/functions/v1/process-post`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
          body: JSON.stringify({ post_id: POST, notification_only: true, attempt_started_at: post.processing_started_at,
            candidate_id: candidateId, notification_claim_id: claimId }),
        }));
        recoveryRowReadFailure = mode === "read_error";
        refreshCandidateOnClaim = mode === "refreshed";
        if (mode === "missing_row") rows = [];
        if (mode === "changed_status") rows[0].status = "failed";
        const response = await call();
        const reachesClaim = mode === "ok" || mode === "refreshed" || mode === "changed_status";
        assertEquals(response.status, reachesClaim ? 200 : 503, await response.clone().text());
        assertEquals({ creates, statusReads, publishes, settlements, inlineClaims }, { creates: 0, statusReads: 0, publishes: 0, settlements: 0, inlineClaims: 0 });
        assertEquals(recoveryClaims, reachesClaim ? 1 : 0);
        if (mode === "ok") {
          const receipt = await response.json();
          assertEquals(receipt.notification_scheduled, true);
          assertEquals("notified" in receipt, false);
        }
        if (mode !== "ok") {
          assertEquals((post.metadata as Record<string, unknown>).final_notified_at, undefined);
          assertEquals(deliveredNotifications.length, 0);
        }
        if (mode === "changed_status") {
          assertEquals((await response.json()).reason, "candidate_refreshed");
          candidateId = ((post.metadata as Record<string, unknown>).legacy_notification_candidate as Record<string, unknown>).candidate_id as string;
          const background: Promise<unknown>[] = [];
          const runtime = globalThis as Record<string, unknown>;
          const previous = runtime.EdgeRuntime;
          runtime.EdgeRuntime = { waitUntil: (promise: Promise<unknown>) => { background.push(promise); } };
          try {
            const recovered = await call();
            assertEquals(recovered.status, 200);
            const receipt = await recovered.json();
            assertEquals(receipt.claimed, true);
            assertEquals(receipt.notification_scheduled, true);
            assertEquals(receipt.status, "failed");
            await Promise.all(background);
            const notices = deliveredNotifications.filter(entry => entry.event === "post.failed");
            assertEquals(notices.length, 1);
            const body = notices[0].body as { data: { platform_results_list: Array<{ platform: string; status: string }> } };
            assertEquals(body.data.platform_results_list.map(row => ({ platform: row.platform, status: row.status })), [{ platform: "facebook", status: "failed" }]);
          } finally {
            if (previous === undefined) delete runtime.EdgeRuntime;
            else runtime.EdgeRuntime = previous;
          }
          assertEquals(recoveryClaims, 2);
          assertEquals({ creates, statusReads, publishes, settlements }, { creates: 0, statusReads: 0, publishes: 0, settlements: 0 });
        }
      });
    }
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
