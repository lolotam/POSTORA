import { z } from "npm:zod@3.23.8";
import { OAUTH_CLIENTS, OAUTH_PROVIDER_CODE, type OAuthProviderId } from "../_shared/aiOAuth/clients.ts";
import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";

export interface Caller {
  userId: string;
}

export interface OAuthStatusRow {
  oauth_provider: string;
  provider_code: string;
  status: string;
  account_label: string | null;
  expires_at: string | null;
}

/** Everything the handler touches, injected so the boundary stays testable. */
export interface HandlerDeps {
  isAdmin(userId: string): Promise<boolean>;
  oauthEnabled(): Promise<boolean>;
  listModels(oauthProvider: string): string[];
  /** The ai_providers row: its display name and the admin's on/off switch. */
  providerInfo(providerCode: string): Promise<{ name: string | null; active: boolean }>;
  statuses(): Promise<OAuthStatusRow[]>;
  start(provider: OAuthProviderId, userId: string): Promise<{ authorizeUrl: string }>;
  finish(provider: OAuthProviderId, pasted: string, userId: string): Promise<{ accountLabel: string | null }>;
  disconnect(provider: OAuthProviderId): Promise<void>;
  test(provider: OAuthProviderId, modelId: string): Promise<{ ok: boolean; latency_ms: number; error?: string }>;
  logRefusal(details: { action: string; reason: string; userId: string | null }): Promise<void>;
}

const RequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("capabilities") }),
  z.object({ action: z.literal("start"), oauth_provider: z.enum(["anthropic", "openai-codex", "openrouter"]) }),
  z.object({
    action: z.literal("finish"),
    oauth_provider: z.enum(["anthropic", "openai-codex", "openrouter"]),
    pasted: z.string().min(1).max(4096),
  }),
  z.object({ action: z.literal("disconnect"), oauth_provider: z.enum(["anthropic", "openai-codex", "openrouter"]) }),
  z.object({
    action: z.literal("test"),
    oauth_provider: z.enum(["anthropic", "openai-codex", "openrouter"]),
    model_id: z.string().min(1).max(120),
  }),
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function refusal(
  deps: HandlerDeps,
  action: string,
  reason: string,
  userId: string | null,
  status: number,
): Promise<Response> {
  // Sanitized operational event only: action + reason, never credentials.
  try {
    await deps.logRefusal({ action, reason, userId });
  } catch (logError) {
    console.warn({ event: "ai_provider_auth_refusal_log_failed", reason: logError instanceof Error ? logError.message : "unknown" });
  }
  return json({ error: reason }, status);
}

export async function handle(body: unknown, caller: Caller, deps: HandlerDeps): Promise<Response> {
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const request = parsed.data;
  const { userId } = caller;

  // The admin check runs first for every action (ARCHITECTURE §39): a non-admin
  // may not even learn whether the flag is on.
  if (!(await deps.isAdmin(userId))) {
    return refusal(deps, request.action, "not_admin", userId, 403);
  }

  if (request.action === "capabilities") {
    const [statuses, enabled] = await Promise.all([deps.statuses(), deps.oauthEnabled()]);
    const providers = [];
    for (const [oauthProvider, providerCode] of Object.entries(OAUTH_PROVIDER_CODE)) {
      // Our own client registry is the capability registry: a provider without
      // a client has no sign-in we could drive.
      const client = OAUTH_CLIENTS[oauthProvider as OAuthProviderId];
      const row = statuses.find((s) => s.oauth_provider === oauthProvider);
      const info = await deps.providerInfo(providerCode);
      providers.push({
        provider_code: providerCode,
        oauth_provider: oauthProvider,
        name: info.name,
        active: info.active,
        status: row?.status ?? "not_connected",
        account_label: row?.account_label ?? null,
        expires_at: row?.expires_at ?? null,
        models: deps.listModels(oauthProvider),
        flow: client.flow,
      });
    }
    return json({ enabled, providers });
  }

  if (request.action === "disconnect") {
    // Disconnect works regardless of the flag: an admin must always be able to
    // remove a stored credential.
    await deps.disconnect(request.oauth_provider);
    return json({ status: "not_connected" });
  }

  // start / finish / test drive the subscription pathway, which only exists
  // while the flag is on.
  if (!(await deps.oauthEnabled())) {
    return refusal(deps, request.action, "oauth_disabled", userId, 409);
  }

  switch (request.action) {
    case "start": {
      const { authorizeUrl } = await deps.start(request.oauth_provider, userId);
      // The flow tells the browser how the result comes back: a paste box or
      // our own callback route.
      return json({ authorize_url: authorizeUrl, flow: OAUTH_CLIENTS[request.oauth_provider].flow });
    }
    case "finish": {
      try {
        const { accountLabel } = await deps.finish(request.oauth_provider, request.pasted, userId);
        return json({ status: "connected", account_label: accountLabel });
      } catch (cause) {
        if (cause instanceof AiOAuthError) return json({ error: cause.code }, 400);
        throw cause;
      }
    }
    case "test": {
      const result = await deps.test(request.oauth_provider, request.model_id);
      return json(result);
    }
  }
}
