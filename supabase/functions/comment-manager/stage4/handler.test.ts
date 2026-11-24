// Stage 4 handler tests, through the real routing shape.
//
// The database is a fake port that mirrors the SQL state machine of the
// migration (claim / mark / settle / status with the per-key and logical
// fences); the provider is a counting fake. Every case asserts the visible
// answer, the number of ACTUAL provider write requests, and what the fake
// receipt store recorded. No test touches Google, Supabase or a real token.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { handleStage4, resetAnonRefusalGate, type Stage4Deps } from "./handler.ts";
import { STAGE4_ACTIONS } from "./contracts.ts";
import { sealCursor, sealHandle, HANDLE_TTL_MS } from "./sealing.ts";
import { writeRefusalAudit } from "./audit.ts";

const TEST_SIGNER = "stage4-handler-test-secret";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

interface FakeAccount {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  auth_provider: string | null;
  is_active: boolean;
  needs_reauth: boolean;
  binding_generation: number;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
}

interface ReceiptRow {
  owner_id: string;
  operation_id: string;
  account_id: string;
  channel_id: string;
  binding_generation: number;
  action: string;
  video_id: string | null;
  parent_comment_id: string | null;
  comment_id: string | null;
  moderation_status: string | null;
  ban_author: boolean;
  author_channel_id: string | null;
  intent_digest: string;
  logical_digest: string | null;
  state: "claimed" | "dispatched" | "confirmed" | "refused" | "indeterminate";
  attempt_token: string;
  reason: string | null;
  provider_class: string | null;
  result_thread_id: string | null;
  result_comment_id: string | null;
  claimed_at: number;
  dispatched_at: number | null;
  settled_at: number | null;
}

export interface ProviderCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}

/** The reply of one fake RPC: supabase-js's `{ data, error }`. */
interface FakeRpcResult {
  data: unknown;
  error: { message: string } | null;
}

/** The SQL parameters the fake claim / mark / settle / status functions read. */
interface FakeRpcParams {
  p_owner_id?: string;
  p_operation_id?: string;
  p_account_id?: string;
  p_expected_channel?: string;
  p_expected_generation?: number;
  p_attempt_token?: string;
  p_action?: string;
  p_intent_digest?: string;
  p_intent_digests?: Record<string, string> | null;
  p_logical_digests?: Record<string, string>;
  p_targets?: {
    video_id?: string;
    parent_comment_id?: string;
    comment_id?: string;
    moderation_status?: string;
    ban_author?: boolean;
    author_channel_id?: string;
  };
  p_outcome?: string;
  p_reason?: string | null;
  p_provider_class?: string | null;
  p_result_thread_id?: string | null;
  p_result_comment_id?: string | null;
}

/** The two methods of the admin client the handler calls, as the fake provides them. */
interface FakeAdmin {
  from(table: string): unknown;
  rpc(fn: string, params: Record<string, unknown>): Promise<FakeRpcResult>;
}

/** An item of a parsed list answer, as far as the tests read it. */
interface AnswerItem {
  id: string;
  title: string;
  handle: string;
  comment_id: string;
  kind: string;
  thread_id: string;
  video_id: string;
  canonical_parent_id: string;
}

/** The parsed JSON answer of the handler: the envelope and the payload fields the tests read. */
interface Answer {
  ok: boolean;
  request_id: string;
  reason?: string;
  data: {
    state?: string;
    operation_id?: string;
    observation?: string;
    reason?: string | null;
    confirmation?: string;
    expires_in_seconds?: number;
    items: AnswerItem[];
    inconsistent_count?: number;
    next_cursor?: string | null;
    result_comment_id?: string | null;
    moderation_status?: string | null;
    ban_requested?: boolean;
    author_channel_id?: string;
    capabilities: Record<string, { allowed: boolean; reason: string | null }>;
  };
}

export interface WorldOptions {
  accounts?: FakeAccount[];
  policy?: Record<string, { read?: boolean; held?: boolean; write?: boolean; ban?: boolean }>;
  /** Overrides specific provider answers; return undefined to fall through to the default. */
  provider?: (call: ProviderCall) => { status: number; body: unknown } | undefined;
  now?: () => number;
  /** A clock for cool-downs that is independent of `now` (which is wall time). */
  monotonicNow?: () => number;
  failSettleOnce?: boolean;
  /** The status RPC itself fails (a transport/database error, not "no receipt"). */
  statusRpcError?: boolean;
  /** Reading social_accounts fails (a database error, not "no such row"). */
  accountReadError?: boolean;
  /** Loading the digest keys fails. */
  digestKeysError?: boolean;
  /** A rotation made this key version active in SQL AFTER the handler read the keys. */
  sqlActiveKeyVersion?: number;
  /** Runs right after a claim committed, before the mark (to change the world between them). */
  onClaim?: () => void;
  rateLimited?: boolean;
  admitsError?: boolean;
}

export interface World {
  deps: Stage4Deps;
  writes: ProviderCall[];
  reads: ProviderCall[];
  rpcLog: Array<{ fn: string; params: Record<string, unknown> }>;
  auditRows: Array<Record<string, unknown>>;
  receipts: Map<string, ReceiptRow>;
  accounts: Map<string, FakeAccount>;
  setPolicy: (policy: NonNullable<WorldOptions["policy"]>) => void;
  calls: (action: string, extra?: Record<string, unknown>) => Promise<Response>;
  callAs: (userId: string, action: string, extra?: Record<string, unknown>) => Promise<Response>;
}

function nativeAccount(overrides: Partial<FakeAccount> = {}): FakeAccount {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    user_id: USER,
    platform: "youtube",
    platform_user_id: "UC-handler-test",
    auth_provider: "native",
    is_active: true,
    needs_reauth: false,
    binding_generation: 1,
    access_token: "valid-access",
    refresh_token: "valid-refresh",
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

export function createWorld(options: WorldOptions = {}): World {
  // Each world is a fresh deployment: nothing learned about the shared anonymous bucket carries over.
  resetAnonRefusalGate();
  const accounts = new Map<string, FakeAccount>();
  for (const a of options.accounts ?? [nativeAccount()]) accounts.set(a.id, a);

  let policy: NonNullable<WorldOptions["policy"]> = options.policy ?? {
    [nativeAccount().id]: { read: true, held: true, write: true, ban: false },
  };

  const writes: ProviderCall[] = [];
  const reads: ProviderCall[] = [];
  const rpcLog: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const receipts = new Map<string, ReceiptRow>();
  const setPolicy = (next: NonNullable<WorldOptions["policy"]>) => {
    policy = next;
  };
  const now = options.now ?? (() => Date.now());
  const digestKey = { version: 1, key: base64Key("ab".repeat(32)) };

  // A real count-based rate limiter: the anonymous audit bucket and the
  // suppression counter bucket behave exactly as the handler expects them to.
  const buckets = new Map<string, number>();
  function bucketCheck(endpoint: string, max: number): boolean {
    const used = buckets.get(endpoint) ?? 0;
    if (used >= max) return false;
    buckets.set(endpoint, used + 1);
    return true;
  }

  function defaultProvider(call: ProviderCall): { status: number; body: unknown } {
    if (call.path === "playlistItems") {
      return { status: 200, body: { items: [playlistItem("vid-1", "First upload")] } };
    }
    if (call.path === "videos") {
      return { status: 200, body: { items: [{ id: call.query.get("id"), snippet: { channelId: "UC-handler-test" } }] } };
    }
    if (call.path === "commentThreads" && call.method === "GET") {
      return { status: 200, body: { items: [threadFixture()] } };
    }
    if (call.path === "comments" && call.method === "GET" && call.query.get("id")) {
      return { status: 200, body: { items: [commentFixture(call.query.get("id")!)] } };
    }
    if (call.path === "comments" && call.method === "GET") {
      return { status: 200, body: { items: [] } };
    }
    if (call.path === "commentThreads" && call.method === "POST") {
      return { status: 200, body: createdThreadFixture("vid-1") };
    }
    if (call.path === "comments" && (call.method === "POST" || call.method === "PUT")) {
      // comments.insert is POST (reply); comments.update is PUT (edit). The
      // wrong verb is a 405, so an edit sent as POST cannot pass unnoticed.
      const body = call.body as { id?: string; snippet?: { parentId?: string } } | undefined;
      if (call.method === "POST" && body?.snippet?.parentId) {
        return { status: 200, body: { id: "comment-new-reply", snippet: { parentId: body.snippet.parentId } } };
      }
      if (call.method === "PUT" && body?.id) {
        return { status: 200, body: { id: body.id, snippet: { authorChannelId: { value: "UC-handler-test" } } } };
      }
      return { status: 405, body: envelope("methodNotAllowed") };
    }
    if (call.path === "comments/setModerationStatus") {
      return { status: 204, body: null };
    }
    return { status: 404, body: envelope("notFound") };
  }

  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const full = new URL(String(url));
    const path = full.pathname.replace("/youtube/v3/", "");
    const call: ProviderCall = {
      method: init?.method ?? "GET",
      path,
      query: full.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    const isWrite = call.method === "POST" || call.method === "PUT";
    (isWrite ? writes : reads).push(call);
    const answer = (options.provider && options.provider(call)) ?? defaultProvider(call);
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  function admits(accountId: string, capability: string): boolean {
    if (options.admitsError) return false;
    const entry = policy[accountId];
    if (!entry) return false;
    const caps: Record<string, boolean> = {
      read: entry.read === true,
      held: entry.held === true && entry.read === true,
      write: entry.write === true && entry.read === true,
      ban: entry.ban === true && entry.write === true && entry.read === true,
    };
    return caps[capability] === true;
  }

  function capabilityStatus(accountId: string) {
    const reasons: Record<string, string | null> = {};
    for (const cap of ["read", "held", "write", "ban"]) {
      reasons[cap] = admits(accountId, cap) ? null : "capability_off";
    }
    return reasons;
  }

  const admin: FakeAdmin = {
    from(table: string) {
      if (table === "system_logs") {
        return {
          insert(row: Record<string, unknown>) {
            auditRows.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "social_accounts") {
        // The handler reads accounts with .select().eq("id").eq("user_id")
        // .maybeSingle(); the fake applies exactly that filter.
        const filter: Record<string, string> = {};
        const builder = {
          select() {
            return builder;
          },
          eq(col: string, val: string) {
            filter[col] = val;
            return builder;
          },
          maybeSingle() {
            if (options.accountReadError) {
              return Promise.resolve({ data: null, error: { message: "database unavailable" } });
            }
            const rows = [...accounts.values()].filter((a) =>
              (!filter.id || a.id === filter.id) && (!filter.user_id || a.user_id === filter.user_id)
            );
            // A copy, like PostgREST: later mutations of the store must not
            // reach into a snapshot the handler already verified.
            return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
          },
        };
        return builder;
      }
      throw new Error(`fake admin: unexpected table ${table}`);
    },
    async rpc(fn: string, params: Record<string, unknown>) {
      rpcLog.push({ fn, params });
      if (fn === "check_rate_limit") {
        if (options.rateLimited) return { data: { allowed: false }, error: null };
        const endpoint = String(params.p_endpoint);
        const max = Number(params.p_max_requests);
        // The two audit buckets are real; every other bucket is unlimited.
        const allowed = endpoint.includes("stage4_audit") ? bucketCheck(endpoint, max) : true;
        return { data: { allowed, remaining: 0, retry_after: 0 }, error: null };
      }
      if (fn === "youtube_comments_stage4_admits") {
        if (options.admitsError) return { data: null, error: { message: "unreadable" } };
        return { data: admits(String(params.p_account_id), String(params.p_capability)), error: null };
      }
      if (fn === "youtube_comments_stage4_capability_status") {
        if (options.admitsError) return { data: null, error: { message: "unreadable" } };
        const reasons = capabilityStatus(String(params.p_account_id));
        const out: Record<string, { allowed: boolean; reason: string | null }> = {};
        for (const cap of ["read", "held", "write", "ban"]) {
          out[cap] = { allowed: reasons[cap] === null, reason: reasons[cap] };
        }
        return { data: out, error: null };
      }
      if (fn === "youtube_comment_digest_keys") {
        if (options.digestKeysError) return { data: null, error: { message: "keys unavailable" } };
        return { data: { active_version: digestKey.version, keys: [digestKey] }, error: null };
      }
      if (fn === "youtube_comment_op_claim") return claim(params as FakeRpcParams);
      if (fn === "youtube_comment_op_mark_dispatched") return mark(params as FakeRpcParams);
      if (fn === "youtube_comment_op_settle") return settle(params as FakeRpcParams);
      if (fn === "youtube_comment_op_status") {
        if (options.statusRpcError) return { data: null, error: { message: "database unavailable" } };
        return status(params as FakeRpcParams);
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
  };

  // ---- the receipt state machine (mirrors the migration) -------------------

  function claim(p: FakeRpcParams): FakeRpcResult {
    const owner = p.p_owner_id as string;
    const key = `${owner}:${p.p_operation_id}`;
    const account = accounts.get(String(p.p_account_id));
    if (!account || account.user_id !== owner || account.platform !== "youtube" ||
      !account.is_active || account.auth_provider !== "native" || account.needs_reauth ||
      account.platform_user_id !== p.p_expected_channel ||
      account.binding_generation !== Number(p.p_expected_generation)) {
      return { data: { ok: false, reason: "not_found" }, error: null };
    }
    // The capability is DERIVED from the intent (ban_author), never from the caller.
    if (!admits(account.id, p.p_targets?.ban_author === true ? "ban" : "write")) {
      return { data: { ok: false, reason: "capability_denied" }, error: null };
    }
    const existing = receipts.get(key);
    if (existing) {
      if (existing.intent_digest !== p.p_intent_digest) {
        return { data: { ok: false, reason: "conflict", state: existing.state }, error: null };
      }
      return {
        data: {
          ok: false,
          reason: "already_recorded",
          state: existing.state,
          result_comment_id: existing.result_comment_id,
          result_thread_id: existing.result_thread_id,
        },
        error: null,
      };
    }
    const logical = (p.p_logical_digests ?? {})[String(digestKey.version)] ?? null;
    if (p.p_action === "create_thread" || p.p_action === "reply") {
      for (const row of receipts.values()) {
        if (row.owner_id === owner && row.channel_id === account.platform_user_id &&
          row.logical_digest === logical && row.action === p.p_action &&
          ["claimed", "dispatched", "indeterminate"].includes(row.state)) {
          return { data: { ok: false, reason: "possible_duplicate", state: row.state }, error: null };
        }
      }
      for (const row of receipts.values()) {
        if (row.owner_id === owner && row.channel_id === account.platform_user_id &&
          row.logical_digest === logical && row.state === "confirmed" &&
          row.settled_at !== null && now() - row.settled_at < 10 * 60 * 1000) {
          if (row.account_id === account.id && row.binding_generation === account.binding_generation) {
            return {
              data: { ok: false, reason: "recently_posted", result_comment_id: row.result_comment_id, result_thread_id: row.result_thread_id },
              error: null,
            };
          }
          return { data: { ok: false, reason: "recently_posted" }, error: null };
        }
      }
    }
    // Mirrors the claim: a digest map without the locked (active) version is a temporary refusal.
    const lockedVersion = options.sqlActiveKeyVersion ?? digestKey.version;
    if (p.p_intent_digests && !p.p_intent_digests[String(lockedVersion)]) {
      return { data: { ok: false, reason: "upstream" }, error: null };
    }
    const targets = p.p_targets ?? {};
    const row: ReceiptRow = {
      owner_id: owner,
      operation_id: String(p.p_operation_id),
      account_id: account.id,
      channel_id: account.platform_user_id,
      binding_generation: account.binding_generation,
      action: String(p.p_action),
      video_id: targets.video_id ?? null,
      parent_comment_id: targets.parent_comment_id ?? null,
      comment_id: targets.comment_id ?? null,
      moderation_status: targets.moderation_status ?? null,
      ban_author: targets.ban_author === true,
      author_channel_id: targets.author_channel_id ?? null,
      intent_digest: String(p.p_intent_digest),
      logical_digest: logical,
      state: "claimed",
      attempt_token: crypto.randomUUID(),
      reason: null,
      provider_class: null,
      result_thread_id: null,
      result_comment_id: null,
      claimed_at: now(),
      dispatched_at: null,
      settled_at: null,
    };
    receipts.set(key, row);
    options.onClaim?.();
    return {
      data: {
        ok: true,
        state: row.state,
        attempt_token: row.attempt_token,
        operation_id: row.operation_id,
        account_ref: row.account_id,
        channel_id: row.channel_id,
        binding_generation: row.binding_generation,
        digest_key_version: digestKey.version,
      },
      error: null,
    };
  }

  function mark(p: FakeRpcParams): FakeRpcResult {
    const key = `${p.p_owner_id}:${p.p_operation_id}`;
    const row = receipts.get(key);
    if (!row) return { data: { ok: false, reason: "not_found" }, error: null };
    if (row.attempt_token !== p.p_attempt_token) {
      return { data: { ok: false, reason: "invalid_token" }, error: null };
    }
    if (row.state === "dispatched") return { data: { ok: true, state: "dispatched", already: true }, error: null };
    if (row.state !== "claimed") return { data: { ok: false, reason: "invalid_state", state: row.state }, error: null };
    const account = accounts.get(row.account_id);
    if (!account || account.user_id !== row.owner_id || account.platform !== "youtube" ||
      !account.is_active || account.auth_provider !== "native" || account.needs_reauth ||
      account.platform_user_id !== p.p_expected_channel ||
      account.binding_generation !== Number(p.p_expected_generation) ||
      account.platform_user_id !== row.channel_id || account.binding_generation !== row.binding_generation) {
      row.state = "refused";
      row.reason = "binding_changed";
      row.settled_at = now();
      return { data: { ok: false, reason: "binding_changed", state: "refused" }, error: null };
    }
    const capability = row.ban_author ? "ban" : "write";
    if (!admits(account.id, capability)) {
      row.state = "refused";
      row.reason = "capability_denied";
      row.settled_at = now();
      return { data: { ok: false, reason: "capability_denied", state: "refused" }, error: null };
    }
    row.state = "dispatched";
    row.dispatched_at = now();
    return { data: { ok: true, state: "dispatched", dispatched_at: row.dispatched_at }, error: null };
  }

  function settle(p: FakeRpcParams): FakeRpcResult {
    if (options.failSettleOnce) {
      options.failSettleOnce = false;
      throw new Error("settlement database failure");
    }
    const key = `${p.p_owner_id}:${p.p_operation_id}`;
    const row = receipts.get(key);
    if (!row) return { data: { ok: false, reason: "not_found" }, error: null };
    if (row.attempt_token !== p.p_attempt_token) {
      return { data: { ok: false, reason: "invalid_token" }, error: null };
    }
    if (row.state === "confirmed" || row.state === "refused") {
      return { data: { ok: true, state: row.state, already: true }, error: null };
    }
    if (row.state === "claimed") {
      if (p.p_outcome !== "refused") return { data: { ok: false, reason: "invalid_state" }, error: null };
    } else if (p.p_outcome === "refused" && p.p_provider_class !== "http_4xx") {
      return { data: { ok: false, reason: "invalid_outcome", state: row.state }, error: null };
    }
    row.state = p.p_outcome as ReceiptRow["state"];
    row.reason = p.p_reason ?? null;
    row.provider_class = p.p_provider_class ?? null;
    row.result_thread_id = p.p_result_thread_id ?? null;
    row.result_comment_id = p.p_result_comment_id ?? null;
    row.settled_at = now();
    return { data: { ok: true, state: row.state }, error: null };
  }

  function status(p: FakeRpcParams): FakeRpcResult {
    const key = `${p.p_owner_id}:${p.p_operation_id}`;
    const row = receipts.get(key);
    if (!row) return { data: { ok: false, reason: "not_found" }, error: null };
    const account = accounts.get(String(p.p_account_id));
    // Bound to the account row the receipt was written for, not to a number.
    if (!account || account.user_id !== p.p_owner_id || account.platform !== "youtube" ||
      !account.is_active || account.id !== row.account_id ||
      account.platform_user_id !== row.channel_id ||
      account.binding_generation !== row.binding_generation) {
      return { data: { ok: false, reason: "not_found" }, error: null };
    }
    if (row.state === "dispatched" && row.dispatched_at !== null && now() - row.dispatched_at > 90_000) {
      row.state = "indeterminate";
      row.reason = row.reason ?? "no_settlement";
      row.settled_at = now();
    }
    return {
      data: {
        ok: true,
        operation_id: row.operation_id,
        action: row.action,
        state: row.state,
        reason: row.reason,
        provider_class: row.provider_class,
        moderation_status: row.moderation_status,
        ban_requested: row.ban_author,
        result_thread_id: row.result_thread_id,
        result_comment_id: row.result_comment_id,
        target_comment_id: row.comment_id,
        binding_generation: row.binding_generation,
        channel_id: row.channel_id,
      },
      error: null,
    };
  }

  const deps: Stage4Deps = {
    admin: admin as unknown as SupabaseClient,
    fetcher,
    now,
    // The anonymous-refusal gate measures cool-downs on a clock that wall-clock
    // steps cannot move. Unless a test drives it on its own, it follows `now`.
    monotonicNow: options.monotonicNow ?? options.now ?? (() => performance.now()),
    newRequestId: () => crypto.randomUUID(),
    signingSecret: TEST_SIGNER,
  };

  const corsHeaders = { "Access-Control-Allow-Origin": "https://app.example" };

  async function callAs(userId: string, action: string, extra: Record<string, unknown> = {}): Promise<Response> {
    return await handleStage4({
      deps,
      corsHeaders,
      userId,
      isServiceRole: false,
      body: { action, social_account_id: accounts.values().next().value!.id, ...extra },
    });
  }
  async function calls(action: string, extra: Record<string, unknown> = {}): Promise<Response> {
    return callAs(USER, action, extra);
  }

  return {
    deps,
    writes,
    reads,
    rpcLog,
    auditRows,
    receipts,
    accounts,
    setPolicy,
    calls,
    callAs,
  };
}

// ---- fixtures ----------------------------------------------------------------

function base64Key(hex: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return btoa(String.fromCharCode(...bytes));
}

function envelope(reason: string, message?: string) {
  return { error: { errors: [{ reason, message: message ?? reason }], message: message ?? reason } };
}

function playlistItem(videoId: string, title: string) {
  return { snippet: { resourceId: { videoId }, title, publishedAt: "2026-01-01T00:00:00Z" } };
}

/** Thread and top-level ids are deliberately UNEQUAL; replies sit at the
 * resource top level beside `snippet` (Google reference). */
function threadFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-9",
    snippet: {
      videoId: "vid-1",
      channelId: "UC-handler-test",
      topLevelComment: {
        id: "comment-7",
        snippet: {
          authorChannelId: { value: "UC-author-1" },
          authorDisplayName: "Author One",
          textOriginal: "top-level text",
          moderationStatus: "published",
          publishedAt: "2026-01-02T00:00:00Z",
        },
      },
    },
    replies: {
      comments: [
        {
          id: "comment-8",
          snippet: {
            parentId: "comment-7",
            authorChannelId: { value: "UC-handler-test" },
            authorDisplayName: "The Channel",
            textOriginal: "a reply by the channel",
            moderationStatus: "published",
            publishedAt: "2026-01-02T01:00:00Z",
          },
        },
      ],
    },
    ...overrides,
  };
}

function commentFixture(id: string, overrides: Record<string, unknown> = {}) {
  const merged = {
    id,
    snippet: {
      authorChannelId: { value: "UC-author-1" },
      authorDisplayName: "Author One",
      textOriginal: "observed text",
    } as Record<string, unknown>,
    ...overrides,
  } as { id: string; snippet: Record<string, unknown> };
  // comments.list?id= answers a reply WITH its parentId (the thread fixture's
  // reply is comment-8, under comment-7); a top-level comment has none.
  if (id === "comment-8" && !merged.snippet.parentId) {
    merged.snippet = { ...merged.snippet, parentId: "comment-7" };
  }
  return merged;
}

/** A reply as `comments.list?parentId=` returns it: snippet.parentId is set. */
function replyFixture(id: string, parentId = "comment-7") {
  return {
    id,
    snippet: {
      parentId,
      authorChannelId: { value: "UC-author-1" },
      authorDisplayName: "Author One",
      textOriginal: "a reply",
      moderationStatus: "published",
      publishedAt: "2026-01-03T00:00:00Z",
    },
  };
}

function createdThreadFixture(videoId: string) {
  return {
    id: "thread-new-1",
    snippet: {
      videoId,
      channelId: "UC-handler-test",
      topLevelComment: { id: "comment-new-1", snippet: { textOriginal: "sent" } },
    },
  };
}

async function jsonOf(res: Response): Promise<Answer> {
  return await res.json();
}

async function firstHandle(world: World): Promise<string> {
  const res = await world.calls("youtube_thread_page", { video_id: "vid-1", list: "published" });
  const body = await jsonOf(res);
  return body.data.items[0].handle as string;
}

async function replyHandle(world: World): Promise<string> {
  const res = await world.calls("youtube_thread_page", { video_id: "vid-1", list: "published" });
  const body = await jsonOf(res);
  return body.data.items[1].handle as string;
}

// ---- the tests ----------------------------------------------------------------

Deno.test("capabilities answers with per-capability booleans and no provider call", async () => {
  const world = createWorld();
  const res = await world.calls("youtube_stage4_capabilities");
  const body = await jsonOf(res);
  assertEquals(res.status, 200);
  assertEquals(body.data.capabilities.read.allowed, true);
  assertEquals(body.data.capabilities.ban.allowed, false);
  assertEquals(world.reads.length + world.writes.length, 0);
});

Deno.test("a video page lists uploads including ones with zero threads", async () => {
  const world = createWorld({
    provider: (call) => {
      if (call.path === "playlistItems") {
        return { status: 200, body: { items: [playlistItem("vid-empty", "No comments yet")] } };
      }
      return { status: 404, body: envelope("notFound") };
    },
  });
  const body = await jsonOf(await world.calls("youtube_video_page"));
  assertEquals(body.data.items[0].id, "vid-empty");
  assertEquals(body.data.items[0].title, "No comments yet");
  assertEquals(body.data.next_cursor, null);
});

Deno.test("thread pages keep thread and top-level ids apart and seal handles", async () => {
  const world = createWorld();
  const body = await jsonOf(await world.calls("youtube_thread_page", { video_id: "vid-1", list: "published" }));
  const [top, reply] = body.data.items;
  assertEquals(top.kind, "thread");
  assertEquals(top.comment_id, "comment-7");
  assertEquals(top.thread_id, "thread-9");
  assertEquals(top.video_id, "vid-1");
  assertEquals(top.canonical_parent_id, "");
  assertEquals(reply.kind, "reply");
  assertEquals(reply.comment_id, "comment-8");
  assertEquals(reply.canonical_parent_id, "comment-7", "a reply's canonical parent is the TOP-LEVEL comment id");
  assertEquals(typeof top.handle, "string");
  assertEquals(body.data.inconsistent_count, 0);
});

Deno.test("no handle is issued for an inconsistent chain, and the row is dropped", async () => {
  const cases: Array<[string, () => unknown, string]> = [
    ["wrong thread video", () => threadFixture({ snippet: { ...threadFixture().snippet, videoId: "vid-other" } }), "thread video"],
    ["wrong resource channel", () => threadFixture({ snippet: { ...threadFixture().snippet, channelId: "UC-someone-else" } }), "resource channel"],
    ["top-level comment with a parentId", () => {
      const t = threadFixture();
      (t.snippet.topLevelComment.snippet as Record<string, unknown>).parentId = "comment-x";
      return t;
    }, "parentId"],
    ["reply with a foreign parentId", () => {
      const t = threadFixture();
      t.replies.comments[0].snippet.parentId = "comment-foreign";
      return t;
    }, "reply parent"],
    ["comment videoId present and different", () => {
      const t = threadFixture();
      (t.snippet.topLevelComment.snippet as Record<string, unknown>).videoId = "vid-other";
      return t;
    }, "video present"],
  ];
  for (const [name, make] of cases) {
    const world = createWorld({ provider: (call) => call.path === "commentThreads" ? { status: 200, body: { items: [make()] } } : undefined });
    const body = await jsonOf(await world.calls("youtube_thread_page", { video_id: "vid-1", list: "published" }));
    assertEquals(body.data.items.length, 0, name);
    assertEquals(body.data.inconsistent_count, 1, name);
  }
  // A comment videoId that is ABSENT is acceptable: the thread carries the binding.
  const world = createWorld({
    provider: (call) => {
      if (call.path === "commentThreads") {
        const t = threadFixture();
        (t.snippet.topLevelComment.snippet as Record<string, unknown>).videoId = undefined;
        return { status: 200, body: { items: [t] } };
      }
      return undefined;
    },
  });
  const body = await jsonOf(await world.calls("youtube_thread_page", { video_id: "vid-1", list: "published" }));
  assertEquals(body.data.items.length, 2, "the top-level row and the inline reply both survive");
  assertEquals(body.data.inconsistent_count, 0);
});

Deno.test("more than 100 replies page with cursors and a hop cap kills a cycle", async () => {
  let page = 0;
  const world = createWorld({
    provider: (call) => {
      if (call.path === "comments" && call.method === "GET" && call.query.get("parentId")) {
        page += 1;
        if (page === 1) {
          const items = Array.from({ length: 50 }, (_, i) => replyFixture(`r-${i}`));
          return { status: 200, body: { items, nextPageToken: "page-2" } };
        }
        return { status: 200, body: { items: [replyFixture("r-last")] } };
      }
      return undefined;
    },
  });
  const handle = await firstHandle(world);
  const page1 = await jsonOf(await world.calls("youtube_reply_page", { parent_handle: handle }));
  assertEquals(page1.data.items.length, 50);
  assertEquals(typeof page1.data.next_cursor, "string");
  const page2 = await jsonOf(await world.calls("youtube_reply_page", { parent_handle: handle, cursor: page1.data.next_cursor }));
  assertEquals(page2.data.items.map((i) => i.comment_id), ["r-last"]);

  // A cyclic provider that always hands back the same token dies at the cap:
  // seal a cursor beyond the cap and the handler refuses it.
  const overCap = await sealCursor(
    { o: USER, a: world.accounts.values().next().value!.id, g: 1, vi: "vid-1", l: "published", p: "comment-7", a2: "reply_page", h: 501 },
    { signingSecret: TEST_SIGNER, now: Date.now(), ttlMs: 60_000 },
  );
  const refused = await jsonOf(await world.calls("youtube_reply_page", { parent_handle: handle, cursor: overCap }));
  assertEquals(refused.reason, "expired_handle");
});

Deno.test("create on a video with zero comments: exactly one write, confirmed receipt", async () => {
  const world = createWorld();
  const body = await jsonOf(await world.calls("youtube_create_thread", {
    video_id: "vid-1",
    text: "First!",
    operation_id: crypto.randomUUID(),
  }));
  assertEquals(body.data.state, "confirmed");
  assertEquals(body.data.result_comment_id, "comment-new-1");
  assertEquals(world.writes.length, 1);
  assertEquals(world.writes[0].path, "commentThreads");
});

Deno.test("the same key resubmitted returns the recorded state and never re-sends", async () => {
  const world = createWorld();
  const op = crypto.randomUUID();
  await world.calls("youtube_create_thread", { video_id: "vid-1", text: "Once", operation_id: op });
  const body = await jsonOf(await world.calls("youtube_create_thread", { video_id: "vid-1", text: "Once", operation_id: op }));
  assertEquals(body.data.state, "confirmed");
  assertEquals(world.writes.length, 1, "no second provider write for an already recorded key");
});

Deno.test("a different key with the same text inside the window is recently_posted", async () => {
  const world = createWorld();
  await world.calls("youtube_create_thread", { video_id: "vid-1", text: "Twice?", operation_id: crypto.randomUUID() });
  const res = await world.calls("youtube_create_thread", { video_id: "vid-1", text: "Twice?", operation_id: crypto.randomUUID() });
  const body = await jsonOf(res);
  assertEquals(res.status, 409);
  assertEquals(body.reason, "recently_posted");
  assertEquals(body.data, undefined);
  assertEquals(world.writes.length, 1);
});

Deno.test("a reply to a reply posts against the canonical parent, once", async () => {
  const world = createWorld();
  const handle = await replyHandle(world);
  const body = await jsonOf(await world.calls("youtube_reply", { target_handle: handle, text: "a nested answer", operation_id: crypto.randomUUID() }));
  assertEquals(body.data.state, "confirmed");
  assertEquals(world.writes.length, 1);
  const write = world.writes[0];
  assertEquals(write.path, "comments");
  assertEquals((write.body as { snippet: { parentId: unknown } }).snippet.parentId, "comment-7", "the canonical top-level parent is sent, not the reply's own id");
});

Deno.test("the channel can edit its own comment and its own reply", async () => {
  const world = createWorld({
    provider: (call) => {
      if (call.path === "commentThreads" && call.method === "GET") {
        // The top-level comment here is authored by the channel itself, so
        // both rows are editable by it.
        const t = threadFixture();
        t.snippet.topLevelComment.snippet.authorChannelId = { value: "UC-handler-test" };
        return { status: 200, body: { items: [t] } };
      }
      if (call.path === "comments" && call.method === "GET" && call.query.get("id")) {
        return { status: 200, body: { items: [commentFixture(call.query.get("id")!, { snippet: { authorChannelId: { value: "UC-handler-test" }, textOriginal: "old text" } })] } };
      }
      if (call.path === "comments" && call.method === "PUT") {
        return { status: 200, body: { id: (call.body as { id?: string }).id, snippet: { textOriginal: "new text" } } };
      }
      return undefined;
    },
  });
  for (const handle of [await firstHandle(world), await replyHandle(world)]) {
    world.writes.length = 0;
    const body = await jsonOf(await world.calls("youtube_edit_comment", { target_handle: handle, text: "new text", operation_id: crypto.randomUUID() }));
    assertEquals(body.data.state, "confirmed");
    assertEquals(world.writes.length, 1);
    assertEquals(world.writes[0].path, "comments");
  }
});

Deno.test("a foreign author on edit is refused with zero provider writes", async () => {
  const world = createWorld();
  const handle = await firstHandle(world); // author UC-author-1, not the channel
  const res = await world.calls("youtube_edit_comment", { target_handle: handle, text: "hijack", operation_id: crypto.randomUUID() });
  const body = await jsonOf(res);
  assertEquals(res.status, 403);
  assertEquals(body.reason, "target_not_owned");
  assertEquals(world.writes.length, 0);
});

Deno.test("publish and reject address the selected comment only; plain reject sends no banAuthor", async () => {
  const world = createWorld();
  const handle = await firstHandle(world);
  for (const status of ["published", "rejected"] as const) {
    const body = await jsonOf(await world.calls("youtube_moderate_comment", {
      target_handle: handle,
      status,
      operation_id: crypto.randomUUID(),
    }));
    assertEquals(body.data.state, "confirmed");
    const write = world.writes[world.writes.length - 1];
    assertEquals(write.path, "comments/setModerationStatus");
    assertEquals(write.query.get("id"), "comment-7");
    assertEquals(write.query.get("moderationStatus"), status);
    assertEquals(write.query.has("banAuthor"), false);
  }
});

Deno.test("moderation acceptance is 204 only: a 200 body is indeterminate", async () => {
  const world = createWorld({
    provider: (call) => call.path === "comments/setModerationStatus" ? { status: 200, body: {} } : undefined,
  });
  const handle = await firstHandle(world);
  const body = await jsonOf(await world.calls("youtube_moderate_comment", {
    target_handle: handle,
    status: "published",
    operation_id: crypto.randomUUID(),
  }));
  assertEquals(body.data.state, "indeterminate");
});

Deno.test("a valid reject-and-ban sends exactly one request with one id, rejected and banAuthor=true", async () => {
  const world = createWorld({
    policy: { [nativeAccount().id]: { read: true, held: true, write: true, ban: true } },
  });
  const handle = await firstHandle(world);
  const op = crypto.randomUUID();
  const conf = await jsonOf(await world.calls("youtube_ban_confirmation", { target_handle: handle, operation_id: op }));
  assertEquals(typeof conf.data.confirmation, "string");
  assertEquals(conf.data.author_channel_id, "UC-author-1");
  assertEquals(conf.data.expires_in_seconds, 120);

  world.writes.length = 0;
  const body = await jsonOf(await world.calls("youtube_moderate_comment", {
    target_handle: handle,
    status: "rejected",
    operation_id: op,
    ban_confirmation: conf.data.confirmation,
  }));
  assertEquals(body.data.state, "confirmed");
  assertEquals(body.data.ban_requested, true);
  assertEquals(world.writes.length, 1);
  const write = world.writes[0];
  assertEquals(write.query.get("id"), "comment-7");
  assertEquals(write.query.get("moderationStatus"), "rejected");
  assertEquals(write.query.get("banAuthor"), "true");
  assertEquals(body.data.moderation_status, "rejected");
  // No response ever carries a "banned" status.
  assertEquals((body.data as Record<string, unknown>)["banned"], undefined);
});

Deno.test("ban refusals: no token, an echoed author, an expired token, a token for another operation", async () => {
  const world = createWorld({
    policy: { [nativeAccount().id]: { read: true, held: true, write: true, ban: true } },
  });
  const handle = await firstHandle(world);
  const opA = crypto.randomUUID();
  const opB = crypto.randomUUID();

  // No confirmation token: this is a plain reject, and it must NOT carry banAuthor.
  world.writes.length = 0;
  await world.calls("youtube_moderate_comment", { target_handle: handle, status: "rejected", operation_id: opB });
  assertEquals(world.writes[0].query.has("banAuthor"), false);

  // An expired token (120 s TTL).
  const conf = await jsonOf(await world.calls("youtube_ban_confirmation", { target_handle: handle, operation_id: opA }));
  const later = createWorld({
    policy: { [nativeAccount().id]: { read: true, held: true, write: true, ban: true } },
    now: () => Date.now() + 121_000,
  });
  const laterHandle = await firstHandle(later);
  const res = await later.calls("youtube_moderate_comment", {
    target_handle: laterHandle,
    status: "rejected",
    operation_id: opA,
    ban_confirmation: conf.data.confirmation,
  });
  assertEquals((await jsonOf(res)).reason, "ban_confirmation_expired");
  assertEquals(later.writes.length, 0);

  // A token minted for another operation.
  world.writes.length = 0;
  const mismatch = await world.calls("youtube_moderate_comment", {
    target_handle: handle,
    status: "rejected",
    operation_id: opB,
    ban_confirmation: conf.data.confirmation,
  });
  assertEquals((await jsonOf(mismatch)).reason, "ban_confirmation_mismatch");
  assertEquals(world.writes.length, 0, "a mismatched ban refuses the whole operation with no fallback to plain reject");
});

Deno.test("ban needs an author channel that is not the channel itself", async () => {
  const world = createWorld({
    policy: { [nativeAccount().id]: { read: true, held: true, write: true, ban: true } },
    provider: (call) => {
      if (call.path === "comments" && call.method === "GET" && call.query.get("id")) {
        return { status: 200, body: { items: [commentFixture(call.query.get("id")!, { snippet: { authorChannelId: { value: "UC-handler-test" } } })] } };
      }
      return undefined;
    },
  });
  const handle = await firstHandle(world);
  const res = await world.calls("youtube_ban_confirmation", { target_handle: handle, operation_id: crypto.randomUUID() });
  assertEquals((await jsonOf(res)).reason, "target_missing_author");
  assertEquals(world.writes.length, 0);
});

Deno.test("strict schemas: unknown body keys are refused before anything runs", async () => {
  for (const extra of [{ banAuthor: true }, { user_id: USER }, { channel_id: "UC-x" }]) {
    const world = createWorld();
    const res = await world.calls("youtube_moderate_comment", {
      target_handle: "anything",
      status: "rejected",
      operation_id: crypto.randomUUID(),
      ...extra,
    });
    assertEquals(res.status, 400, String(Object.keys(extra)));
    assertEquals((await jsonOf(res)).reason, "invalid_request");
    assertEquals(world.writes.length + world.reads.length, 0);
    assertEquals(world.rpcLog.length, 0, "a schema refusal runs before the rate limiter");
  }
});

Deno.test("a service-role caller is refused on every Stage 4 action", async () => {
  // Schema-valid minimal bodies, so the refusal is the service-role one and
  // not a validation failure.
  const handle = "hdl.not-a-real-one";
  const op = crypto.randomUUID();
  const extra: Record<string, Record<string, unknown>> = {
    youtube_video_page: {},
    youtube_thread_page: { video_id: "vid-1", list: "published" },
    youtube_reply_page: { parent_handle: handle },
    youtube_create_thread: { video_id: "vid-1", text: "x", operation_id: op },
    youtube_reply: { target_handle: handle, text: "x", operation_id: op },
    youtube_edit_comment: { target_handle: handle, text: "x", operation_id: op },
    youtube_ban_confirmation: { target_handle: handle, operation_id: op },
    youtube_moderate_comment: { target_handle: handle, status: "published", operation_id: op },
    youtube_operation_status: { operation_id: op },
  };
  for (const action of STAGE4_ACTIONS) {
    const world = createWorld();
    const res = await handleStage4({
      deps: world.deps,
      corsHeaders: {},
      userId: "99999999-9999-4999-8999-999999999999",
      isServiceRole: true,
      body: { action, social_account_id: nativeAccount().id, ...(extra[action] ?? {}) },
    });
    assertEquals(res.status, 403, action);
    assertEquals((await jsonOf(res)).reason, "service_role_not_allowed", action);
    assertEquals(world.writes.length + world.reads.length, 0, action);
  }
});

Deno.test("a Composio account, a foreign account and a missing account are refused", async () => {
  const composio = nativeAccount({ id: "44444444-4444-4444-8444-444444444444", auth_provider: "composio" });
  const world = createWorld({ accounts: [nativeAccount(), composio] });
  const res = await world.callAs(USER, "youtube_stage4_capabilities", { social_account_id: composio.id });
  assertEquals(res.status, 403);
  assertEquals((await jsonOf(res)).reason, "provider_unsupported");

  const foreign = await world.callAs(OTHER_USER, "youtube_stage4_capabilities");
  assertEquals(foreign.status, 404);
  assertEquals((await jsonOf(foreign)).reason, "not_found", "a foreign account is refused exactly like a missing one (spec 8.1)");

  const missing = await world.calls("youtube_stage4_capabilities", { social_account_id: "55555555-5555-4555-8555-555555555555" });
  assertEquals(missing.status, 404);
  assertEquals((await jsonOf(missing)).reason, "not_found");
});

Deno.test("a cross-account or expired handle is refused as cross-context", async () => {
  const world = createWorld();
  const handle = await firstHandle(world);
  const otherAccount = nativeAccount({ id: "66666666-6666-4666-8666-666666666666", binding_generation: 2 });
  const otherWorld = createWorld({
    accounts: [otherAccount],
    policy: { [otherAccount.id]: { read: true, held: true, write: true, ban: false } },
  });
  const res = await otherWorld.calls("youtube_reply", { target_handle: handle, text: "x", operation_id: crypto.randomUUID() });
  assertEquals(res.status, 400);
  assertEquals((await jsonOf(res)).reason, "cross_context");
  assertEquals(otherWorld.writes.length, 0);

  const expired = await sealHandle(
    { o: USER, a: nativeAccount().id, g: 1, c: "UC-handler-test", vi: "vid-1", th: "thread-9", co: "comment-7", k: "thread", p: "", au: "UC-author-1", s: "published" },
    { signingSecret: TEST_SIGNER, now: Date.now() - 2 * HANDLE_TTL_MS, ttlMs: HANDLE_TTL_MS },
  );
  const res2 = await world.calls("youtube_reply", { target_handle: expired, text: "x", operation_id: crypto.randomUUID() });
  assertEquals((await jsonOf(res2)).reason, "expired_handle");
});

Deno.test("capability off: zero provider traffic of any kind for that capability", async () => {
  const world = createWorld({ policy: { [nativeAccount().id]: { read: true, held: true, write: false } } });
  const handle = await firstHandle(world); // read still works
  const res = await world.calls("youtube_reply", { target_handle: handle, text: "nope", operation_id: crypto.randomUUID() });
  assertEquals(res.status, 403);
  assertEquals((await jsonOf(res)).reason, "capability_off");
  assertEquals(world.writes.length, 0);
});

Deno.test("the Held list needs the held capability", async () => {
  const world = createWorld({ policy: { [nativeAccount().id]: { read: true, held: false, write: false } } });
  const res = await world.calls("youtube_thread_page", { video_id: "vid-1", list: "heldForReview" });
  assertEquals(res.status, 403);
  const published = await world.calls("youtube_thread_page", { video_id: "vid-1", list: "published" });
  assertEquals(published.status, 200);
});

Deno.test("T2.3 an unreadable rollout is an error, never a payload that looks like off: settings_unavailable on the capabilities action, upstream on every other", async () => {
  const world = createWorld({ admitsError: true });
  const res = await world.calls("youtube_stage4_capabilities");
  const body = await jsonOf(res);
  assertEquals(res.status, 503);
  assertEquals(body.reason, "settings_unavailable", "the capabilities answer names the settings as the cause");
  assertEquals("data" in body, false, "no capabilities payload of denials is returned");
  // The refusal is still audited, with the new reason and the verified owner and account.
  const audited = world.auditRows.find((row) => (row.metadata as { reason?: string }).reason === "settings_unavailable");
  assertEquals(audited?.user_id, USER);
  assertEquals((audited?.metadata as { action?: string }).action, "youtube_stage4_capabilities");

  const list = await world.calls("youtube_thread_page", { video_id: "vid-1", list: "published" });
  assertEquals(list.status, 503);
  assertEquals((await jsonOf(list)).reason, "upstream", "a list action keeps the generic 503");
});

Deno.test("credential preparation failure claims nothing", async () => {
  const world = createWorld({
    accounts: [nativeAccount({ token_expires_at: new Date(Date.now() - 1000).toISOString(), refresh_token: null })],
  });
  const res = await world.calls("youtube_create_thread", { video_id: "vid-1", text: "x", operation_id: crypto.randomUUID() });
  assertEquals(res.status, 401);
  assertEquals((await jsonOf(res)).reason, "account_needs_reauth");
  assertEquals(world.writes.length, 0);
  assertEquals(world.rpcLog.some((r) => r.fn === "youtube_comment_op_claim"), false, "nothing was claimed");
});

Deno.test("a rebinding between the claim and the mark refuses before any send", async () => {
  const world = createWorld();
  // The claim hook: rebind right after the receipt exists.
  const fakeAdmin = world.deps.admin as unknown as FakeAdmin;
  const originalRpc = fakeAdmin.rpc.bind(fakeAdmin);
  let rebinding = false;
  fakeAdmin.rpc = async (fn: string, params: Record<string, unknown>) => {
    const out = await originalRpc(fn, params);
    if (fn === "youtube_comment_op_claim" && (out.data as { ok?: boolean } | null)?.ok && rebinding) {
      world.accounts.get(nativeAccount().id)!.binding_generation += 1;
    }
    return out;
  };
  rebinding = true;
  const res = await world.calls("youtube_create_thread", { video_id: "vid-1", text: "mid-flight", operation_id: crypto.randomUUID() });
  const body = await jsonOf(res);
  assertEquals(res.status, 409);
  assertEquals(body.reason, "binding_changed");
  assertEquals(world.writes.length, 0);
  const row = [...world.receipts.values()][0];
  assertEquals(row.state, "refused");
});

Deno.test("a 401 write is refused after exactly one request: no refresh-and-resend", async () => {
  const world = createWorld({
    provider: (call) => call.method === "POST" ? { status: 401, body: envelope("required") } : undefined,
  });
  const op = crypto.randomUUID();
  const res = await world.calls("youtube_create_thread", { video_id: "vid-1", text: "auth me", operation_id: op });
  const body = await jsonOf(res);
  assertEquals(body.reason, "unauthorized_provider");
  assertEquals(world.writes.length, 1, "exactly one write; the Stage 4 transport never retries a 401");
  const row = [...world.receipts.values()][0];
  assertEquals(row.state, "refused");
});

Deno.test("an indeterminate create can never be re-sent by any later call", async () => {
  const world = createWorld({
    provider: (call) => {
      if (call.path === "commentThreads" && call.method === "POST") {
        return { status: 200, body: { id: null, snippet: {} } }; // a 2xx missing ids
      }
      return undefined;
    },
  });
  const op = crypto.randomUUID();
  const body = await jsonOf(await world.calls("youtube_create_thread", { video_id: "vid-1", text: "ghost", operation_id: op }));
  assertEquals(body.data.state, "indeterminate");
  assertEquals(world.writes.length, 1);

  // Same key: the recorded indeterminate state, never a resend.
  const again = await jsonOf(await world.calls("youtube_create_thread", { video_id: "vid-1", text: "ghost", operation_id: op }));
  assertEquals(again.data.state, "indeterminate");
  // Different key, same text: the unresolved fence.
  const other = await world.calls("youtube_create_thread", { video_id: "vid-1", text: "ghost", operation_id: crypto.randomUUID() });
  assertEquals((await jsonOf(other)).reason, "possible_duplicate");
  // Status reads the receipt and re-checks nothing on the provider.
  const status = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op }));
  assertEquals(status.data.state, "indeterminate");
  assertEquals(world.writes.length, 1, "still exactly one provider write");
});

Deno.test("a failed settlement is answered indeterminate, never confirmed, and stays queryable by the same key", async () => {
  const world = createWorld({ failSettleOnce: true });
  const op = crypto.randomUUID();
  const body = await jsonOf(await world.calls("youtube_create_thread", { video_id: "vid-1", text: "settled", operation_id: op }));
  // The provider accepted it, but the receipt could not be settled: telling
  // the browser "confirmed" would drop its key while the receipt cannot be read.
  assertEquals(body.data.state, "indeterminate");
  const row = [...world.receipts.values()][0];
  assertEquals(row.state, "dispatched", "the receipt stays dispatched when the settlement write fails");
  assertEquals(world.writes.length, 1, "the same key never causes a second provider write");
  await world.calls("youtube_create_thread", { video_id: "vid-1", text: "settled", operation_id: op });
  assertEquals(world.writes.length, 1, "resubmitting the same key still sends nothing");
  // The same key stays queryable: status reads the unsettled receipt (it converts to indeterminate after 90 s).
  const status = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op }));
  assertEquals(status.data.state, "dispatched");
  assertEquals(status.data.operation_id, op);
});

Deno.test("an incomplete 2xx evidence set is indeterminate, never confirmed (spec 9.2)", async () => {
  const incomplete: Array<{ label: string; answer: (call: ProviderCall) => { status: number; body: unknown } | undefined }> = [
    { label: "thread id standing in for the top-level comment", answer: (c) => c.path === "commentThreads" && c.method === "POST" ? { status: 200, body: { id: "t-1", snippet: { videoId: "vid-1", channelId: "UC-handler-test" } } } : undefined },
    { label: "no snippet.videoId", answer: (c) => c.path === "commentThreads" && c.method === "POST" ? { status: 200, body: { id: "t-1", snippet: { channelId: "UC-handler-test", topLevelComment: { id: "c-1" } } } } : undefined },
    { label: "no snippet.channelId", answer: (c) => c.path === "commentThreads" && c.method === "POST" ? { status: 200, body: { id: "t-1", snippet: { videoId: "vid-1", topLevelComment: { id: "c-1" } } } } : undefined },
  ];
  for (const item of incomplete) {
    const world = createWorld({ provider: item.answer });
    const body = await jsonOf(await world.calls("youtube_create_thread", { video_id: "vid-1", text: item.label, operation_id: crypto.randomUUID() }));
    assertEquals(body.data.state, "indeterminate", item.label);
    assertEquals(world.writes.length, 1, item.label);
  }
  // A reply without snippet.parentId is incomplete as well.
  const replyWorld = createWorld({
    provider: (c) => c.path === "comments" && c.method === "POST" ? { status: 200, body: { id: "r-1", snippet: {} } } : undefined,
  });
  const reply = await jsonOf(await replyWorld.calls("youtube_reply", { target_handle: await firstHandle(replyWorld), text: "hello", operation_id: crypto.randomUUID() }));
  assertEquals(reply.data.state, "indeterminate", "reply with no parentId in the answer");
});

Deno.test("status converts a dispatched receipt to indeterminate after 90 seconds", async () => {
  let clock = Date.now();
  const world = createWorld({
    now: () => clock,
    failSettleOnce: true,
    provider: (call) => {
      if (call.path === "commentThreads" && call.method === "POST") throw new Error("response lost before settlement");
      return undefined;
    },
  });
  const op = crypto.randomUUID();
  const body = await jsonOf(await world.calls("youtube_create_thread", { video_id: "vid-1", text: "lost", operation_id: op }));
  assertEquals(body.data.state, "indeterminate");
  assertEquals([...world.receipts.values()][0].state, "dispatched", "the settlement failed, so the receipt is still dispatched");
  const early = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op }));
  assertEquals(early.data.state, "dispatched", "inside the 90 seconds it is not converted");

  clock += 91_000;
  const status = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op }));
  assertEquals(status.data.state, "indeterminate", "after 90 seconds the status read converts it");
});

Deno.test("operation status is exempt from the needs_reauth refusal", async () => {
  const world = createWorld();
  const op = crypto.randomUUID();
  await world.calls("youtube_create_thread", { video_id: "vid-1", text: "aging", operation_id: op });
  world.accounts.get(nativeAccount().id)!.needs_reauth = true;
  const body = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op }));
  assertEquals(body.data.state, "confirmed", "the receipt stays readable under the current binding");
  const refused = await world.calls("youtube_thread_page", { video_id: "vid-1", list: "published" });
  assertEquals(refused.status, 403, "reads still refuse");
});

Deno.test("the edit observation distinguishes requested from different text", async () => {
  const world = createWorld({
    provider: (call) => {
      if (call.path === "commentThreads" && call.method === "GET") {
        const t = threadFixture();
        t.snippet.topLevelComment.snippet.authorChannelId = { value: "UC-handler-test" };
        return { status: 200, body: { items: [t] } };
      }
      if (call.path === "comments" && call.method === "GET" && call.query.get("id")) {
        return { status: 200, body: { items: [commentFixture(call.query.get("id")!, { snippet: { authorChannelId: { value: "UC-handler-test" }, textOriginal: "edited text" } })] } };
      }
      if (call.path === "comments" && call.method === "PUT") {
        return { status: 200, body: { id: (call.body as { id?: string }).id, snippet: {} } };
      }
      return undefined;
    },
  });
  const handle = await firstHandle(world);
  const op = crypto.randomUUID();
  await world.calls("youtube_edit_comment", { target_handle: handle, text: "edited text", operation_id: op });
  const withDraft = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op, text: "edited text" }));
  assertEquals(withDraft.data.observation, "requested_text_observed");
  const withoutDraft = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op }));
  assertEquals(withoutDraft.data.observation, "unavailable");
});

Deno.test("comments disabled, quota and scope-missing classify as themselves", async () => {
  const cases: Array<[string, string]> = [
    ["commentsDisabled", "comments_disabled"],
    ["quotaExceeded", "quota"],
    ["insufficientPermissions", "scope_missing"],
  ];
  for (const [reason, expected] of cases) {
    const world = createWorld({
      provider: (call) => call.path === "commentThreads" && call.method === "GET"
        ? { status: 403, body: envelope(reason) }
        : undefined,
    });
    const res = await world.calls("youtube_thread_page", { video_id: "vid-1", list: "published" });
    assertEquals((await jsonOf(res)).reason, expected, reason);
    // A scope refusal leaves the stored grants (the account row) untouched.
    assertEquals(world.accounts.get(nativeAccount().id)!.needs_reauth, false, reason);
  }
});

Deno.test("a true empty list and an empty page with a next token are told apart", async () => {
  const empty = createWorld({
    provider: (call) => call.path === "commentThreads" ? { status: 200, body: { items: [] } } : undefined,
  });
  const emptyBody = await jsonOf(await empty.calls("youtube_thread_page", { video_id: "vid-1", list: "published" }));
  assertEquals(emptyBody.data.items.length, 0);
  assertEquals(emptyBody.data.next_cursor, null);

  const withToken = createWorld({
    provider: (call) => call.path === "commentThreads" ? { status: 200, body: { items: [], nextPageToken: "more" } } : undefined,
  });
  const tokenBody = await jsonOf(await withToken.calls("youtube_thread_page", { video_id: "vid-1", list: "published" }));
  assertEquals(typeof tokenBody.data.next_cursor, "string", "an empty page with a next token advances");
});

Deno.test("the rate limit refuses before any provider or database work", async () => {
  const world = createWorld({ rateLimited: true });
  const res = await world.calls("youtube_video_page");
  assertEquals(res.status, 429);
  assertEquals((await jsonOf(res)).reason, "rate_limited");
  assertEquals(world.reads.length + world.writes.length, 0);
});

Deno.test("an unparseable body is an audited invalid_request", async () => {
  const world = createWorld();
  const res = await handleStage4({ deps: world.deps, corsHeaders: {}, userId: USER, isServiceRole: false, body: undefined });
  assertEquals(res.status, 400);
  assertEquals((await jsonOf(res)).reason, "invalid_request");
  assertEquals(world.auditRows.length, 1);
  assertEquals(world.auditRows[0].user_id, USER);
});

Deno.test("every refusal writes exactly one redacted audit row with no secrets", async () => {
  const world = createWorld();
  await world.calls("youtube_stage4_capabilities", { social_account_id: "77777777-7777-4777-8777-777777777777" }); // not_found
  await handleStage4({ deps: world.deps, corsHeaders: {}, userId: USER, isServiceRole: true, body: { action: "youtube_reply", social_account_id: nativeAccount().id, target_handle: "h", text: "secret text", operation_id: crypto.randomUUID() } });
  assertEquals(world.auditRows.length, 2);
  for (const row of world.auditRows) {
    assertEquals(row.level, "warn");
    assertEquals(row.category, "edge");
    assertEquals(row.source, "comment-manager");
    const metadata = row.metadata as Record<string, unknown>;
    assertEquals(Object.keys(metadata).sort(), ["action", "provider_class", "reason", "request_id"]);
    assertEquals(JSON.stringify(row).includes("secret text"), false, "comment text never reaches the audit");
  }
  // The identified service-role refusal carries the user id.
  assertEquals(world.auditRows[1].user_id, USER);
});

Deno.test("the unauthenticated audit bucket is rate-bounded with a counter row", async () => {
  const world = createWorld();
  for (let i = 0; i < 32; i++) {
    await handleStage4({ deps: world.deps, corsHeaders: {}, userId: "", isServiceRole: false, body: undefined });
  }
  // The audit writes are fire-and-forget by design; let them settle.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const normal = world.auditRows.filter((r) => (r.metadata as Record<string, unknown>).reason !== "audit_suppressed");
  const counters = world.auditRows.filter((r) => (r.metadata as Record<string, unknown>).reason === "audit_suppressed");
  assertEquals(normal.length, 30, "at most 30 anonymous rows per minute");
  assertEquals(counters.length >= 1, true, "one suppression counter row is written");
  const suppressed = (counters[counters.length - 1].metadata as Record<string, unknown>).suppressed;
  assertEquals(typeof suppressed === "number" && suppressed >= 1, true);
});

Deno.test("legacy actions are not captured by the Stage 4 route", () => {
  const legacy = [
    "get_page_comments", "get_ig_comments", "get_youtube_comments", "get_youtube_videos",
    "reply_comment", "hide_comment", "delete_comment",
  ];
  for (const action of legacy) {
    assertEquals((STAGE4_ACTIONS as readonly string[]).includes(action), false, action);
  }
});

// ---- review findings: target validation, ban timing, audit, status -------------

Deno.test("a thread row is dropped when it lacks the video, the channel, a top-level id, or an inline reply lacks its parent", async () => {
  const good = threadFixture();
  const noVideo = threadFixture();
  delete (noVideo.snippet as Record<string, unknown>).videoId;
  const noChannel = threadFixture();
  delete (noChannel.snippet as Record<string, unknown>).channelId;
  const noTop = threadFixture();
  delete (noTop.snippet.topLevelComment as Record<string, unknown>).id;
  const noParent = threadFixture();
  delete (noParent.replies!.comments[0].snippet as Record<string, unknown>).parentId;
  const world = createWorld({
    provider: (call) => call.path === "commentThreads" && call.method === "GET"
      ? { status: 200, body: { items: [noVideo, noChannel, noTop, noParent, good] } }
      : undefined,
  });
  const body = await jsonOf(await world.calls("youtube_thread_page", { video_id: "vid-1", list: "published" }));
  assertEquals(body.data.inconsistent_count, 4);
  assertEquals(body.data.items.length, 2, "only the consistent thread and its reply were given handles");
});

/** A provider whose top-level comment is authored by the channel itself, so an edit handle can be issued. */
function ownTopProvider(next?: (call: ProviderCall) => { status: number; body: unknown } | undefined) {
  return (call: ProviderCall): { status: number; body: unknown } | undefined => {
    if (call.path === "commentThreads" && call.method === "GET") {
      const t = threadFixture();
      t.snippet.topLevelComment.snippet.authorChannelId = { value: "UC-handler-test" };
      return { status: 200, body: { items: [t] } };
    }
    return next?.(call);
  };
}

Deno.test("reply, edit and moderate each re-prove video ownership before claiming", async () => {
  let foreignVideo = false;
  const world = createWorld({
    provider: ownTopProvider((call) => call.path === "videos" && foreignVideo
      ? { status: 200, body: { items: [{ id: call.query.get("id"), snippet: { channelId: "UC-someone-else" } }] } }
      : (call.path === "comments" && call.method === "GET" && call.query.get("id") === "comment-7"
        ? { status: 200, body: { items: [commentFixture("comment-7", { snippet: { authorChannelId: { value: "UC-handler-test" }, textOriginal: "mine" } })] } }
        : undefined)),
  });
  const handle = await firstHandle(world);
  foreignVideo = true;
  world.writes.length = 0;
  for (const [action, extra] of [
    ["youtube_reply", { text: "hi" }],
    ["youtube_edit_comment", { text: "edited" }],
    ["youtube_moderate_comment", { status: "published" }],
  ] as const) {
    const res = await world.calls(action, { target_handle: handle, operation_id: crypto.randomUUID(), ...extra });
    assertEquals((await jsonOf(res)).reason, "video_not_owned", action);
  }
  assertEquals(world.writes.length, 0);
  assertEquals(world.receipts.size, 0, "nothing was claimed");
});

Deno.test("a target whose parent contradicts its handle is refused for reply, edit and moderate, with zero writes", async () => {
  // comment-7 is a thread handle (no parent); comment-8 is a reply handle (parent comment-7).
  const cases: Array<{ label: string; target: "comment-7" | "comment-8"; snippet: Record<string, unknown> }> = [
    { label: "thread handle, but the comment now reports a parent", target: "comment-7", snippet: { parentId: "comment-other", authorChannelId: { value: "UC-handler-test" } } },
    { label: "reply handle, but the comment reports no parent", target: "comment-8", snippet: { authorChannelId: { value: "UC-handler-test" } } },
    { label: "reply handle, but the comment reports another parent", target: "comment-8", snippet: { parentId: "comment-other", authorChannelId: { value: "UC-handler-test" } } },
    { label: "the comment reports another channel", target: "comment-7", snippet: { channelId: "UC-someone-else", authorChannelId: { value: "UC-handler-test" } } },
    { label: "the comment reports another video", target: "comment-7", snippet: { videoId: "vid-other", authorChannelId: { value: "UC-handler-test" } } },
  ];
  for (const c of cases) {
    let contradict = false;
    const world = createWorld({
      provider: ownTopProvider((call) => call.path === "comments" && call.method === "GET" && call.query.get("id") === c.target && contradict
        ? { status: 200, body: { items: [{ id: c.target, snippet: c.snippet }] } }
        : undefined),
    });
    const handle = c.target === "comment-7" ? await firstHandle(world) : await replyHandle(world);
    contradict = true;
    world.writes.length = 0;
    for (const [action, extra] of [
      ["youtube_reply", { text: "hi" }],
      ["youtube_edit_comment", { text: "edited" }],
      ["youtube_moderate_comment", { status: "published" }],
    ] as const) {
      const res = await world.calls(action, { target_handle: handle, operation_id: crypto.randomUUID(), ...extra });
      assertEquals((await jsonOf(res)).reason, "target_not_verified", `${c.label} / ${action}`);
    }
    assertEquals(world.writes.length, 0, c.label);
  }
});

Deno.test("ban: the capability is checked before any provider read, and the author is matched on the authorising read", async () => {
  const world = createWorld({ policy: { [nativeAccount().id]: { read: true, held: true, write: true, ban: true } } });
  const handle = await firstHandle(world);
  const op = crypto.randomUUID();
  const conf = await jsonOf(await world.calls("youtube_ban_confirmation", { target_handle: handle, operation_id: op }));

  // ban turned off, write still on: refused BEFORE any provider read.
  world.setPolicy({ [nativeAccount().id]: { read: true, held: true, write: true, ban: false } });
  world.reads.length = 0;
  world.writes.length = 0;
  const res = await world.calls("youtube_moderate_comment", { target_handle: handle, status: "rejected", operation_id: op, ban_confirmation: conf.data.confirmation });
  assertEquals(res.status, 403);
  assertEquals(world.reads.length, 0, "no provider read happened for a ban the account is no longer admitted for");
  assertEquals(world.writes.length, 0);

  // ban on, but the comment's author changed since the token: the SAME
  // read that authorises the write exposes it. Exactly video + comment reads.
  const swapped = createWorld({
    policy: { [nativeAccount().id]: { read: true, held: true, write: true, ban: true } },
    provider: (call) => call.path === "comments" && call.method === "GET" && call.query.get("id") === "comment-7"
      ? { status: 200, body: { items: [commentFixture("comment-7", { snippet: { authorChannelId: { value: "UC-author-2" }, textOriginal: "x" } })] } }
      : undefined,
  });
  const h2 = await firstHandle(swapped);
  // a token minted for the ORIGINAL author through the first world's secret scheme
  const op2 = crypto.randomUUID();
  const original = createWorld({ policy: { [nativeAccount().id]: { read: true, held: true, write: true, ban: true } } });
  const h3 = await firstHandle(original);
  const conf2 = await jsonOf(await original.calls("youtube_ban_confirmation", { target_handle: h3, operation_id: op2 }));
  swapped.reads.length = 0;
  swapped.writes.length = 0;
  const mismatch = await swapped.calls("youtube_moderate_comment", { target_handle: h2, status: "rejected", operation_id: op2, ban_confirmation: conf2.data.confirmation });
  assertEquals((await jsonOf(mismatch)).reason, "ban_confirmation_mismatch");
  assertEquals(swapped.reads.map((r) => r.path), ["videos", "comments"], "one video read and ONE comment read, no separate author read");
  assertEquals(swapped.writes.length, 0);
});

Deno.test("ban turned off between the claim and the mark: the mark refuses and nothing is sent", async () => {
  const world: World = createWorld({
    policy: { [nativeAccount().id]: { read: true, held: true, write: true, ban: true } },
    onClaim: () => world.setPolicy({ [nativeAccount().id]: { read: true, held: true, write: true, ban: false } }),
  });
  const handle = await firstHandle(world);
  const op = crypto.randomUUID();
  const conf = await jsonOf(await world.calls("youtube_ban_confirmation", { target_handle: handle, operation_id: op }));
  world.writes.length = 0;
  const res = await world.calls("youtube_moderate_comment", { target_handle: handle, status: "rejected", operation_id: op, ban_confirmation: conf.data.confirmation });
  assertEquals((await jsonOf(res)).reason, "capability_denied");
  assertEquals(world.writes.length, 0, "zero provider writes: banAuthor=true was never sent");
  assertEquals([...world.receipts.values()][0].state, "refused");
});

Deno.test("a failed status READ is a temporary upstream error, not 'no receipt'", async () => {
  const failing = createWorld({ statusRpcError: true });
  const res = await failing.calls("youtube_operation_status", { operation_id: crypto.randomUUID() });
  assertEquals(res.status, 503);
  assertEquals((await jsonOf(res)).reason, "upstream");

  const healthy = createWorld();
  const none = await healthy.calls("youtube_operation_status", { operation_id: crypto.randomUUID() });
  assertEquals(none.status, 404);
  assertEquals((await jsonOf(none)).reason, "not_found");
});

Deno.test("a receipt is readable only through the account it was written for", async () => {
  const sibling = { ...nativeAccount(), id: "44444444-4444-4444-8444-444444444444", platform_user_id: "UC-sibling" };
  const world = createWorld({
    accounts: [nativeAccount(), sibling],
    policy: { [nativeAccount().id]: { read: true, held: true, write: true, ban: false } },
  });
  const op = crypto.randomUUID();
  await world.calls("youtube_create_thread", { video_id: "vid-1", text: "mine", operation_id: op });
  const own = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op }));
  assertEquals(own.data.state, "confirmed");
  // The sibling shares the generation number (both rows are at 1) but is another binding.
  const viaSibling = await world.callAs(USER, "youtube_operation_status", { operation_id: op, social_account_id: sibling.id });
  assertEquals(viaSibling.status, 404);
  assertEquals((await jsonOf(viaSibling)).reason, "not_found");
});

Deno.test("refusal audit rows carry only verified identifiers", async () => {
  // Rate limited: the account id and key are unverified at that point.
  const limited = createWorld({ rateLimited: true });
  await limited.calls("youtube_create_thread", { video_id: "vid-1", text: "x", operation_id: crypto.randomUUID() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const limitedMeta = limited.auditRows[0].metadata as Record<string, unknown>;
  assertEquals(limitedMeta.reason, "rate_limited");
  assertEquals("account_id" in limitedMeta, false);
  assertEquals("operation_id" in limitedMeta, false);

  // A pre-claim refusal (foreign author on edit): the operation key is unproven.
  const world = createWorld();
  const handle = await firstHandle(world);
  await world.calls("youtube_edit_comment", { target_handle: handle, text: "hijack", operation_id: crypto.randomUUID() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const pre = world.auditRows.at(-1)!.metadata as Record<string, unknown>;
  assertEquals(pre.reason, "target_not_owned");
  assertEquals("operation_id" in pre, false, "a key is not logged before a receipt exists for it");

  // A post-claim refusal (the mark refuses): the key is proven by the receipt.
  const late: World = createWorld({ onClaim: () => late.setPolicy({ [nativeAccount().id]: { read: true, held: true, write: false, ban: false } }) });
  const op = crypto.randomUUID();
  const lh = await firstHandle(late);
  await late.calls("youtube_moderate_comment", { target_handle: lh, status: "published", operation_id: op });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const post = late.auditRows.at(-1)!.metadata as Record<string, unknown>;
  assertEquals(post.reason, "capability_denied");
  assertEquals(post.operation_id, op);
});

Deno.test("an audit insert that returns { error } is reported, never silent and never a changed answer", async () => {
  const world = createWorld();
  const warnings: string[] = [];
  const nativeWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    (world.deps.admin as { from: (t: string) => unknown }).from = ((original) => (table: string) =>
      table === "system_logs" ? { insert: () => Promise.resolve({ error: { message: "insert failed" } }) } : original(table)
    )((world.deps.admin as { from: (t: string) => unknown }).from.bind(world.deps.admin));
    const res = await world.calls("youtube_stage4_capabilities", { social_account_id: "77777777-7777-4777-8777-777777777777" });
    assertEquals(res.status, 404, "the answer is unchanged");
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    console.warn = nativeWarn;
  }
  assertEquals(warnings.some((w) => w.includes("audit insert failed")), true);
});

Deno.test("only writes and the ban confirmation are held to the low caps; capability status and receipt status are reads", async () => {
  const world = createWorld();
  const op = crypto.randomUUID();
  await world.calls("youtube_stage4_capabilities");
  await world.calls("youtube_operation_status", { operation_id: op });
  await world.calls("youtube_video_page");
  await world.calls("youtube_create_thread", { video_id: "vid-1", text: "limits", operation_id: op });
  const maxFor = (needle: string) =>
    world.rpcLog.find((c) => c.fn === "check_rate_limit" && String(c.params.p_endpoint).includes(needle))?.params.p_max_requests;
  assertEquals(maxFor("youtube_stage4_capabilities"), 120, "the page asks for capabilities on every load");
  assertEquals(maxFor("youtube_operation_status"), 120);
  assertEquals(maxFor("stage4:read"), 120);
  assertEquals(maxFor("youtube_create_thread"), 20);
});

Deno.test("a failed account READ is a temporary 503 upstream for every action, never not_found", async () => {
  const world = createWorld({ accountReadError: true });
  for (const action of ["youtube_operation_status", "youtube_stage4_capabilities", "youtube_video_page"]) {
    const res = await world.calls(action, action === "youtube_operation_status" ? { operation_id: crypto.randomUUID() } : {});
    assertEquals(res.status, 503, action);
    assertEquals((await jsonOf(res)).reason, "upstream", action);
  }
  assertEquals(world.writes.length + world.reads.length, 0, "no provider call on a failed read");

  // An absent row is still the identical not_found.
  const healthy = createWorld();
  const absent = await healthy.calls("youtube_operation_status", { operation_id: crypto.randomUUID(), social_account_id: "88888888-8888-4888-8888-888888888888" });
  assertEquals(absent.status, 404);
  assertEquals((await jsonOf(absent)).reason, "not_found");
});

Deno.test("a 2xx whose ids are not non-empty strings is indeterminate, never coerced into a confirmation", async () => {
  const malformed: Array<{ label: string; action: string; extra: () => Promise<Record<string, unknown>>; answer: (c: ProviderCall) => { status: number; body: unknown } | undefined }> = [];
  const post = (path: string, method: string, body: unknown) => (c: ProviderCall) =>
    c.path === path && c.method === method ? { status: 200, body } : undefined;
  malformed.push(
    { label: "create: numeric thread id", action: "youtube_create_thread", extra: () => Promise.resolve({ video_id: "vid-1", text: "a" }),
      answer: post("commentThreads", "POST", { id: 123, snippet: { videoId: "vid-1", channelId: "UC-handler-test", topLevelComment: { id: "c-1" } } }) },
    { label: "create: object top-level id", action: "youtube_create_thread", extra: () => Promise.resolve({ video_id: "vid-1", text: "b" }),
      answer: post("commentThreads", "POST", { id: "t-1", snippet: { videoId: "vid-1", channelId: "UC-handler-test", topLevelComment: { id: { v: 1 } } } }) },
    { label: "create: array video id", action: "youtube_create_thread", extra: () => Promise.resolve({ video_id: "vid-1", text: "c" }),
      answer: post("commentThreads", "POST", { id: "t-1", snippet: { videoId: ["vid-1"], channelId: "UC-handler-test", topLevelComment: { id: "c-1" } } }) },
    { label: "create: blank thread id", action: "youtube_create_thread", extra: () => Promise.resolve({ video_id: "vid-1", text: "d" }),
      answer: post("commentThreads", "POST", { id: "  ", snippet: { videoId: "vid-1", channelId: "UC-handler-test", topLevelComment: { id: "c-1" } } }) },
  );
  for (const item of malformed) {
    const world = createWorld({ provider: item.answer });
    const body = await jsonOf(await world.calls(item.action, { ...(await item.extra()), operation_id: crypto.randomUUID() }));
    assertEquals(body.data.state, "indeterminate", item.label);
    assertEquals(world.writes.length, 1, item.label);
  }

  // reply: a non-string comment id; edit: an array that would stringify to the target id.
  const replyWorld = createWorld({ provider: post("comments", "POST", { id: 42, snippet: { parentId: "comment-7" } }) });
  const reply = await jsonOf(await replyWorld.calls("youtube_reply", { target_handle: await firstHandle(replyWorld), text: "r", operation_id: crypto.randomUUID() }));
  assertEquals(reply.data.state, "indeterminate", "reply: numeric id");

  const editWorld = createWorld({
    provider: ownTopProvider((c) =>
      c.path === "comments" && c.method === "GET" && c.query.get("id") === "comment-7"
        ? { status: 200, body: { items: [commentFixture("comment-7", { snippet: { authorChannelId: { value: "UC-handler-test" }, textOriginal: "mine" } })] } }
        : post("comments", "PUT", { id: ["comment-7"], snippet: {} })(c)),
  });
  const edit = await jsonOf(await editWorld.calls("youtube_edit_comment", { target_handle: await firstHandle(editWorld), text: "e", operation_id: crypto.randomUUID() }));
  assertEquals(edit.data.state, "indeterminate", "edit: an array is not the target id");
});

Deno.test("a digest key load failure is an audited 503, not an uncaught throw", async () => {
  const world = createWorld({ digestKeysError: true });
  const handle = await firstHandle(world);
  world.writes.length = 0;
  const res = await world.calls("youtube_reply", { target_handle: handle, text: "hi", operation_id: crypto.randomUUID() });
  assertEquals(res.status, 503);
  assertEquals((await jsonOf(res)).reason, "upstream");
  assertEquals(world.writes.length, 0);
  assertEquals(world.auditRows.length, 1, "the refusal reached the audit path");
});

Deno.test("the refusal audit is finished before the answer is returned (it is part of the request)", async () => {
  const world = createWorld();
  // The audit insert only completes when the test lets it: if the handler did not await it
  // (a `void` write), the answer would arrive while the row is still unwritten.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let signalEntered: () => void = () => undefined;
  const insertEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const written: Array<Record<string, unknown>> = [];
  const admin = world.deps.admin as unknown as { from: (table: string) => unknown };
  const originalFrom = admin.from.bind(admin);
  admin.from = (table: string) => table === "system_logs"
    ? { insert: async (row: Record<string, unknown>) => { signalEntered(); await gate; written.push(row); return { error: null }; } }
    : originalFrom(table);
  let answered = false;
  const pending = world.calls("youtube_stage4_capabilities", { social_account_id: "77777777-7777-4777-8777-777777777777" })
    .then((res) => { answered = true; return res; });
  // Only once the insert has been ENTERED is "not answered yet" evidence that the answer waits for it.
  await insertEntered;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(answered, false, "the answer waits for the audit write");
  assertEquals(written.length, 0);
  release();
  const res = await pending;
  assertEquals(res.status, 404);
  assertEquals(written.length, 1, "the row was written before the answer was returned");
});

Deno.test("a failed suppression-counter insert is reported", async () => {
  const world = createWorld();
  const warnings: string[] = [];
  const nativeWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    (world.deps.admin as { from: (t: string) => unknown }).from = ((original) => (table: string) =>
      table === "system_logs" ? { insert: () => Promise.resolve({ error: { message: "insert failed" } }) } : original(table)
    )((world.deps.admin as { from: (t: string) => unknown }).from.bind(world.deps.admin));
    for (let i = 0; i < 32; i++) {
      await handleStage4({ deps: world.deps, corsHeaders: {}, userId: "", isServiceRole: false, body: undefined });
    }
  } finally {
    console.warn = nativeWarn;
  }
  assertEquals(warnings.some((w) => w.includes("counter insert failed")), true);
});

Deno.test("a key rotation between the digests and the claim is a retryable 503 for edit and moderate, with nothing sent or stored", async () => {
  const world = createWorld({
    // The handler read key version 1; SQL already runs version 2.
    sqlActiveKeyVersion: 2,
    provider: ownTopProvider((c) =>
      c.path === "comments" && c.method === "GET" && c.query.get("id") === "comment-7"
        ? { status: 200, body: { items: [commentFixture("comment-7", { snippet: { authorChannelId: { value: "UC-handler-test" }, textOriginal: "mine" } })] } }
        : undefined),
  });
  const handle = await firstHandle(world);
  world.writes.length = 0;
  world.rpcLog.length = 0;
  for (const [action, extra] of [
    ["youtube_edit_comment", { text: "edited" }],
    ["youtube_moderate_comment", { status: "published" }],
  ] as const) {
    const res = await world.calls(action, { target_handle: handle, operation_id: crypto.randomUUID(), ...extra });
    assertEquals(res.status, 503, action);
    assertEquals((await jsonOf(res)).reason, "upstream", action);
  }
  assertEquals(world.writes.length, 0, "nothing reached the provider");
  assertEquals(world.receipts.size, 0, "no receipt was stored");
  assertEquals(world.rpcLog.some((c) => c.fn === "youtube_comment_op_mark_dispatched"), false, "nothing was marked dispatched");
  // The 503 must come from the CLAIM refusing the stale key version, not from the key read failing
  // earlier: the keys were read, and a claim was attempted for each of the two actions.
  assertEquals(world.rpcLog.filter((c) => c.fn === "youtube_comment_digest_keys").length >= 2, true, "the digest keys were read");
  assertEquals(world.rpcLog.filter((c) => c.fn === "youtube_comment_op_claim").length, 2, "a claim was attempted for each action");
});

Deno.test("a ban confirmation with Hold or Publish is refused before any provider work", async () => {
  const world = createWorld({
    policy: { [nativeAccount().id]: { read: true, held: true, write: true, ban: true } },
  });
  const handle = await firstHandle(world);
  const op = crypto.randomUUID();
  const conf = await jsonOf(await world.calls("youtube_ban_confirmation", { target_handle: handle, operation_id: op }));
  world.reads.length = 0;
  world.writes.length = 0;
  world.rpcLog.length = 0;
  for (const status of ["published", "heldForReview"]) {
    const res = await world.calls("youtube_moderate_comment", {
      target_handle: handle, status, operation_id: op, ban_confirmation: conf.data.confirmation,
    });
    assertEquals(res.status, 400, status);
    assertEquals((await jsonOf(res)).reason, "invalid_request", status);
  }
  assertEquals(world.reads.length, 0, "no provider read");
  assertEquals(world.writes.length, 0, "no provider write");
  assertEquals(world.rpcLog.some((c) => c.fn === "youtube_comment_op_claim"), false, "nothing claimed");
});

Deno.test("a provider refusal while verifying a target keeps its classified reason", async () => {
  let refuseWith: { status: number; reason: string } | null = null;
  const world = createWorld({
    provider: (call) => refuseWith && call.path === "comments" && call.method === "GET" && call.query.get("id")
      ? { status: refuseWith.status, body: envelope(refuseWith.reason) }
      : undefined,
  });
  const handle = await firstHandle(world);
  const cases: Array<[number, string, number, string]> = [
    [403, "quotaExceeded", 403, "quota"],
    [404, "commentNotFound", 404, "target_not_verified"],
  ];
  for (const [providerStatus, providerReason, expectedStatus, expectedReason] of cases) {
    refuseWith = { status: providerStatus, reason: providerReason };
    const res = await world.calls("youtube_reply", { target_handle: handle, text: "hi", operation_id: crypto.randomUUID() });
    assertEquals(res.status, expectedStatus, providerReason);
    assertEquals((await jsonOf(res)).reason, expectedReason, providerReason);
  }
  assertEquals(world.writes.length, 0, "nothing was sent");
});

Deno.test("a provider page that is not a list is an upstream error, never an empty page", async () => {
  let malformed: { body: unknown } | null = null;
  const world = createWorld({
    provider: (call) => {
      if (!malformed) return undefined;
      const isList = call.path === "playlistItems"
        || (call.path === "commentThreads" && call.method === "GET")
        || (call.path === "comments" && call.method === "GET" && call.query.get("parentId"));
      return isList ? { status: 200, body: malformed.body } : undefined;
    },
  });
  const handle = await firstHandle(world);
  const pages = [
    ["youtube_video_page", {}],
    ["youtube_thread_page", { video_id: "vid-1", list: "published" }],
    ["youtube_reply_page", { parent_handle: handle }],
  ] as const;
  for (const body of [null, { items: {} }, { items: "x" }, []]) {
    malformed = { body };
    for (const [action, extra] of pages) {
      const res = await world.calls(action, extra);
      assertEquals(res.status, 502, `${action} ${JSON.stringify(body)}`);
      assertEquals((await jsonOf(res)).reason, "upstream", action);
    }
  }
  malformed = { body: {} };
  for (const [action, extra] of pages) {
    const res = await world.calls(action, extra);
    assertEquals(res.status, 200, `a valid empty page is still a success: ${action}`);
    assertEquals((await jsonOf(res)).data.items.length, 0, action);
  }
});

Deno.test("a provider token equal to the one just consumed is refused, not sealed again", async () => {
  const world = createWorld({
    provider: (call) => call.path === "comments" && call.method === "GET" && call.query.get("parentId")
      ? { status: 200, body: { items: [replyFixture("r-1")], nextPageToken: "same-token" } }
      : undefined,
  });
  const handle = await firstHandle(world);
  const page1 = await jsonOf(await world.calls("youtube_reply_page", { parent_handle: handle }));
  assertEquals(typeof page1.data.next_cursor, "string", "a fresh token seals a continuation");
  const page2 = await world.calls("youtube_reply_page", { parent_handle: handle, cursor: page1.data.next_cursor });
  assertEquals(page2.status, 502);
  assertEquals((await jsonOf(page2)).reason, "upstream");
});

Deno.test("a reply without a comment id is dropped as inconsistent", async () => {
  const noId = replyFixture("x") as Record<string, unknown>;
  delete noId.id;
  const world = createWorld({
    provider: (call) => call.path === "comments" && call.method === "GET" && call.query.get("parentId")
      ? { status: 200, body: { items: [replyFixture("r-ok"), noId, { ...replyFixture("y"), id: "" }] } }
      : undefined,
  });
  const handle = await firstHandle(world);
  const page = await jsonOf(await world.calls("youtube_reply_page", { parent_handle: handle }));
  assertEquals(page.data.items.map((i) => i.comment_id), ["r-ok"]);
  assertEquals(page.data.inconsistent_count, 2);
});

Deno.test("an edit whose settlement failed is still observed through its claimed target", async () => {
  let clock = Date.now();
  const world = createWorld({
    now: () => clock,
    failSettleOnce: true,
    provider: ownTopProvider((call) => {
      if (call.path === "comments" && call.method === "GET" && call.query.get("id")) {
        return { status: 200, body: { items: [commentFixture(call.query.get("id")!, { snippet: { authorChannelId: { value: "UC-handler-test" }, textOriginal: "edited text" } })] } };
      }
      if (call.path === "comments" && call.method === "PUT") {
        return { status: 200, body: { id: (call.body as { id?: string }).id, snippet: {} } };
      }
      return undefined;
    }),
  });
  const handle = await firstHandle(world);
  const op = crypto.randomUUID();
  await world.calls("youtube_edit_comment", { target_handle: handle, text: "edited text", operation_id: op });
  assertEquals([...world.receipts.values()][0].state, "dispatched", "the settlement failed");
  clock += 91_000;
  const status = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op, text: "edited text" }));
  assertEquals(status.data.state, "indeterminate");
  assertEquals(status.data.result_comment_id ?? null, null, "no result id was ever recorded");
  assertEquals(status.data.observation, "requested_text_observed", "the claimed target is observed instead");
});

Deno.test("the anonymous suppression tally keeps what was not durably recorded", async () => {
  const anonymous = { action: "youtube_reply", reason: "rate_limited", requestId: "req-tally", userId: null };
  const never = { rateLimitBucket: () => Promise.resolve(false) };
  const unused = {} as unknown as SupabaseClient;
  const seen: number[] = [];
  const failing = { ...never, counterSink: (n: number) => { seen.push(n); return Promise.resolve(false); } };
  await writeRefusalAudit(unused, anonymous, failing);
  await writeRefusalAudit(unused, anonymous, failing);
  assertEquals(seen[1], seen[0] + 1, "a count that was not recorded carries forward to the next attempt");
  const recording = { ...never, counterSink: (n: number) => { seen.push(n); return Promise.resolve(true); } };
  await writeRefusalAudit(unused, anonymous, recording);
  assertEquals(seen[2], seen[1] + 1);
  await writeRefusalAudit(unused, anonymous, recording);
  assertEquals(seen[3], 1, "after a recorded count the tally starts again");
});

Deno.test("a throwing audit insert logs a fixed cause, never the exception text", async () => {
  const warnings: string[] = [];
  const nativeWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    const throwing = {
      from: () => ({ insert: () => Promise.reject(new Error("connection string postgres://secret-host/db")) }),
    } as unknown as SupabaseClient;
    await writeRefusalAudit(throwing, { action: "youtube_reply", reason: "rate_limited", requestId: "req-throw", userId: USER }, {
      rateLimitBucket: () => Promise.resolve(true),
    });
  } finally {
    console.warn = nativeWarn;
  }
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("secret-host"), false, "the exception text is not logged");
  assertEquals(warnings[0].includes("cause=exception"), true);
});

Deno.test("Hold on a published comment is refused before the claim, with no provider write", async () => {
  const world = createWorld();
  const handle = await firstHandle(world);
  world.reads.length = 0;
  world.writes.length = 0;
  world.rpcLog.length = 0;
  const res = await world.calls("youtube_moderate_comment", { target_handle: handle, status: "heldForReview", operation_id: crypto.randomUUID() });
  assertEquals(res.status, 400);
  assertEquals((await jsonOf(res)).reason, "invalid_request");
  assertEquals(world.writes.length, 0, "nothing was sent");
  assertEquals(world.rpcLog.some((c) => c.fn === "youtube_comment_op_claim"), false, "nothing was claimed");
  assertEquals(world.receipts.size, 0, "no receipt");
});

Deno.test("an edit status read after a reconnect returns nothing of the old receipt", async () => {
  const world = createWorld({
    provider: ownTopProvider((call) => {
      if (call.path === "comments" && call.method === "GET" && call.query.get("id")) {
        return { status: 200, body: { items: [commentFixture(call.query.get("id")!, { snippet: { authorChannelId: { value: "UC-handler-test" }, textOriginal: "edited" } })] } };
      }
      if (call.path === "comments" && call.method === "PUT") return { status: 200, body: { id: (call.body as { id?: string }).id, snippet: {} } };
      return undefined;
    }),
  });
  const handle = await firstHandle(world);
  const op = crypto.randomUUID();
  await world.calls("youtube_edit_comment", { target_handle: handle, text: "edited", operation_id: op });
  // The channel is reconnected between the status read and the observation.
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.rpc.bind(fake);
  fake.rpc = async (fn: string, params: Record<string, unknown>) => {
    const out = await original(fn, params);
    if (fn === "youtube_comment_op_status") world.accounts.get(nativeAccount().id)!.binding_generation += 1;
    return out;
  };
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  const body = await res.json();
  assertEquals(res.status, 404);
  assertEquals(body.reason, "not_found");
  assertEquals("data" in body, false, "no field of the old receipt crosses the reconnect");
});

Deno.test("an edit status read whose account re-read fails is a temporary upstream error with no receipt", async () => {
  const world = createWorld({
    provider: ownTopProvider((call) => call.path === "comments" && call.method === "PUT"
      ? { status: 200, body: { id: (call.body as { id?: string }).id, snippet: {} } }
      : (call.path === "comments" && call.method === "GET" && call.query.get("id")
        ? { status: 200, body: { items: [commentFixture(call.query.get("id")!, { snippet: { authorChannelId: { value: "UC-handler-test" }, textOriginal: "edited" } })] } }
        : undefined)),
  });
  const handle = await firstHandle(world);
  const op = crypto.randomUUID();
  await world.calls("youtube_edit_comment", { target_handle: handle, text: "edited", operation_id: op });
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.from.bind(fake);
  let accountReads = 0;
  fake.from = (table: string) => {
    if (table === "social_accounts" && ++accountReads >= 2) throw new Error("database unavailable");
    return original(table);
  };
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  const body = await res.json();
  assertEquals(res.status, 503);
  assertEquals(body.reason, "upstream");
  assertEquals("data" in body, false);
});

Deno.test("an unreadable rollout on a gated action is upstream too, and nothing is sent", async () => {
  const world = createWorld({ admitsError: true });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["youtube_video_page", {}],
    ["youtube_thread_page", { video_id: "vid-1", list: "published" }],
    ["youtube_thread_page", { video_id: "vid-1", list: "heldForReview" }],
    ["youtube_create_thread", { video_id: "vid-1", text: "x", operation_id: crypto.randomUUID() }],
  ];
  for (const [action, extra] of cases) {
    const res = await world.calls(action, extra);
    assertEquals(res.status, 503, action);
    assertEquals((await jsonOf(res)).reason, "upstream", action);
  }
  assertEquals(world.writes.length + world.reads.length, 0, "no provider traffic");
  assertEquals(world.receipts.size, 0);
});

Deno.test("Hold through a stale handle issued while the comment was held is refused before the claim", async () => {
  // comments.list?id= carries no moderation status, so the handler cannot see
  // that the comment was published since; the handle still says held.
  const world = createWorld();
  const staleHandle = await sealHandle(
    { o: USER, a: nativeAccount().id, g: 1, c: "UC-handler-test", vi: "vid-1", th: "thread-9", co: "comment-7", k: "thread", p: "", au: "UC-author-1", s: "heldForReview" },
    { signingSecret: TEST_SIGNER, now: Date.now(), ttlMs: HANDLE_TTL_MS },
  );
  const res = await world.calls("youtube_moderate_comment", { target_handle: staleHandle, status: "heldForReview", operation_id: crypto.randomUUID() });
  assertEquals(res.status, 400);
  assertEquals((await jsonOf(res)).reason, "invalid_request");
  assertEquals(world.writes.length, 0, "nothing was sent");
  assertEquals(world.reads.length, 0, "refused before any provider read");
  assertEquals(world.rpcLog.some((c) => c.fn === "youtube_comment_op_claim"), false, "nothing was claimed");
  assertEquals(world.receipts.size, 0);
});

/** A world with one edit that settled normally; `op` is its operation id. */
async function editedWorld() {
  const world = createWorld({
    provider: ownTopProvider((call) => {
      if (call.path === "comments" && call.method === "GET" && call.query.get("id")) {
        return { status: 200, body: { items: [commentFixture(call.query.get("id")!, { snippet: { authorChannelId: { value: "UC-handler-test" }, textOriginal: "edited" } })] } };
      }
      if (call.path === "comments" && call.method === "PUT") return { status: 200, body: { id: (call.body as { id?: string }).id, snippet: {} } };
      return undefined;
    }),
  });
  const handle = await firstHandle(world);
  const op = crypto.randomUUID();
  await world.calls("youtube_edit_comment", { target_handle: handle, text: "edited", operation_id: op });
  world.reads.length = 0;
  return { world, op };
}

/** Runs `change` right after the next call of the RPC `fn` returns. */
function afterRpc(world: World, fn: string, change: () => void) {
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.rpc.bind(fake);
  fake.rpc = async (name: string, params: Record<string, unknown>) => {
    const out = await original(name, params);
    if (name === fn) change();
    return out;
  };
}

/** Runs `change` right after a provider read of a single comment returns. */
function afterCommentRead(world: World, change: () => void) {
  const baseFetcher = world.deps.fetcher;
  world.deps.fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const out = await baseFetcher(url, init);
    const full = new URL(String(url));
    if (full.pathname.endsWith("/comments") && (init?.method ?? "GET") === "GET" && full.searchParams.get("id")) change();
    return out;
  }) as typeof fetch;
}

function reconnect(world: World) {
  world.accounts.get(nativeAccount().id)!.binding_generation += 1;
}

Deno.test("an edit status read after a reconnect returns nothing when the read capability answers false", async () => {
  const { world, op } = await editedWorld();
  // The channel is reconnected right after the receipt was read, and the read capability then answers
  // false: the observation is skipped, but the old receipt must still not be returned.
  afterRpc(world, "youtube_comment_op_status", () => {
    reconnect(world);
    world.setPolicy({ [nativeAccount().id]: { read: false, held: false, write: false, ban: false } });
  });
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  const body = await res.json();
  assertEquals(res.status, 404);
  assertEquals(body.reason, "not_found");
  assertEquals("data" in body, false, "no field of the old receipt crosses the reconnect");
});

Deno.test("an edit status read discards the receipt when the channel is reconnected before the credential is prepared", async () => {
  const { world, op } = await editedWorld();
  // The reconnect lands between the capability answer and the credential step.
  afterRpc(world, "youtube_comments_stage4_admits", () => reconnect(world));
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  assertEquals(res.status, 404);
  assertEquals("data" in (await res.json()), false);
  assertEquals(world.reads.length, 0, "the provider was never read with the superseded binding's credential");
});

Deno.test("an edit status read discards the receipt when the channel is reconnected during the provider read", async () => {
  const { world, op } = await editedWorld();
  afterCommentRead(world, () => reconnect(world));
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  const body = await res.json();
  assertEquals(world.reads.length >= 1, true, "the provider was read");
  assertEquals(res.status, 404);
  assertEquals("data" in body, false, "nothing the superseded read observed is returned");
});

Deno.test("an edit observation reports only the comment the receipt targets", async () => {
  const { world, op } = await editedWorld();
  // The provider answers with a DIFFERENT comment that happens to carry the requested text.
  const baseFetcher = world.deps.fetcher;
  world.deps.fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const full = new URL(String(url));
    if (full.pathname.endsWith("/comments") && (init?.method ?? "GET") === "GET" && full.searchParams.get("id")) {
      return new Response(
        JSON.stringify({ items: [commentFixture("some-other-comment", { snippet: { authorChannelId: { value: "UC-handler-test" }, textOriginal: "edited" } })] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return baseFetcher(url, init);
  }) as typeof fetch;
  const status = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op, text: "edited" }));
  assertEquals(status.data.observation, "unavailable", "an answer for another id is not an observation");
  assertEquals((status.data as { observed_text?: unknown }).observed_text ?? null, null);
});

// ---- fix round: the anonymous gate, the status path, Hold ordering -------------------------------------

/** Replaces check_rate_limit with one the test answers; returns the log of its calls. */
function deferredLimiter(world: World) {
  const calls: string[] = [];
  const pending: Array<(allowed: boolean) => void> = [];
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.rpc.bind(fake);
  fake.rpc = (fn: string, params: Record<string, unknown>) => {
    if (fn !== "check_rate_limit") return original(fn, params);
    calls.push(String(params.p_endpoint));
    return new Promise((resolve) => {
      pending.push((allowed) => resolve({ data: { allowed, remaining: 0, retry_after: 30 }, error: null }));
    });
  };
  return { calls, answerAll: (allowed: boolean) => { while (pending.length) pending.shift()!(allowed); } };
}

const anonymous = (world: World) =>
  handleStage4({ deps: world.deps, corsHeaders: {}, userId: "", isServiceRole: false, body: undefined });

Deno.test("concurrent anonymous refusals put at most one call on the shared bucket", async () => {
  const world = createWorld();
  const limiter = deferredLimiter(world);
  const burst = Array.from({ length: 25 }, () => anonymous(world));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(limiter.calls.length, 1, "one probe in flight, however many requests are waiting");
  limiter.answerAll(true);
  const answers = await Promise.all(burst);
  for (const res of answers) assertEquals(res.status, 401, "every request still gets the same refusal");
  assertEquals(limiter.calls.length, 1, "the others were refused without a call of their own");
});

Deno.test("after the shared bucket refuses, calls over time stay at one probe per closed window", async () => {
  let clock = 1_000_000;
  const world = createWorld({ now: () => clock, rateLimited: false });
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.rpc.bind(fake);
  let limiterCalls = 0;
  fake.rpc = (fn: string, params: Record<string, unknown>) => {
    if (fn !== "check_rate_limit") return original(fn, params);
    limiterCalls += 1;
    return Promise.resolve({ data: { allowed: false, remaining: 0, retry_after: 30 }, error: null });
  };
  // A request every 100 ms for one minute of clock time.
  for (let step = 0; step < 600; step += 1) {
    clock += 100;
    const res = await anonymous(world);
    assertEquals(res.status, 401);
  }
  // 60 s / 10 s closed window = 6 probes (+1 for the first), plus one counter call for the minute.
  assertEquals(limiterCalls <= 8, true, `limiter calls over one minute: ${limiterCalls}`);
});

Deno.test("a probe that never answers answers the request within the bound and closes the gate", async () => {
  const world = createWorld();
  const limiter = deferredLimiter(world);
  const started = Date.now();
  const first = await anonymous(world);
  assertEquals(first.status, 401);
  assertEquals(Date.now() - started < 6000, true, "bounded by the probe and counter timeouts, not by the limiter");
  const probes = () => limiter.calls.filter((endpoint) => endpoint.includes("stage4_audit_anon")).length;
  assertEquals(probes(), 1);
  // The gate is closed for a while after the timeout: no new probe from the next requests.
  await anonymous(world);
  await anonymous(world);
  assertEquals(probes(), 1, "a timed-out probe closes the gate instead of letting every request retry");
  limiter.answerAll(false);
});

// ---- T1: the slot belongs to the call, the cool-down to a monotonic clock ----------------------------

/** Replaces check_rate_limit: each bucket answers true, false, or hangs until it is released. */
function scriptedLimiter(world: World, plan: (endpoint: string) => boolean | "hang") {
  const calls: string[] = [];
  const hung: Array<(allowed: boolean) => void> = [];
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.rpc.bind(fake);
  fake.rpc = (fn: string, params: Record<string, unknown>) => {
    if (fn !== "check_rate_limit") return original(fn, params);
    const endpoint = String(params.p_endpoint);
    calls.push(endpoint);
    const decision = plan(endpoint);
    if (decision === "hang") {
      return new Promise((resolve) => {
        hung.push((allowed) => resolve({ data: { allowed, remaining: 0, retry_after: 30 }, error: null }));
      });
    }
    return Promise.resolve({ data: { allowed: decision, remaining: 0, retry_after: 30 }, error: null });
  };
  return {
    count: (needle: string) => calls.filter((endpoint) => endpoint.includes(needle)).length,
    releaseAll: (allowed: boolean) => {
      while (hung.length) hung.shift()!(allowed);
    },
    releaseOldest: (allowed: boolean) => hung.shift()?.(allowed),
  };
}

/** Every system_logs insert hangs until it is released; counts the inserts that were started. */
function hangingAuditInserts(world: World) {
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.from.bind(fake);
  let started = 0;
  const hung: Array<() => void> = [];
  fake.from = (table: string) => {
    if (table !== "system_logs") return original(table);
    return {
      insert: () => {
        started += 1;
        return new Promise((resolve) => hung.push(() => resolve({ error: null })));
      },
    };
  };
  return {
    started: () => started,
    releaseAll: () => {
      while (hung.length) hung.shift()!();
    },
  };
}

/** Lets the settle handlers of released promises run before the next request. */
const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 15));
const BOUND_MS = 6000;

Deno.test("T1.1 a hung probe keeps its slot: after the cool-down no second call starts until it settles", async () => {
  let mono = 1_000;
  // One clock drives both, so the gate follows it on the old and the new code alike.
  const world = createWorld({ now: () => mono });
  const limiter = scriptedLimiter(world, () => "hang");
  const started = performance.now();
  assertEquals((await anonymous(world)).status, 401);
  assertEquals(performance.now() - started < BOUND_MS, true, "the first refusal answers within the bound");
  assertEquals(limiter.count("stage4_audit_anon"), 1);

  mono += 11_000; // the 10 s cool-down has passed on the monotonic clock
  assertEquals((await anonymous(world)).status, 401);
  assertEquals(limiter.count("stage4_audit_anon"), 1, "the hung call still holds the slot: no second limiter call");

  limiter.releaseAll(false);
  await settleMicrotasks();
  mono += 11_000;
  await anonymous(world);
  assertEquals(limiter.count("stage4_audit_anon"), 2, "once the hung call settled the next refusal probes again");
  limiter.releaseAll(false);
});

Deno.test("T1.1b a stale call that settles after a reset cannot free the slot of a newer call", async () => {
  let mono = 1_000;
  const world = createWorld({ now: () => mono });
  const limiter = scriptedLimiter(world, (endpoint) => (endpoint.includes("stage4_audit_anon") ? "hang" : false));
  await anonymous(world); // probe #1 hangs and is cut off at the bound
  resetAnonRefusalGate(); // a fresh worker: the new probe is call #2
  await anonymous(world);
  assertEquals(limiter.count("stage4_audit_anon"), 2);

  limiter.releaseOldest(false); // call #1 finally settles: it must free ITS hold only
  await settleMicrotasks();
  mono += 11_000;
  await anonymous(world);
  assertEquals(limiter.count("stage4_audit_anon"), 2, "call #2 still holds the slot");
  limiter.releaseAll(false);
});

Deno.test("T1.2a a hung counter probe keeps its slot until it settles", async () => {
  let mono = 1_000;
  // One clock drives both, so the gate follows it on the old and the new code alike.
  const world = createWorld({ now: () => mono });
  const limiter = scriptedLimiter(world, (endpoint) => (endpoint.includes("stage4_audit_counter") ? "hang" : false));
  const started = performance.now();
  assertEquals((await anonymous(world)).status, 401);
  assertEquals(performance.now() - started < BOUND_MS, true);
  assertEquals(limiter.count("stage4_audit_counter"), 1);

  mono += 61_000; // both the closed window and the counter interval have passed
  assertEquals((await anonymous(world)).status, 401);
  assertEquals(limiter.count("stage4_audit_counter"), 1, "no second counter probe while the first is unsettled");

  limiter.releaseAll(false);
  await settleMicrotasks();
  mono += 61_000;
  await anonymous(world);
  assertEquals(limiter.count("stage4_audit_counter"), 2, "the slot is free again once the call settled");
});

Deno.test("T1.2b a hung counter insert keeps its slot: no second insert starts", async () => {
  let mono = 1_000;
  // One clock drives both, so the gate follows it on the old and the new code alike.
  const world = createWorld({ now: () => mono });
  scriptedLimiter(world, (endpoint) => endpoint.includes("stage4_audit_counter"));
  const inserts = hangingAuditInserts(world);
  const started = performance.now();
  assertEquals((await anonymous(world)).status, 401);
  assertEquals(performance.now() - started < BOUND_MS, true, "the request does not wait for the insert");
  assertEquals(inserts.started(), 1);

  mono += 61_000;
  assertEquals((await anonymous(world)).status, 401);
  assertEquals(inserts.started(), 1, "never a second counter insert while the first is unsettled");

  inserts.releaseAll();
  await settleMicrotasks();
  mono += 61_000;
  await anonymous(world);
  assertEquals(inserts.started(), 2, "the slot is free again once the insert settled");
  inserts.releaseAll();
});

Deno.test("T1.2c a hung admitted anonymous audit insert is bounded and never doubled", async () => {
  const world = createWorld();
  scriptedLimiter(world, () => true);
  const inserts = hangingAuditInserts(world);
  const started = performance.now();
  assertEquals((await anonymous(world)).status, 401);
  assertEquals(performance.now() - started < BOUND_MS, true, "the request does not wait for the insert");
  assertEquals(inserts.started(), 1);

  assertEquals((await anonymous(world)).status, 401);
  assertEquals(inserts.started(), 1, "a request that finds the slot taken skips its insert and counts as suppressed");

  inserts.releaseAll();
  await settleMicrotasks();
  await anonymous(world);
  assertEquals(inserts.started(), 2, "the slot is free again once the insert settled");
  inserts.releaseAll();
});

Deno.test("T1.3 the cool-down follows the monotonic clock, not the wall clock", async () => {
  let wall = 5_000_000_000;
  let mono = 1_000;
  const world = createWorld({ now: () => wall, monotonicNow: () => mono });
  const limiter = scriptedLimiter(world, () => false);
  await anonymous(world);
  assertEquals(limiter.count("stage4_audit_anon"), 1);

  // The wall clock steps back an hour while the monotonic clock passes the cool-down: the gate reopens.
  wall -= 3_600_000;
  mono += 10_001;
  await anonymous(world);
  assertEquals(limiter.count("stage4_audit_anon"), 2, "a backwards wall step must not keep the gate closed");

  // The wall clock steps forward an hour, the monotonic clock only a second: the gate stays closed.
  wall += 7_200_000;
  mono += 1_000;
  await anonymous(world);
  assertEquals(limiter.count("stage4_audit_anon"), 2, "a forwards wall step must not reopen the gate early");
});

Deno.test("T1.4 expiry of a handle still follows the wall clock", async () => {
  let wall = Date.now();
  const world = createWorld({ now: () => wall, monotonicNow: () => 1_000 });
  const handle = await firstHandle(world);
  wall += 2 * HANDLE_TTL_MS;
  const res = await world.calls("youtube_reply", { target_handle: handle, text: "x", operation_id: crypto.randomUUID() });
  assertEquals((await jsonOf(res)).reason, "expired_handle");
});

Deno.test("Hold is refused straight after validation, before the limiter, the account read and the capability gate", async () => {
  // The account is NOT admitted for writes: the old order answered 403 capability_off first.
  const world = createWorld({ policy: { [nativeAccount().id]: { read: true, held: false, write: false } } });
  const handle = await firstHandle(world);
  world.rpcLog.length = 0;
  const res = await world.calls("youtube_moderate_comment", { target_handle: handle, status: "heldForReview", operation_id: crypto.randomUUID() });
  assertEquals(res.status, 400);
  assertEquals((await jsonOf(res)).reason, "invalid_request");
  assertEquals(world.rpcLog.length, 0, "no limiter call, no capability read, nothing");
});

Deno.test("an edit status read where the read capability answers false because of a reconnect returns no receipt", async () => {
  const { world, op } = await editedWorld();
  // The change lands while the capability is being checked, and the answer turns false BECAUSE of it.
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.rpc.bind(fake);
  fake.rpc = async (name: string, params: Record<string, unknown>) => {
    if (name === "youtube_comments_stage4_admits") {
      reconnect(world);
      world.setPolicy({ [nativeAccount().id]: { read: false, held: false, write: false, ban: false } });
    }
    return original(name, params);
  };
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  const body = await res.json();
  assertEquals(res.status, 404);
  assertEquals("data" in body, false, "no field of the old receipt crosses the reconnect");
});

Deno.test("an edit status read where the credential preparation FAILS during a reconnect returns no receipt", async () => {
  const { world, op } = await editedWorld();
  const account = world.accounts.get(nativeAccount().id)!;
  // A credential that cannot be prepared: expired, with nothing to refresh it.
  account.token_expires_at = new Date(Date.now() - 1000).toISOString();
  account.refresh_token = null;
  afterRpc(world, "youtube_comments_stage4_admits", () => reconnect(world));
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  assertEquals(res.status, 404);
  assertEquals("data" in (await res.json()), false);
  assertEquals(world.reads.length, 0);
});

Deno.test("an edit status read stops before the provider when the read capability is withdrawn during preparation", async () => {
  const { world, op } = await editedWorld();
  let admitsCalls = 0;
  afterRpc(world, "youtube_comments_stage4_admits", () => {
    admitsCalls += 1;
    // The first answer (before the credential step) said yes; it is withdrawn right after.
    if (admitsCalls === 1) world.setPolicy({ [nativeAccount().id]: { read: false, held: false, write: false, ban: false } });
  });
  const status = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op, text: "edited" }));
  assertEquals(world.reads.length, 0, "no provider read after the withdrawal");
  assertEquals(status.data.observation, "unavailable");
  assertEquals(status.data.state, "confirmed", "the receipt itself is still returned under the unchanged binding");
});

Deno.test("an edit status read with no draft returns the receipt at once: no settings read, no provider read", async () => {
  const { world, op } = await editedWorld();
  world.rpcLog.length = 0;
  const status = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op }));
  assertEquals(status.data.observation, "unavailable");
  assertEquals(world.reads.length, 0, "no provider read");
  assertEquals(
    world.rpcLog.filter((c) => c.fn.startsWith("youtube_comments_stage4")).length,
    0,
    "no rollout settings read either",
  );
});

// ---- T4: the edit-status observation (B2, M4, M5) --------------------------------------------------------

/** Runs `change(n)` on the n-th (1-based) account read the handler makes from now on, before the row is returned. */
function onAccountRead(world: World, change: (n: number) => void) {
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.from.bind(fake);
  let n = 0;
  fake.from = (table: string) => {
    const builder = original(table) as { maybeSingle?: () => Promise<unknown> };
    if (table !== "social_accounts" || typeof builder.maybeSingle !== "function") return builder;
    const inner = builder.maybeSingle.bind(builder);
    builder.maybeSingle = () => {
      n += 1;
      change(n);
      return inner();
    };
    return builder;
  };
}

/** The n-th (1-based) account read from now on fails like a database error. */
function failAccountReadAt(world: World, failing: number) {
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.from.bind(fake);
  let n = 0;
  fake.from = (table: string) => {
    const builder = original(table) as { maybeSingle?: () => Promise<unknown> };
    if (table !== "social_accounts" || typeof builder.maybeSingle !== "function") return builder;
    const inner = builder.maybeSingle.bind(builder);
    builder.maybeSingle = () => {
      n += 1;
      return n === failing ? Promise.resolve({ data: null, error: { message: "database unavailable" } }) : inner();
    };
    return builder;
  };
}

/** The n-th (1-based) call of the RPC `fn` from now on answers with a database error. */
function failRpcAt(world: World, fn: string, failing: number) {
  const fake = world.deps.admin as unknown as FakeAdmin;
  const original = fake.rpc.bind(fake);
  let n = 0;
  fake.rpc = (name: string, params: Record<string, unknown>) => {
    if (name === fn) {
      n += 1;
      if (n === failing) return Promise.resolve({ data: null, error: { message: "unreadable" } });
    }
    return original(name, params);
  };
}

const withdrawRead = (world: World) =>
  world.setPolicy({ [nativeAccount().id]: { read: false, held: false, write: false, ban: false } });

Deno.test("T4.1 read withdrawn during the binding read right before the provider read: no provider read at all", async () => {
  const { world, op } = await editedWorld();
  // From the third account read on (the last one before the provider request in the old order),
  // the capability is withdrawn. The capability must be asked AFTER that read, not before it.
  onAccountRead(world, (n) => { if (n >= 3) withdrawRead(world); });
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  assertEquals(res.status, 200);
  const status = await jsonOf(res);
  assertEquals(world.reads.length, 0, "no provider read after the withdrawal");
  assertEquals(status.data.observation, "unavailable");
  assertEquals(status.data.state, "confirmed", "the receipt itself still goes out under the unchanged binding");
});

Deno.test("T4.1b read withdrawn exactly at the send boundary: no provider read", async () => {
  const { world, op } = await editedWorld();
  // Account reads of one status call: the handler's own (1), the first binding check (2), the fresh
  // read before the credential (3), the boundary read (4). The provider read must not follow a
  // withdrawal that lands during the boundary read.
  onAccountRead(world, (n) => { if (n === 4) withdrawRead(world); });
  const status = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op, text: "edited" }));
  assertEquals(world.reads.length, 0);
  assertEquals(status.data.observation, "unavailable");
});

Deno.test("T4.2 read withdrawn during the provider read: the text that was read is dropped", async () => {
  const { world, op } = await editedWorld();
  afterCommentRead(world, () => withdrawRead(world));
  const status = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op, text: "edited" }));
  assertEquals(world.reads.length, 1, "the provider was read once, before the withdrawal");
  assertEquals(status.data.observation, "unavailable");
  assertEquals((status.data as { observed_text?: unknown }).observed_text ?? null, null, "no observed text crosses the withdrawal");
});

Deno.test("T4.3a a settings read error at the first capability check is not a 503: the receipt goes out unobserved", async () => {
  const { world, op } = await editedWorld();
  failRpcAt(world, "youtube_comments_stage4_admits", 1);
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  assertEquals(res.status, 200);
  const status = await jsonOf(res);
  assertEquals(status.data.state, "confirmed");
  assertEquals(status.data.observation, "unavailable");
  assertEquals(world.reads.length, 0, "no provider read");
});

Deno.test("T4.3b a settings read error at the send boundary is not a 503 either", async () => {
  const { world, op } = await editedWorld();
  failRpcAt(world, "youtube_comments_stage4_admits", 2);
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  assertEquals(res.status, 200);
  const status = await jsonOf(res);
  assertEquals(status.data.state, "confirmed");
  assertEquals(status.data.observation, "unavailable");
  assertEquals(world.reads.length, 0, "no provider read");
});

Deno.test("T4.3c a failed BINDING read at those points is still a 503", async () => {
  for (const failing of [2, 3, 4]) {
    const { world, op } = await editedWorld();
    failAccountReadAt(world, failing);
    const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
    assertEquals(res.status, 503, `the account read number ${failing} failing is a temporary refusal`);
    assertEquals((await jsonOf(res)).reason, "upstream");
  }
});

Deno.test("T4.4 a reconnect landing during the first capability check: no credential is prepared from the old row", async () => {
  const { world, op } = await editedWorld();
  // The stored credential is expired, so preparing it would start a refresh (a lease RPC) with
  // the row the handler read BEFORE the reconnect.
  const account = world.accounts.get(nativeAccount().id)!;
  account.token_expires_at = new Date(Date.now() - 1000).toISOString();
  afterRpc(world, "youtube_comments_stage4_admits", () => reconnect(world));
  world.rpcLog.length = 0;
  const res = await world.calls("youtube_operation_status", { operation_id: op, text: "edited" });
  assertEquals(res.status, 404);
  assertEquals("data" in (await res.json()), false, "no field of the old receipt crosses the reconnect");
  assertEquals(
    world.rpcLog.filter((c) => c.fn.includes("refresh") || c.fn.includes("lease")).length,
    0,
    "no refresh was started from the superseded snapshot",
  );
  assertEquals(world.reads.length, 0);
});

Deno.test("T4.5 the unchanged paths: a matching and a differing draft give the two observed values", async () => {
  const { world, op } = await editedWorld();
  const same = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op, text: "edited" }));
  assertEquals(same.data.observation, "requested_text_observed");
  assertEquals((same.data as { observed_text?: unknown }).observed_text, "edited");
  const other = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op, text: "something else" }));
  assertEquals(other.data.observation, "different_text_observed");
  assertEquals(world.reads.length, 2, "one provider read per observation");
});
