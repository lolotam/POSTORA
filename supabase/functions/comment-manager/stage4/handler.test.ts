// Stage 4 handler tests, through the real routing shape.
//
// The database is a fake port that mirrors the SQL state machine of the
// migration (claim / mark / settle / status with the per-key and logical
// fences); the provider is a counting fake. Every case asserts the visible
// answer, the number of ACTUAL provider write requests, and what the fake
// receipt store recorded. No test touches Google, Supabase or a real token.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { handleStage4, type Stage4Deps } from "./handler.ts";
import { STAGE4_ACTIONS } from "./contracts.ts";
import { sealCursor, sealHandle, HANDLE_TTL_MS } from "./sealing.ts";

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
    if (options.admitsError) {
      for (const cap of ["read", "held", "write", "ban"]) reasons[cap] = "settings_unavailable";
      return reasons;
    }
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

Deno.test("hold, publish and reject address the selected comment only; plain reject sends no banAuthor", async () => {
  const world = createWorld();
  const handle = await firstHandle(world);
  for (const status of ["heldForReview", "published", "rejected"] as const) {
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
  assertEquals(res.status, 403);

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

Deno.test("an unreadable rollout fails closed without looking like off", async () => {
  const world = createWorld({ admitsError: true });
  const res = await world.calls("youtube_stage4_capabilities");
  const body = await jsonOf(res);
  assertEquals(body.data.capabilities.read.reason, "settings_unavailable");
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
    provider: (call) => {
      if (call.path === "commentThreads" && call.method === "POST") throw new Error("response lost before settlement");
      return undefined;
    },
  });
  const op = crypto.randomUUID();
  const body = await jsonOf(await world.calls("youtube_create_thread", { video_id: "vid-1", text: "lost", operation_id: op }));
  assertEquals(body.data.state, "indeterminate");

  clock += 91_000;
  const status = await jsonOf(await world.calls("youtube_operation_status", { operation_id: op }));
  assertEquals(status.data.state, "indeterminate");
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
  await world.calls("youtube_stage4_capabilities", { social_account_id: "77777777-7777-4777-8777-777777777777" });
  assertEquals(world.auditRows.length, 1, "no timer was needed: the audit write was awaited");
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
});
