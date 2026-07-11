// Operational tools available ONLY when the sender is a verified admin
// phone number (or the in-app Test sandbox with "act as admin" enabled).
// Customers never see these definitions.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ToolContext, ToolResult } from "./tools.ts";

export const adminToolDefinitions = [
  {
    type: "function",
    function: {
      name: "list_connected_accounts",
      description: "List the business's connected social media accounts (platform, username, active state).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_posts",
      description: "Search the business's recent Postora posts by caption text and/or status.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search in captions (optional)" },
          status: {
            type: "string",
            enum: ["pending", "processing", "completed", "failed"],
            description: "Filter by post status (optional)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_posting_summary",
      description: "Summarize the business's posting activity over the last N days (counts by status).",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Look-back window in days (default 30)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_scheduled_post",
      description:
        "Schedule a text post through Postora to one or more connected platforms. ALWAYS confirm caption, platforms, and time with the admin before calling this. Posts go out via the scheduler at the given time.",
      parameters: {
        type: "object",
        properties: {
          caption: { type: "string", description: "The post caption/text" },
          platforms: {
            type: "array",
            items: { type: "string" },
            description: "Platform names, e.g. [\"facebook\",\"instagram\"] — must be connected accounts",
          },
          scheduled_at: {
            type: "string",
            description: "ISO 8601 UTC datetime in the future, e.g. 2026-07-12T09:00:00Z",
          },
        },
        required: ["caption", "platforms", "scheduled_at"],
      },
    },
  },
];

async function listConnectedAccounts(context: ToolContext): Promise<ToolResult> {
  const { data, error } = await context.admin
    .from("social_accounts")
    .select("platform, platform_username, is_active")
    .eq("user_id", context.userId)
    .order("platform");
  if (error) throw error;
  if (!data?.length) return { output: "No social accounts are connected." };
  return {
    output: data
      .map(
        (account: any) =>
          `${account.platform}: ${account.platform_username || "(no username)"} — ${account.is_active ? "active" : "inactive"}`,
      )
      .join("\n"),
  };
}

async function searchPosts(context: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  let query = context.admin
    .from("posts")
    .select("caption, platforms, status, scheduled_at, posted_at, created_at")
    .eq("user_id", context.userId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (typeof args.query === "string" && args.query.trim()) {
    query = query.ilike("caption", `%${args.query.trim()}%`);
  }
  if (typeof args.status === "string" && args.status) {
    query = query.eq("status", args.status);
  }
  const { data, error } = await query;
  if (error) throw error;
  if (!data?.length) return { output: "No posts matched." };
  return {
    output: data
      .map(
        (post: any) =>
          `[${post.status}] ${(post.caption || "").slice(0, 80)} → ${(post.platforms || []).join(", ")}` +
          (post.scheduled_at ? ` (scheduled ${post.scheduled_at})` : "") +
          (post.posted_at ? ` (posted ${post.posted_at})` : ""),
      )
      .join("\n"),
  };
}

async function getPostingSummary(context: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const days = Math.min(Math.max(Number(args.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await context.admin
    .from("posts")
    .select("status")
    .eq("user_id", context.userId)
    .gte("created_at", since);
  if (error) throw error;
  const counts: Record<string, number> = {};
  for (const post of data || []) counts[post.status] = (counts[post.status] || 0) + 1;
  const lines = Object.entries(counts).map(([status, count]) => `${status}: ${count}`);
  return {
    output: `Posts in the last ${days} days: ${data?.length || 0}\n${lines.join("\n") || "(none)"}`,
  };
}

async function createScheduledPost(context: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const caption = String(args.caption || "").trim();
  const platforms = Array.isArray(args.platforms)
    ? args.platforms.map((p) => String(p).toLowerCase().trim()).filter(Boolean)
    : [];
  const scheduledAt = new Date(String(args.scheduled_at || ""));

  if (!caption) return { output: "Rejected: caption is required." };
  if (!platforms.length) return { output: "Rejected: at least one platform is required." };
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
    return { output: "Rejected: scheduled_at must be a valid future ISO datetime." };
  }

  // Validate against what is actually connected, so the model can't schedule
  // to a platform the business doesn't have.
  const { data: accounts, error: accountsError } = await context.admin
    .from("social_accounts")
    .select("platform")
    .eq("user_id", context.userId)
    .eq("is_active", true);
  if (accountsError) throw accountsError;
  const connected = new Set((accounts || []).map((account: any) => account.platform));
  const unknown = platforms.filter((platform) => !connected.has(platform));
  if (unknown.length) {
    return {
      output: `Rejected: no active connected account for: ${unknown.join(", ")}. Connected platforms: ${[...connected].join(", ") || "(none)"}.`,
    };
  }

  if (context.dryRun) {
    return {
      output: `(test mode — nothing created) Would schedule: "${caption.slice(0, 120)}" to ${platforms.join(", ")} at ${scheduledAt.toISOString()}.`,
    };
  }

  // Same minimal shape the in-app BulkScheduler inserts; the
  // process-scheduled-posts cron publishes it at the scheduled time.
  const { data: post, error } = await context.admin
    .from("posts")
    .insert({
      user_id: context.userId,
      caption,
      platforms,
      scheduled_at: scheduledAt.toISOString(),
      status: "pending",
      metadata: { created_by: "ai_agent_admin_tool" },
    })
    .select("id")
    .single();
  if (error) throw error;
  return {
    output: `Scheduled post ${post.id}: "${caption.slice(0, 120)}" to ${platforms.join(", ")} at ${scheduledAt.toISOString()}.`,
  };
}

export async function executeAdminTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  if (name === "list_connected_accounts") return listConnectedAccounts(context);
  if (name === "search_posts") return searchPosts(context, args);
  if (name === "get_posting_summary") return getPostingSummary(context, args);
  if (name === "create_scheduled_post") return createScheduledPost(context, args);
  return null;
}
