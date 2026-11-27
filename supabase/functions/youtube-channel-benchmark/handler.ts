import { z } from "npm:zod@3.23.8";
import { readJsonBodyCapped } from "../_shared/cappedJsonBody.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { deriveYouTubeCapabilities } from "../youtube-resources/capabilities.ts";
import type {
  BenchmarkChannelLookupOutcome,
  BenchmarkUnitDebitResult,
  YouTubeBenchmarkReadClient,
} from "./benchmarkReadClient.ts";
import {
  classifyBenchmarkChannelInput,
  type ClassifiedBenchmarkChannelInput,
  YOUTUBE_BENCHMARK_DAILY_BUDGET_UNITS,
  YOUTUBE_BENCHMARK_ERROR_STATUS,
  YOUTUBE_BENCHMARK_MAX_CHANNELS,
  YOUTUBE_BENCHMARK_SCHEMA_VERSION,
  type YouTubeBenchmarkChannel,
  type YouTubeBenchmarkErrorCode,
  type YouTubeBenchmarkSuccess,
} from "./contracts.ts";

export const YOUTUBE_BENCHMARK_MAX_BODY_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;
const USER_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface YouTubeBenchmarkAccount {
  id: string;
  userId: string;
  channelId: string | null;
  channelTitle: string | null;
  authProvider: string | null;
  needsReauth: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  accountMetadata: unknown;
}

export type YouTubeBenchmarkTokenResult =
  | { ok: true; accessToken: string; minted: boolean }
  | { ok: false; code: "reconnect_required" | "upstream_unavailable" };

export type YouTubeBenchmarkRateLimitResult =
  | { ok: true; allowed: true }
  | { ok: true; allowed: false; retryAfterSeconds: number }
  | { ok: false; code: "upstream_unavailable" };

export interface YouTubeBenchmarkRefusal {
  code: YouTubeBenchmarkErrorCode;
  userId: string | null;
  accountId: string | null;
  requestId: string;
}

export interface YouTubeBenchmarkPorts {
  auth: { authenticate(req: Request): Promise<{ userId: string }> };
  accounts: {
    load(input: { accountId: string; userId: string }): Promise<YouTubeBenchmarkAccount | null>;
  };
  tokens: {
    get(account: YouTubeBenchmarkAccount, options: { force: boolean }): Promise<YouTubeBenchmarkTokenResult>;
  };
  rateLimits: {
    checkUser(userId: string): Promise<YouTubeBenchmarkRateLimitResult>;
  };
  budget: {
    debit(units: number): Promise<BenchmarkUnitDebitResult>;
  };
  read: YouTubeBenchmarkReadClient;
  audit: {
    logRefusal(entry: YouTubeBenchmarkRefusal): Promise<void>;
  };
  clock: { now(): Date };
  ids: { requestId(): string };
}

const BenchmarkRequestSchema = z.object({
  account_id: z.string().uuid(),
  channels: z.array(z.string()).min(1).max(YOUTUBE_BENCHMARK_MAX_CHANNELS),
}).strict();

export function parseStrictBenchmarkBudgetDecision(
  raw: unknown,
  requestedCost: number,
  ceiling = YOUTUBE_BENCHMARK_DAILY_BUDGET_UNITS,
): { allowed: boolean; count: number; retryAfterSeconds: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.allowed !== "boolean") return null;
  if (typeof record.count !== "number" || !Number.isInteger(record.count) || record.count < 0) {
    return null;
  }
  const retryAfter = record.retry_after;
  if (typeof retryAfter !== "number" || !Number.isInteger(retryAfter) || retryAfter < 0) {
    return null;
  }
  if (record.allowed && (record.count < requestedCost || record.count > ceiling)) {
    return null;
  }
  return { allowed: record.allowed, count: record.count, retryAfterSeconds: retryAfter };
}

function classifyUniqueChannels(rawChannels: string[]): ClassifiedBenchmarkChannelInput[] | null {
  const classified: ClassifiedBenchmarkChannelInput[] = [];
  const seen = new Set<string>();
  for (const raw of rawChannels) {
    const item = classifyBenchmarkChannelInput(raw);
    if (!item || seen.has(item.normalized)) return null;
    seen.add(item.normalized);
    classified.push(item);
  }
  return classified;
}

function checkAccountEligibility(account: YouTubeBenchmarkAccount): YouTubeBenchmarkErrorCode | null {
  if (account.authProvider === "composio") return "provider_unsupported";
  const browse = deriveYouTubeCapabilities({
    id: account.id,
    channelId: account.channelId,
    channelTitle: account.channelTitle,
    authProvider: account.authProvider,
    needsReauth: account.needsReauth,
    hasAccessToken: Boolean(account.accessToken),
    hasRefreshToken: Boolean(account.refreshToken),
    accountMetadata: account.accountMetadata,
  }).capabilities.browse;
  if (browse.state === "unavailable") return browse.reason;
  if (account.channelId === null) return "reconnect_required";
  return null;
}

function jsonNoStore(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...restrictedCorsHeaders(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function createYouTubeBenchmarkHandler(
  ports: YouTubeBenchmarkPorts,
): (req: Request) => Promise<Response> {
  async function refuse(
    req: Request,
    entry: YouTubeBenchmarkRefusal,
    extra?: Record<string, unknown>,
  ): Promise<Response> {
    try {
      await ports.audit.logRefusal(entry);
    } catch {
      console.warn({ event: "youtube_benchmark_refusal_log_failed", code: entry.code });
    }
    return jsonNoStore(req, YOUTUBE_BENCHMARK_ERROR_STATUS[entry.code], {
      error: entry.code,
      request_id: entry.requestId,
      ...extra,
    });
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: restrictedCorsHeaders(req) });
    }
    const requestId = ports.ids.requestId();
    if (req.method !== "POST") {
      return await refuse(req, {
        code: "invalid_request",
        userId: null,
        accountId: null,
        requestId,
      });
    }

    let userId: string;
    try {
      userId = (await ports.auth.authenticate(req)).userId;
    } catch {
      return await refuse(req, {
        code: "unauthenticated",
        userId: null,
        accountId: null,
        requestId,
      });
    }
    if (typeof userId !== "string" || !USER_ID_UUID_RE.test(userId)) {
      return await refuse(req, {
        code: "unauthenticated",
        userId: null,
        accountId: null,
        requestId,
      });
    }

    const bodyResult = await readJsonBodyCapped(
      req,
      YOUTUBE_BENCHMARK_MAX_BODY_BYTES,
      AbortSignal.timeout(BODY_READ_TIMEOUT_MS),
    ).catch(() => ({ ok: false as const, reason: "invalid_json" as const }));
    if (!bodyResult.ok) {
      return await refuse(req, {
        code: "invalid_request",
        userId,
        accountId: null,
        requestId,
      });
    }

    const parsed = BenchmarkRequestSchema.safeParse(bodyResult.value);
    if (!parsed.success) {
      return await refuse(req, {
        code: "invalid_request",
        userId,
        accountId: null,
        requestId,
      });
    }

    const accountId = parsed.data.account_id;
    const targets = classifyUniqueChannels(parsed.data.channels);
    if (!targets) {
      return await refuse(req, {
        code: "invalid_request",
        userId,
        accountId,
        requestId,
      });
    }

    let account: YouTubeBenchmarkAccount | null;
    try {
      account = await ports.accounts.load({ accountId, userId });
    } catch {
      return await refuse(req, {
        code: "internal_error",
        userId,
        accountId,
        requestId,
      });
    }
    if (!account || account.userId !== userId) {
      return await refuse(req, {
        code: "not_found",
        userId,
        accountId,
        requestId,
      });
    }

    const ineligible = checkAccountEligibility(account);
    if (ineligible) {
      return await refuse(req, {
        code: ineligible,
        userId,
        accountId,
        requestId,
      });
    }

    let rateDecision: YouTubeBenchmarkRateLimitResult;
    try {
      rateDecision = await ports.rateLimits.checkUser(userId);
    } catch {
      return await refuse(req, {
        code: "upstream_unavailable",
        userId,
        accountId,
        requestId,
      });
    }
    if (!rateDecision.ok) {
      return await refuse(req, {
        code: rateDecision.code,
        userId,
        accountId,
        requestId,
      });
    }
    if (!rateDecision.allowed) {
      return await refuse(
        req,
        { code: "rate_limited", userId, accountId, requestId },
        { retry_after_seconds: rateDecision.retryAfterSeconds },
      );
    }

    const initialToken = await ports.tokens.get(account, { force: false });
    if (!initialToken.ok) {
      return await refuse(req, {
        code: initialToken.code,
        userId,
        accountId,
        requestId,
      });
    }

    let currentToken = initialToken.accessToken;
    let refreshedInRequest = initialToken.minted;
    const channels: YouTubeBenchmarkChannel[] = [];
    const debitUnit = () => ports.budget.debit(1);

    for (const target of targets) {
      let outcome: BenchmarkChannelLookupOutcome = await ports.read.lookupChannel({
        accessToken: currentToken,
        input: target.queryValue,
        debitUnit,
      });

      if (outcome.kind === "unauthorized" && !refreshedInRequest) {
        refreshedInRequest = true;
        const refreshed = await ports.tokens.get(
          { ...account, accessToken: currentToken },
          { force: true },
        );
        if (!refreshed.ok) {
          return await refuse(req, {
            code: refreshed.code,
            userId,
            accountId,
            requestId,
          });
        }
        currentToken = refreshed.accessToken;
        outcome = await ports.read.lookupChannel({
          accessToken: currentToken,
          input: target.queryValue,
          debitUnit,
        });
      }

      if (outcome.kind === "unauthorized") {
        return await refuse(req, {
          code: "reconnect_required",
          userId,
          accountId,
          requestId,
        });
      }

      channels.push(outcome.channel);
    }

    const envelope: YouTubeBenchmarkSuccess = {
      schema_version: YOUTUBE_BENCHMARK_SCHEMA_VERSION,
      request_id: requestId,
      freshness: {
        fetched_at: ports.clock.now().toISOString(),
        source: "provider",
      },
      data: {
        account_id: accountId,
        channels,
      },
    };
    return jsonNoStore(req, 200, envelope);
  };
}
