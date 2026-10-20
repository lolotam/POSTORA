// Postora MCP Server (Streamable HTTP)
// Exposes the public n8n-api endpoints as MCP tools so any MCP-compatible
// LLM client (Claude Desktop, ChatGPT, Antigravity, Cursor, Cline, OpenAI
// Agents SDK, etc.) can connect with a Postora API key as Bearer token.

import { Hono } from "npm:hono@4.6.14";
import { McpServer, StreamableHttpTransport } from "npm:mcp-lite@^0.10.0";
import { z } from "npm:zod@3.23.8";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { normalizeListFields } from "./stringList.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-api-key, x-client-info, apikey, content-type, accept, mcp-session-id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id, www-authenticate",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const API_ORIGIN = Deno.env.get("PUBLIC_API_ORIGIN") ?? "https://api.postora.cloud";
const APP_ORIGIN = Deno.env.get("PUBLIC_APP_ORIGIN") ?? "https://postora.cloud";
const PROTECTED_RESOURCE_METADATA_URL =
  `${APP_ORIGIN}/.well-known/oauth-protected-resource`;
const WWW_AUTHENTICATE =
  `Bearer realm="postora-mcp", resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`;

const N8N_API_BASE = `${SUPABASE_URL}/functions/v1/n8n-api`;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function base64UrlEncode(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return base64UrlEncode(buf);
}

// Resolve an OAuth Bearer token (issued by mcp-oauth) to the user's Postora
// API key. Returns null if the token is unknown / expired / revoked.
async function resolveOAuthToken(token: string, userAgent?: string): Promise<string | null> {
  if (!token || token.length < 16) return null;
  const hash = await sha256(token);
  const { data: row } = await admin
    .from("mcp_oauth_tokens")
    .select("id, user_id, expires_at, revoked_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("api_key")
    .eq("id", row.user_id)
    .maybeSingle();
  if (!profile?.api_key) return null;

  // Fire-and-forget activity update
  admin.from("mcp_oauth_tokens")
    .update({ last_used_at: new Date().toISOString(), last_user_agent: userAgent ?? null })
    .eq("id", row.id)
    .then(() => {}, () => {});

  return profile.api_key as string;
}

function extractApiKey(req: Request): string | null {
  const xApi = req.headers.get("x-api-key");
  if (xApi) return xApi.trim();
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const lower = auth.toLowerCase();
  if (lower.startsWith("bearer ")) return auth.slice(7).trim();
  if (lower.startsWith("apikey ")) return auth.slice(7).trim();
  return auth.trim();
}

async function callN8n(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<{ status: number; data: unknown }> {
  const url = new URL(N8N_API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = { raw: await res.text() };
  }
  return { status: res.status, data };
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(status: number, data: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `Postora API error ${status}: ${JSON.stringify(data)}`,
      },
    ],
  };
}

// Build a fresh MCP server bound to a specific user's API key.
function buildServer(apiKey: string) {
  const server = new McpServer({
    name: "postora",
    version: "1.0.0",
    schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
  });

  // ---- Accounts ----
  server.tool("list_accounts", {
    description:
      "List the user's connected social media accounts (Facebook Pages, Instagram, TikTok, YouTube, Pinterest, X, LinkedIn, Threads, Bluesky, Reddit).",
    inputSchema: z.object({
      platform: z.string().optional().describe("Optional filter by platform"),
    }),
    handler: async ({ platform }) => {
      const r = await callN8n(apiKey, "GET", "/api/v1/accounts", undefined, { platform });
      return r.status >= 400 ? fail(r.status, r.data) : ok(r.data);
    },
  });

  // ---- Posts ----
  server.tool("list_posts", {
    description: "List the user's recent posts. Supports pagination and status filtering.",
    inputSchema: z.object({
      status: z.enum(["pending", "processing", "completed", "failed", "scheduled"]).optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
    handler: async (args) => {
      const r = await callN8n(apiKey, "GET", "/api/v1/posts", undefined, args);
      return r.status >= 400 ? fail(r.status, r.data) : ok(r.data);
    },
  });

  server.tool("get_post", {
    description: "Get a single post (and its per-platform results) by Postora post id.",
    inputSchema: z.object({ post_id: z.string().describe("Postora post UUID") }),
    handler: async ({ post_id }) => {
      const r = await callN8n(apiKey, "GET", `/api/v1/post/${encodeURIComponent(post_id)}`);
      return r.status >= 400 ? fail(r.status, r.data) : ok(r.data);
    },
  });

  // ---- Create / publish post ----
  // MCP clients may send list fields as a real array, as JSON-array text
  // ("[\"uuid\"]") or as comma-separated text ("facebook, instagram").
  const stringList = z.union([z.array(z.string()), z.string()]);

  server.tool("create_post", {
    description:
      "Create a post and publish (or schedule) it across one or more connected social accounts. " +
      "To schedule, pass a future ISO 8601 timestamp to 'scheduled_at'. " +
      "To create a Carousel post, pass multiple files (2 to 10) in 'media_urls' or 'media_file_ids'. " +
      "If scheduled_at is omitted, the post is published immediately.",
    inputSchema: z.object({
      caption: z.string().optional().describe("The post caption or text content"),
      platforms: stringList.describe("e.g. ['facebook','instagram','tiktok','pinterest','youtube','linkedin','twitter'] Accepts an array, JSON-array text or comma-separated text."),
      account_ids: stringList.optional().describe("Optional list of specific Postora social account IDs to publish to"),
      media_file_ids: stringList.optional().describe("List of media IDs from upload_media. Pass multiple for a Carousel post."),
      media_urls: stringList.optional().describe("List of public media URLs. Pass multiple for a Carousel post."),
      media_base64: z.array(z.string()).optional().describe("List of base64 encoded media strings"),
      scheduled_at: z.string().optional().describe("ISO 8601 timestamp (e.g. 2026-06-05T14:30:00Z) to schedule the post. Omit to publish now."),
      timezone: z.string().optional().describe("Target timezone for scheduling (e.g., 'America/New_York')"),
      first_comment: z.string().optional().describe("Optional comment to automatically post immediately after publishing"),
      instagram_media_type: z.enum(["feed", "stories"]).optional().describe("Set to 'stories' to publish as an Instagram Story instead of a feed post"),
      instagram_share_to_feed: z.boolean().optional().describe("For Instagram videos, whether to also share to the main profile feed"),
      instagram_collaborators: stringList.optional().describe("Instagram usernames to invite as Collab co-authors on a feed image, carousel or reel (not stories). Only the first username is invited today. If Instagram rejects it, the post is published without it and get_post shows a warning in platform_results[].warnings."),
      facebook_post_type: z.enum(["feed", "story", "reel"]).optional().describe("Set to 'story' to publish as a Facebook Story, or 'reel' to publish as a Reel"),
      youtube_title: z.string().optional(),
      youtube_privacy: z.enum(["public", "unlisted", "private"]).optional(),
      youtube_tags: stringList.optional(),
      youtube_video_type: z.enum(["video", "short"]).optional().describe("Set to 'short' to publish as a YouTube Short"),
      tiktok_privacy: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]).optional(),
      tiktok_allow_comments: z.boolean().optional(),
      tiktok_allow_duet: z.boolean().optional(),
      tiktok_allow_stitch: z.boolean().optional(),
      pinterest_board_id: z.string().optional(),
      pinterest_title: z.string().optional(),
      pinterest_link: z.string().optional(),
    }).passthrough(),
    handler: async (args) => {
      const r = await callN8n(apiKey, "POST", "/api/v1/post", normalizeListFields(args as Record<string, unknown>));
      return r.status >= 400 ? fail(r.status, r.data) : ok(r.data);
    },
  });

  // ---- Media upload ----
  server.tool("upload_media", {
    description:
      "Upload a media file (image or video) to the Postora media library. " +
      "Provide either media_url (public URL) or media_base64 (data URL or raw base64). " +
      "Returns a media_file_id you can pass to create_post.",
    inputSchema: z.object({
      media_url: z.string().optional(),
      media_base64: z.string().optional(),
      filename: z.string().optional(),
      mime_type: z.string().optional(),
    }),
    handler: async (args) => {
      const r = await callN8n(apiKey, "POST", "/api/v1/upload-media", args);
      return r.status >= 400 ? fail(r.status, r.data) : ok(r.data);
    },
  });

  // ---- Webhooks ----
  server.tool("list_webhooks", {
    description: "List the user's registered webhook subscriptions for post status updates.",
    inputSchema: z.object({}),
    handler: async () => {
      const r = await callN8n(apiKey, "GET", "/api/v1/webhooks");
      return r.status >= 400 ? fail(r.status, r.data) : ok(r.data);
    },
  });

  server.tool("register_webhook", {
    description: "Register a webhook URL to receive post status notifications.",
    inputSchema: z.object({
      url: z.string().describe("HTTPS URL to receive webhook events"),
      events: z.array(z.string()).optional(),
    }),
    handler: async (args) => {
      const r = await callN8n(apiKey, "POST", "/api/v1/webhooks", args);
      return r.status >= 400 ? fail(r.status, r.data) : ok(r.data);
    },
  });

  server.tool("delete_webhook", {
    description: "Delete a registered webhook by id.",
    inputSchema: z.object({ webhook_id: z.string() }),
    handler: async ({ webhook_id }) => {
      const r = await callN8n(apiKey, "DELETE", `/api/v1/webhooks/${encodeURIComponent(webhook_id)}`);
      return r.status >= 400 ? fail(r.status, r.data) : ok(r.data);
    },
  });

  return server;
}

const app = new Hono();

app.options("/*", (c) => new Response(null, { headers: corsHeaders }));

// Friendly GET so users can sanity-check the URL in a browser.
app.get("/mcp", (c) =>
  new Response(
    JSON.stringify({
      name: "Postora MCP Server",
      version: "1.0.0",
      transport: "streamable-http",
      auth: "Bearer <Postora API key> (or x-api-key header)",
      docs: "https://postora.cloud/docs/mcp-server",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  ),
);

app.all("/*", async (c) => {
  const req = c.req.raw;
  const presented = extractApiKey(req);
  let apiKey: string | null = presented;
  // Postora-issued API keys start with "postora-". Anything else is treated as
  // an MCP OAuth access token and resolved via mcp_oauth_tokens.
  if (presented && !presented.startsWith("postora-")) {
    apiKey = await resolveOAuthToken(presented, req.headers.get("user-agent") ?? undefined);
  }
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: presented
            ? "Invalid or expired access token."
            : "Missing access token. Authorize via OAuth or pass a Postora API key.",
        },
        id: null,
      }),
      {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "WWW-Authenticate": WWW_AUTHENTICATE,
        },
      },
    );
  }

  const server = buildServer(apiKey);
  const transport = new StreamableHttpTransport();
  const handler = transport.bind(server);
  const res = await handler(req);
  // Re-wrap with CORS headers
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
});

Deno.serve(app.fetch);