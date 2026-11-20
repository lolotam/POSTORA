import { z } from "npm:zod@3.23.8";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { deriveYouTubeCapabilities } from "./capabilities.ts";
import {
  YOUTUBE_RESOURCE_ERROR_STATUS,
  YOUTUBE_RESOURCES_SCHEMA_VERSION,
  type YouTubeAccountCapabilities,
  type YouTubeResourceErrorCode,
  type YouTubeResourceSuccess,
} from "./contracts.ts";

export interface YouTubeResourceAccount {
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

export interface YouTubeResourceRefusal {
  operation: string;
  code: YouTubeResourceErrorCode;
  userId: string | null;
  accountId: string | null;
  requestId: string;
}

export interface YouTubeResourcesPorts {
  auth: { authenticate(req: Request): Promise<{ userId: string }> };
  accounts: {
    load(input: { accountId: string; userId: string }): Promise<YouTubeResourceAccount | null>;
  };
  clock: { now(): Date };
  ids: { requestId(): string };
  log: { refusal(entry: YouTubeResourceRefusal): Promise<void> };
}

const CapabilitiesRequest = z.object({
  operation: z.literal("capabilities"),
  account_id: z.string().uuid(),
}).strict();

// Same shape as _shared/auth-helper.ts, defined locally on purpose: authenticateCaller
// returns claims.sub unchecked, so the handler re-checks the identity shape itself.
const USER_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Owner-bound capabilities handler for youtube-resources. The handler does no I/O of its
 * own: identity comes only from ports.auth, the account row only from ports.accounts.
 * A foreign account and a missing account are the same 404, so account ids cannot be
 * enumerated. No credential field ever reaches a response.
 */
export function createYouTubeResourcesHandler(
  ports: YouTubeResourcesPorts,
): (req: Request) => Promise<Response> {
  // method_not_allowed and unauthorized are not written: an anonymous caller must not be
  // able to fill the log table. The write is awaited so the edge worker cannot be torn
  // down before the audit row lands; a failed log write never changes the response.
  async function refuse(
    req: Request,
    entry: YouTubeResourceRefusal,
    extra?: Record<string, unknown>,
  ): Promise<Response> {
    if (entry.code !== "method_not_allowed" && entry.code !== "unauthorized") {
      try {
        await ports.log.refusal(entry);
      } catch {
        console.warn({ event: "youtube_resources_refusal_log_failed", code: entry.code });
      }
    }
    return new Response(
      JSON.stringify({ error: entry.code, request_id: entry.requestId, ...extra }),
      {
        status: YOUTUBE_RESOURCE_ERROR_STATUS[entry.code],
        headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
      },
    );
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: restrictedCorsHeaders(req) });
    }
    const requestId = ports.ids.requestId();
    const operation = "capabilities";
    if (req.method !== "POST") {
      return await refuse(req, {
        operation,
        code: "method_not_allowed",
        userId: null,
        accountId: null,
        requestId,
      });
    }
    let userId: string;
    try {
      userId = (await ports.auth.authenticate(req)).userId;
    } catch {
      // Every auth failure is the same unauthorized answer; the thrown reason
      // (missing header, bad JWT, service-role bearer) never reaches the caller.
      return await refuse(req, {
        operation,
        code: "unauthorized",
        userId: null,
        accountId: null,
        requestId,
      });
    }
    if (typeof userId !== "string" || !USER_ID_UUID_RE.test(userId)) {
      // authenticateCaller trusts claims.sub unchecked, so a validly signed token
      // without a subject (the public anon key) yields a non-identity here. It is an
      // anonymous caller: refuse it before any account read, without a log row.
      return await refuse(req, {
        operation,
        code: "unauthorized",
        userId: null,
        accountId: null,
        requestId,
      });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      // Malformed JSON is a client error; the raw parse error text is not echoed.
      return await refuse(req, {
        operation,
        code: "invalid_request",
        userId,
        accountId: null,
        requestId,
      });
    }
    const parsed = CapabilitiesRequest.safeParse(body);
    if (!parsed.success) {
      return await refuse(req, {
        operation,
        code: "invalid_request",
        userId,
        accountId: null,
        requestId,
      });
    }
    const accountId = parsed.data.account_id;
    let account: YouTubeResourceAccount | null;
    try {
      account = await ports.accounts.load({ accountId, userId });
    } catch {
      // A failed read must never look like a missing row: this refusal is what
      // separates a database outage (500) from an unknown account (404).
      return await refuse(req, {
        operation,
        code: "internal_error",
        userId,
        accountId,
        requestId,
      });
    }
    if (!account || account.userId !== userId) {
      return await refuse(req, {
        operation,
        code: "not_found",
        userId,
        accountId,
        requestId,
      });
    }
    const envelope: YouTubeResourceSuccess<YouTubeAccountCapabilities> = {
      schema_version: YOUTUBE_RESOURCES_SCHEMA_VERSION,
      request_id: requestId,
      freshness: { fetched_at: ports.clock.now().toISOString(), source: "database" },
      data: deriveYouTubeCapabilities({
        id: account.id,
        channelId: account.channelId,
        channelTitle: account.channelTitle,
        authProvider: account.authProvider,
        needsReauth: account.needsReauth,
        hasAccessToken: Boolean(account.accessToken),
        hasRefreshToken: Boolean(account.refreshToken),
        accountMetadata: account.accountMetadata,
      }),
    };
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
    });
  };
}
