import {
  AI_CONNECTION_REQUIRED,
  AI_PROVIDER_UNREACHABLE,
  AI_USER_KEY_INVALID,
  RATE_LIMITED,
  STORE_FAILED,
} from "./errors.ts";
import {
  isProvider,
  type Provider,
  PROVIDERS,
  validateKey,
} from "./validation.ts";

type Row = Record<string, unknown>;
export interface DbResult {
  data: unknown;
  error: unknown;
}
export interface Query extends PromiseLike<DbResult> {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  in(column: string, values: readonly string[]): Query;
  contains(column: string, values: readonly string[]): Query;
  upsert(
    values: Row,
    options: { onConflict: string; ignoreDuplicates?: boolean },
  ): Query;
  update(values: Row): Query;
  delete(): Query;
  maybeSingle(): PromiseLike<DbResult>;
}
export interface AdminClient {
  from(table: string): Query;
  rpc(name: string, params: Row): PromiseLike<DbResult>;
}
export interface Dependencies {
  anonClient(authorization: string): {
    auth: {
      getUser(): PromiseLike<
        { data: { user: { id: string } | null }; error: unknown }
      >;
    };
  };
  admin: AdminClient;
  serviceRoleKey: string;
  fetch: typeof fetch;
  now(): number;
  rateLimit: ReturnType<typeof createRateLimiter>;
  log(
    event: {
      user_id: string | null;
      action: string;
      provider_code: string | null;
      outcome: string;
    },
  ): void;
}
export interface Result {
  status: number;
  body: { ok: boolean; code?: string; message?: string; data?: unknown };
}
const SAFE_COLUMNS =
  "id, provider_code, key_hint, status, last_verified_at, updated_at";
const ACTIONS = [
  "list",
  "list_models",
  "save_key",
  "test_key",
  "delete_key",
  "join_waitlist",
];
const success = (data?: unknown): Result => ({
  status: 200,
  body: { ok: true, ...(data === undefined ? {} : { data }) },
});
const failure = (status: number, code: string): Result => ({
  status,
  body: { ok: false, code },
});
function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(STORE_FAILED);
  }
  return value as Row;
}
function safeKey(row: Row): Row {
  return {
    provider_code: row.provider_code,
    key_hint: row.key_hint,
    status: row.status,
    last_verified_at: row.last_verified_at,
  };
}

/** Best-effort per isolate, per user + action; not a distributed quota. */
export function createRateLimiter() {
  const attempts = new Map<string, number[]>();
  const windowMs = 10 * 60_000;
  return (userId: string, action: string, now: number): boolean => {
    for (const [key, times] of attempts) {
      if (times[times.length - 1] <= now - windowMs) attempts.delete(key);
    }
    const key = `${userId}:${action}`;
    const times = (attempts.get(key) ?? []).filter((time) =>
      time > now - windowMs
    );
    if (times.length >= 10) return false;
    attempts.set(key, [...times, now]);
    return true;
  };
}

async function readKey(
  admin: AdminClient,
  userId: string,
  provider: Provider,
): Promise<Row | null> {
  const { data, error } = await admin.from("user_ai_provider_keys")
    .select(SAFE_COLUMNS).eq("user_id", userId)
    .eq("provider_code", provider).maybeSingle();
  if (error) throw new Error(STORE_FAILED);
  return data === null ? null : record(data);
}
// The Vault write and the row upsert happen inside one SECURITY DEFINER
// function under a per-(user, provider) advisory transaction lock, so a
// failure anywhere rolls both back and overlapping replacements cannot
// interleave. RETURNS TABLE is an array in PostgREST, even for one row.
async function saveKey(
  deps: Dependencies,
  userId: string,
  provider: Provider,
  key: string,
): Promise<Result> {
  const validation = await validateKey(provider, key, deps.fetch);
  if (validation !== "valid") {
    return failure(
      validation === "invalid" ? 400 : 503,
      validation === "invalid" ? AI_USER_KEY_INVALID : AI_PROVIDER_UNREACHABLE,
    );
  }
  const { data, error } = await deps.admin.rpc("save_user_ai_provider_key", {
    p_user_id: userId,
    p_provider_code: provider,
    p_api_key: key,
    p_key_hint: key.slice(-4),
    p_verified_at: new Date(deps.now()).toISOString(),
  });
  if (error) throw new Error(STORE_FAILED);
  const saved = record(Array.isArray(data) ? data[0] : data);
  if (saved.provider_code !== provider) throw new Error(STORE_FAILED);
  return success(safeKey(saved));
}

// Model catalog for the routing picker. ai_providers is admin-only under RLS,
// so a browser join through it returns an empty list for regular users; the
// service role reads it here and returns only catalog columns. Only models
// that declare the chat capability are offered: every routed execution posts
// to a chat-completions endpoint, so an image or TTS row would fail on use.
async function listModels(deps: Dependencies): Promise<Result> {
  const { data, error } = await deps.admin.from("ai_models")
    .select("id, model_id, name, ai_providers!inner(provider_code)")
    .eq("is_active", true)
    .contains("capabilities", ["chat"])
    .in("ai_providers.provider_code", PROVIDERS);
  if (error || !Array.isArray(data)) throw new Error(STORE_FAILED);
  return success({
    models: data.map((value) => {
      const row = record(value);
      return {
        id: row.id,
        model_id: row.model_id,
        name: row.name,
        provider_code: record(row.ai_providers).provider_code,
      };
    }),
  });
}

async function listKeys(deps: Dependencies, userId: string): Promise<Result> {
  const { data, error } = await deps.admin.from("user_ai_provider_keys")
    .select(SAFE_COLUMNS).eq("user_id", userId);
  if (error || !Array.isArray(data)) throw new Error(STORE_FAILED);
  return success({
    keys: data.map((value) => {
      const row = record(value);
      return { id: row.id, ...safeKey(row), updated_at: row.updated_at };
    }),
  });
}

async function joinWaitlist(
  deps: Dependencies,
  userId: string,
): Promise<Result> {
  const { error } = await deps.admin.from("ai_provider_waitlist")
    .upsert({ user_id: userId, provider_code: "codex" }, {
      onConflict: "user_id,provider_code",
      ignoreDuplicates: true,
    });
  if (error) throw new Error(STORE_FAILED);
  return success({ joined: true });
}

async function testKey(
  deps: Dependencies,
  userId: string,
  provider: Provider,
): Promise<Result> {
  const { data, error } = await deps.admin.rpc("get_user_ai_provider_key", {
    p_user_id: userId,
    p_provider_code: provider,
    p_include_invalid: true,
  });
  if (error) throw new Error(STORE_FAILED);
  if (data === null) return failure(404, AI_CONNECTION_REQUIRED);
  if (typeof data !== "string" || !data) throw new Error(STORE_FAILED);
  const validation = await validateKey(provider, data, deps.fetch);
  if (validation === "transient") return failure(503, AI_PROVIDER_UNREACHABLE);
  const values = validation === "valid"
    ? {
      status: "active",
      last_verified_at: new Date(deps.now()).toISOString(),
      last_error_code: null,
    }
    : { status: "invalid", last_error_code: AI_USER_KEY_INVALID };
  const { error: updateError } = await deps.admin.from("user_ai_provider_keys")
    .update(values)
    .eq("user_id", userId).eq("provider_code", provider);
  if (updateError) throw new Error(STORE_FAILED);
  return validation === "valid"
    ? success({ provider_code: provider, ...values })
    : failure(400, AI_USER_KEY_INVALID);
}

async function deleteKey(
  deps: Dependencies,
  userId: string,
  provider: Provider,
): Promise<Result> {
  const existing = await readKey(deps.admin, userId, provider);
  if (!existing) return failure(404, AI_CONNECTION_REQUIRED);
  // Only the row is deleted here. The AFTER DELETE trigger installed by the
  // migration reclaims the Vault secret inside the same transaction, so a
  // failed row delete never leaves a connected-looking row without a key.
  const { error } = await deps.admin.from("user_ai_provider_keys").delete()
    .eq("user_id", userId).eq("provider_code", provider);
  if (error) throw new Error(STORE_FAILED);
  return success();
}

async function dispatch(
  deps: Dependencies,
  userId: string,
  action: string,
  body: Row,
): Promise<Result> {
  if (action === "list") return await listKeys(deps, userId);
  if (action === "list_models") return await listModels(deps);
  if (action === "join_waitlist") {
    if (body.provider_code !== "codex") return failure(400, "INVALID_REQUEST");
    return await joinWaitlist(deps, userId);
  }
  if (!isProvider(body.provider_code)) return failure(400, "INVALID_REQUEST");
  const provider = body.provider_code;
  if (action === "save_key" || action === "test_key") {
    if (!deps.rateLimit(userId, action, deps.now())) {
      return failure(429, RATE_LIMITED);
    }
  }
  if (action === "save_key") {
    const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (!key || key.length > 512) return failure(400, "INVALID_REQUEST");
    return await saveKey(deps, userId, provider, key);
  }
  if (action === "test_key") return await testKey(deps, userId, provider);
  if (action === "delete_key") return await deleteKey(deps, userId, provider);
  return failure(400, "INVALID_REQUEST");
}

/** Body parser is lazy: no JSON is read until the anon client verifies the JWT. */
export async function handleRequest(
  req: Request,
  deps: Dependencies,
  parseBody: () => Promise<unknown> = () => req.json(),
): Promise<Result> {
  let userId: string | null = null;
  let action = "unknown";
  let provider: string | null = null;
  let result = failure(500, STORE_FAILED);
  try {
    const authorization = req.headers.get("Authorization") ?? "";
    const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!token) return result = failure(401, "UNAUTHORIZED");
    if (token === deps.serviceRoleKey) {
      return result = failure(403, "FORBIDDEN");
    }
    const { data, error } = await deps.anonClient(authorization).auth.getUser();
    if (error || !data.user) return result = failure(401, "UNAUTHORIZED");
    userId = data.user.id;
    if (req.method !== "POST") {
      return result = failure(405, "METHOD_NOT_ALLOWED");
    }
    let body: Row;
    try {
      body = record(await parseBody());
    } catch {
      return result = failure(400, "INVALID_REQUEST");
    }
    // Only allow-listed values enter logs; arbitrary request strings may themselves be secrets.
    if (typeof body.action !== "string" || !ACTIONS.includes(body.action)) {
      return result = failure(400, "INVALID_REQUEST");
    }
    action = body.action;
    provider = isProvider(body.provider_code) || body.provider_code === "codex"
      ? body.provider_code
      : null;
    result = await dispatch(deps, userId, action, body);
    return result;
  } catch {
    return result = failure(500, STORE_FAILED);
  } finally {
    deps.log({
      user_id: userId,
      action,
      provider_code: provider,
      outcome: result.body.code ?? "OK",
    });
  }
}
