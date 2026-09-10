// /v1 router — Partner API implementation plan, deliverable 2.1.
//
// Part of the SAME deployed edge function as the frozen action alias: Kong
// mounts the whole function at /functions/v1/partner-api, and v1SubpathOf()
// peels that mount off to decide which door a request belongs to. This is NOT
// a new supabase/functions/<name>/ directory.
//
// Adding a route is a table entry, not a redesign — which is what the empty
// table of 2.1/2.2 bought. The read surface (2.3–2.6) and the send surface
// (3.5–3.7) are both entries in V1_ROUTES below; `GET /v1/usage` (2.7) is
// deliberately still absent until its counter schema is settled.
//
// Authentication attaches PER ROUTE, via withPartnerAuth — never above
// routing, so an unmatched path still 404s without a Supabase client. See
// handleV1Request and v1/router.test.ts.

import { listCommentsRoute, getCommentRoute, replyCommentRoute, hideCommentRoute, deleteCommentRoute } from "./comments.ts";
import { getAgentConfigRoute, getAutomationHandlersRoute, getAudienceRoute, updateAgentConfigRoute, listAgentToolsRoute, upsertAgentToolRoute, deleteAgentToolRoute, setToolAccountsRoute, setAutomationHandlersRoute } from "./automation.ts";
import { listConversationModesRoute, getConversationModeRoute, setConversationModeRoute, listAutoRepliesRoute, createAutoReplyRoute, updateAutoReplyRoute, deleteAutoReplyRoute } from "./automation.ts";
import { v1ErrorResponse } from "./errors.ts";
import { withPartnerAuth } from "./authenticated.ts";
import { PLATFORM_ROUTES } from "../platform/router.ts";
import { getAccount, listAccounts } from "./accounts.ts";
import {
  getConversation,
  getMessage,
  listConversationMessages,
  listConversations,
} from "./conversations.ts";
import { createConnectLink, listConnectors } from "./connectors.ts";
import { getMedia, postMedia } from "./media.ts";
import { postMessages } from "./messages.ts";
import {
  createPost,
  getPost,
  getPostStatus,
  schedulePost,
  unschedulePost,
} from "./posts.ts";
import { getTemplates } from "./templates.ts";
import { executeTool } from "./tools.ts";
import { getUsage } from "./usage.ts";
import { endSessionRoute, historySyncStatusRoute, startHistorySyncRoute, getNumber, listNumbers, registerNumberRoute, startPairingRoute, pairingStatusRoute, getProfileRoute, updateProfileRoute } from "./whatsappNumbers.ts";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooks,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
} from "./webhooks.ts";

/** The segment Kong serves this function under. Located by segment, not by
 *  prefix-of-path, so the mount depth (localhost, gateway, direct) cannot
 *  change which door a request takes. */
const FUNCTION_MOUNT_SEGMENT = "/partner-api";

/**
 * The /v1 portion of a request path, or null when the request belongs to the
 * alias door.
 *
 * Only "/v1" itself and things under "/v1/" branch here: "/v1x" is a
 * different path and keeps today's alias behaviour, like every other
 * non-/v1 path. Query strings never participate — URL.pathname drops them.
 */
export function v1SubpathOf(url: string): string | null {
  const pathname = new URL(url).pathname;
  const at = pathname.indexOf(FUNCTION_MOUNT_SEGMENT);
  if (at === -1) return null;
  const rest = pathname.slice(at + FUNCTION_MOUNT_SEGMENT.length);
  if (rest !== "/v1" && !rest.startsWith("/v1/")) return null;
  return rest;
}

/** A request handler for one method of one /v1 route. Receives the raw
 *  request (body untouched — parsing belongs to the route), the correlation
 *  id that is already on its way to the response headers, and the captured
 *  path parameters. */
export type V1RouteHandler = (
  req: Request,
  requestId: string,
  params: Record<string, string>,
  /** The door's client factory. Passed down rather than imported so a test can
   *  drive an authenticated route against a stubbed Supabase boundary, and so
   *  /v1 and the alias cannot end up with two different clients. */
  // deno-lint-ignore no-explicit-any
  createAdminClient?: () => any,
) => Promise<Response>;

export interface V1Route {
  /** Route pattern below the function mount, e.g. "/v1/accounts/{id}".
   *  Literal segments match exactly; a "{name}" segment matches any single
   *  non-empty segment and is captured verbatim (URL-encoded — handlers
   *  decode if their resource grammar allows it). */
  pattern: string;
  /** Supported methods, keyed by uppercase HTTP method. Registration order
   *  is the Allow header order. */
  methods: Record<string, V1RouteHandler>;
}

/**
 * The /v1 route table.
 *
 * Each entry names the ALIAS action whose policy it inherits, so the two
 * doors cannot drift into different scope or risk-class answers for the same
 * capability — that is D1 convergence in practice: one policy table, two
 * doors. `withPartnerAuth` reads the scope from `ACTION_SCOPES` and hands the
 * risk class to the limiter.
 *
 * Authentication attaches HERE, to a matched route — never above routing.
 * An unmatched path still 404s without touching Supabase, which is the
 * non-enumerability property Phase 2 established and v1/router.test.ts
 * asserts against.
 */
export const V1_ROUTES: V1Route[] = [
  {
    pattern: "/v1/automation/conversation-modes",
    methods: { GET: withPartnerAuth("list_conversation_modes", "A", listConversationModesRoute) },
  },
  {
    pattern: "/v1/automation/auto-replies/{id}",
    methods: {
      PATCH: withPartnerAuth("update_auto_reply", "C", updateAutoReplyRoute),
      DELETE: withPartnerAuth("delete_auto_reply", "C", deleteAutoReplyRoute),
    },
  },
  {
    pattern: "/v1/automation/auto-replies",
    methods: {
      GET: withPartnerAuth("list_auto_replies", "A", listAutoRepliesRoute),
      POST: withPartnerAuth("create_auto_reply", "C", createAutoReplyRoute),
    },
  },
  {
    pattern: "/v1/automation/handlers",
    methods: {
      GET: withPartnerAuth("get_automation_handlers", "A", getAutomationHandlersRoute),
      PUT: withPartnerAuth("set_automation_handlers", "C", setAutomationHandlersRoute),
    },
  },
  {
    pattern: "/v1/automation/audience",
    methods: { GET: withPartnerAuth("get_audience", "B", getAudienceRoute) },
  },
  {
    pattern: "/v1/automation/tools/{id}/accounts",
    methods: { PUT: withPartnerAuth("set_tool_accounts", "C", setToolAccountsRoute) },
  },
  {
    pattern: "/v1/automation/tools/{id}",
    methods: {
      PUT: withPartnerAuth("upsert_agent_tool", "C", upsertAgentToolRoute),
      DELETE: withPartnerAuth("delete_agent_tool", "C", deleteAgentToolRoute),
    },
  },
  {
    pattern: "/v1/automation/tools",
    methods: { GET: withPartnerAuth("list_agent_tools", "A", listAgentToolsRoute) },
  },
  {
    pattern: "/v1/automation/agent",
    methods: {
      GET: withPartnerAuth("get_agent_config", "A", getAgentConfigRoute),
      PUT: withPartnerAuth("update_agent_config", "C", updateAgentConfigRoute),
    },
  },
  {
    pattern: "/v1/comments/{id}/reply",
    methods: { POST: withPartnerAuth("reply_comment", "C", replyCommentRoute) },
  },
  {
    pattern: "/v1/comments/{id}/hide",
    methods: { POST: withPartnerAuth("hide_comment", "C", hideCommentRoute) },
  },
  {
    pattern: "/v1/comments/{id}",
    methods: {
      GET: withPartnerAuth("get_comment", "B", getCommentRoute),
      DELETE: withPartnerAuth("delete_comment", "C", deleteCommentRoute),
    },
  },
  {
    pattern: "/v1/comments",
    methods: { GET: withPartnerAuth("list_comments", "B", listCommentsRoute) },
  },
  {
    pattern: "/v1/whatsapp/numbers/{id}/profile",
    methods: {
      GET: withPartnerAuth("get_whatsapp_profile", "B", getProfileRoute),
      PATCH: withPartnerAuth("update_whatsapp_profile", "C", updateProfileRoute),
    },
  },
  {
    pattern: "/v1/whatsapp/numbers/{id}/session",
    methods: {
      DELETE: withPartnerAuth("end_whatsapp_session", "C", endSessionRoute),
    },
  },
  {
    pattern: "/v1/whatsapp/numbers/{id}/history-sync",
    methods: {
      GET: withPartnerAuth("get_whatsapp_history_sync", "A", historySyncStatusRoute),
      POST: withPartnerAuth("start_whatsapp_history_sync", "C", startHistorySyncRoute),
    },
  },
  {
    pattern: "/v1/usage",
    methods: {
      GET: withPartnerAuth("get_usage", "A", getUsage),
    },
  },
  {
    pattern: "/v1/accounts",
    methods: {
      GET: withPartnerAuth("list_accounts", "A", listAccounts),
    },
  },
  {
    pattern: "/v1/accounts/{id}",
    methods: {
      GET: withPartnerAuth("get_account", "A", getAccount),
    },
  },
  {
    pattern: "/v1/whatsapp/numbers/{id}/pairing",
    methods: {
      POST: withPartnerAuth("create_whatsapp_pairing", "C", startPairingRoute),
      GET: withPartnerAuth("get_whatsapp_pairing", "B", pairingStatusRoute),
    },
  },
  {
    pattern: "/v1/whatsapp/numbers",
    methods: {
      GET: withPartnerAuth("list_whatsapp_numbers", "A", listNumbers),
      POST: withPartnerAuth("register_whatsapp_number", "C", registerNumberRoute),
    },
  },
  {
    pattern: "/v1/whatsapp/numbers/{id}",
    methods: {
      GET: withPartnerAuth("get_whatsapp_number", "A", getNumber),
    },
  },
  {
    pattern: "/v1/conversations",
    methods: {
      GET: withPartnerAuth("list_conversations", "A", listConversations),
    },
  },
  {
    pattern: "/v1/conversations/{id}/mode",
    methods: {
      GET: withPartnerAuth("get_conversation_mode", "A", getConversationModeRoute),
      PUT: withPartnerAuth("set_conversation_mode", "C", setConversationModeRoute),
    },
  },
  {
    pattern: "/v1/conversations/{id}/messages",
    methods: {
      GET: withPartnerAuth("list_conversation_messages", "A", listConversationMessages),
    },
  },
  {
    pattern: "/v1/conversations/{id}",
    methods: {
      GET: withPartnerAuth("get_conversation", "A", getConversation),
    },
  },
  // Hybrid connectors (spec §8.2). The sub-resource route is registered before
  // the collection out of the same habit the webhook block names below; they
  // cannot collide, because matchPattern compares segment counts first.
  {
    pattern: "/v1/connectors/{type}/connect-link",
    methods: {
      POST: withPartnerAuth("create_connect_link", "C", createConnectLink),
    },
  },
  {
    pattern: "/v1/connectors",
    methods: {
      GET: withPartnerAuth("list_connectors", "A", listConnectors),
    },
  },
  {
    pattern: "/v1/media",
    methods: {
      POST: withPartnerAuth("upload_media", "C", postMedia),
    },
  },
  {
    pattern: "/v1/media/{id}",
    methods: {
      GET: withPartnerAuth("get_media", "A", getMedia),
    },
  },
  {
    pattern: "/v1/messages",
    methods: {
      POST: withPartnerAuth("send_template", "C", postMessages),
    },
  },
  {
    pattern: "/v1/messages/{id}",
    methods: {
      GET: withPartnerAuth("get_message", "A", getMessage),
    },
  },
  {
    pattern: "/v1/tools/execute",
    methods: {
      POST: withPartnerAuth("execute_tool", "C", executeTool),
    },
  },
  {
    pattern: "/v1/templates",
    methods: {
      GET: withPartnerAuth("list_templates", "B", getTemplates),
    },
  },
  // Phase 8. Sub-resource routes before "/v1/posts/{id}", same habit as the
  // webhook block below. POST /v1/posts/{id}/publish is deliberately absent —
  // it needs the deferred 7.2/7.3 platform registry (see posts.ts header).
  {
    pattern: "/v1/posts/{id}/status",
    methods: {
      GET: withPartnerAuth("get_post_status", "A", getPostStatus),
    },
  },
  {
    pattern: "/v1/posts/{id}/schedule",
    methods: {
      POST: withPartnerAuth("schedule_post", "C", schedulePost),
      DELETE: withPartnerAuth("unschedule_post", "C", unschedulePost),
    },
  },
  {
    pattern: "/v1/posts",
    methods: {
      POST: withPartnerAuth("create_post", "C", createPost),
    },
  },
  {
    pattern: "/v1/posts/{id}",
    methods: {
      GET: withPartnerAuth("get_post", "A", getPost),
    },
  },
  // Phase 5. The two sub-resource routes are registered BEFORE "/v1/webhooks/{id}"
  // out of the same habit the comment on resolveV1Route names, even though
  // they cannot collide here: matchPattern compares segment COUNTS first, so
  // "/v1/webhooks/x/test" can never match a two-segment pattern. Relying on
  // that silently is how the next three-segment route gets it wrong.
  {
    pattern: "/v1/webhooks/{id}/rotate-secret",
    methods: {
      POST: withPartnerAuth("rotate_webhook_secret", "C", rotateWebhookSecret),
    },
  },
  {
    pattern: "/v1/webhooks/{id}/test",
    methods: {
      POST: withPartnerAuth("test_webhook", "C", testWebhook),
    },
  },
  {
    pattern: "/v1/webhooks",
    methods: {
      GET: withPartnerAuth("list_webhooks", "A", listWebhooks),
      POST: withPartnerAuth("create_webhook", "C", createWebhook),
    },
  },
  {
    pattern: "/v1/webhooks/{id}",
    methods: {
      GET: withPartnerAuth("get_webhook", "A", getWebhook),
      PATCH: withPartnerAuth("update_webhook", "C", updateWebhook),
      DELETE: withPartnerAuth("delete_webhook", "C", deleteWebhook),
    },
  },
];

export type V1Resolution =
  | { kind: "routed"; route: V1Route; params: Record<string, string> }
  | { kind: "method_not_allowed"; allowed: string[] }
  | { kind: "not_found" };

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function matchPattern(
  pattern: string,
  subPath: string,
): Record<string, string> | null {
  const patternSegments = pathSegments(pattern);
  const requestSegments = pathSegments(subPath);
  if (patternSegments.length !== requestSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const expected = patternSegments[i]!;
    if (expected.startsWith("{") && expected.endsWith("}") && expected.length > 2) {
      params[expected.slice(1, -1)] = requestSegments[i]!;
    } else if (expected !== requestSegments[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Resolve a /v1 request against a route table: dispatch, 405 (with the
 * methods that ARE supported for that path), or 404. First matching pattern
 * wins, so register specific routes before parameterised ones.
 */
export function resolveV1Route(
  routes: readonly V1Route[],
  subPath: string,
  method: string,
): V1Resolution {
  const upperMethod = method.toUpperCase();
  for (const route of routes) {
    const params = matchPattern(route.pattern, subPath);
    if (params === null) continue;
    // Object.hasOwn, not `in`: an inherited "toString"/"constructor" key must
    // never resolve as a supported method.
    if (Object.hasOwn(route.methods, upperMethod)) {
      return { kind: "routed", route, params };
    }
    return { kind: "method_not_allowed", allowed: Object.keys(route.methods) };
  }
  return { kind: "not_found" };
}

/**
 * Serve one /v1 request. The requestId is generated by the caller (index.ts)
 * BEFORE authentication or any other early exit, so every response this
 * returns — 404, 405, success, failure — carries the same value in the
 * X-Postora-Request-Id header and inside the envelope.
 */
export async function handleV1Request(
  req: Request,
  subPath: string,
  requestId: string,
  // deno-lint-ignore no-explicit-any
  createAdminClient?: () => any,
): Promise<Response> {
  const platformResolution = resolveV1Route(PLATFORM_ROUTES, subPath, req.method);
  const resolution = platformResolution.kind === "not_found"
    ? resolveV1Route(V1_ROUTES, subPath, req.method)
    : platformResolution;
  if (resolution.kind === "routed") {
    const handler = resolution.route.methods[req.method.toUpperCase()]!;
    try {
      return await handler(req, requestId, resolution.params, createAdminClient);
    } catch (err) {
      // The response stays typed and partner-safe; the technical detail goes
      // to the server log only, keyed by the correlation handle.
      console.error(
        `[partner-api] v1 handler error (request ${requestId}, ${req.method} ${subPath}):`,
        err,
      );
      return v1ErrorResponse("internal_error", requestId);
    }
  }
  if (resolution.kind === "method_not_allowed") {
    // RFC 9110 §10.2.1: Allow names the methods supported by the target
    // resource. Registration order, uppercase, comma-separated. The spec and
    // the OpenAPI document are silent on this header's exact format; this is
    // the conventional spelling of the RFC's #method list.
    return v1ErrorResponse("method_not_allowed", requestId, {
      headers: { Allow: resolution.allowed.join(", ") },
    });
  }
  return v1ErrorResponse("resource_not_found", requestId);
}
