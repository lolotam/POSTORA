import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import { ReviewError } from "./errors.ts";

export type Row = Record<string, unknown>;

export interface DbResult {
  data: unknown;
  error: unknown;
}

/** Narrow query port so tests can fake PostgREST without the SDK. */
export interface Query extends PromiseLike<DbResult> {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  is(column: string, value: null): Query;
  in(column: string, values: readonly string[]): Query;
  order(column: string, options: { ascending: boolean }): Query;
  limit(count: number): Query;
  update(values: Row): Query;
  maybeSingle(): Promise<DbResult>;
}

export interface AdminClient {
  from(table: string): Query;
  rpc(name: string, params: Row): Promise<DbResult>;
}

export interface LogEvent {
  event: string;
  action: string;
  code: string;
  user_id: string | null;
  draft_id: string | null;
  submission_id: string | null;
  level: "warn" | "error";
}

export interface Dependencies {
  anonClient(authorization: string): {
    auth: {
      getUser(): PromiseLike<{ data: { user: { id: string } | null }; error: unknown }>;
    };
  };
  admin: AdminClient;
  serviceRoleKey: string;
  supabaseUrl: string;
  fetch: typeof fetch;
  now(): number;
  edgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
  log(event: LogEvent): void | Promise<void>;
}

export interface Result {
  status: number;
  body: {
    ok: boolean;
    code?: string;
    message?: string;
    details?: unknown;
    data?: unknown;
  };
}

export type OwnedAccount = {
  accessToken: string | null;
  platformUserId: string | null;
  platformUsername: string | null;
  avatarUrl: string | null;
};

const ACCOUNT_COLUMNS =
  "id, platform_user_id, platform_username, access_token, account_metadata, avatar_url";

export function success(data: unknown): Result {
  return { status: 200, body: { ok: true, data } };
}

export function readFailed(error: unknown): ReviewError {
  return new ReviewError(500, "INTERNAL", sanitizeErrorMessage(error));
}

export function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRow(value: unknown): Row {
  if (!isRow(value)) throw readFailed(new Error("Expected a row."));
  return value;
}

export async function safeLog(deps: Dependencies, event: LogEvent): Promise<void> {
  try {
    await deps.log(event);
  } catch {
    console.error("tiktok-review log failed");
  }
}

export function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw readFailed(new Error("Expected text."));
}

export async function assertRead(result: DbResult): Promise<void> {
  if (result.error) throw readFailed(result.error);
}

export async function findAccount(
  admin: AdminClient,
  userId: string,
  accountId: string,
): Promise<OwnedAccount | null> {
  const result = await admin.from("social_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("id", accountId)
    .eq("user_id", userId)
    .eq("platform", "tiktok")
    .eq("is_active", true)
    .maybeSingle();
  await assertRead(result);
  if (!isRow(result.data)) return null;
  const token = result.data.access_token;
  return {
    accessToken: typeof token === "string" && token.length > 0 ? token : null,
    platformUserId: typeof result.data.platform_user_id === "string" ? result.data.platform_user_id : null,
    platformUsername: typeof result.data.platform_username === "string" ? result.data.platform_username : null,
    avatarUrl: typeof result.data.avatar_url === "string" ? result.data.avatar_url : null,
  };
}
