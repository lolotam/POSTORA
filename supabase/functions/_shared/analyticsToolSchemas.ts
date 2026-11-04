// Shared strict boundary contracts for the MCP tools and their API routes.
import { z } from "npm:zod@4.1.12";

const accountId = z.string().uuid();
const mediaType = z.enum(["all", "image", "video", "reel", "carousel"]);
const periodDays = z.union([z.literal(1), z.literal(7), z.literal(14), z.literal(30), z.literal(90), z.literal(365), z.literal("all")]);
const cursor = z.string().min(1).max(2048).optional();
const limit = z.number().int().min(1).max(50).optional();
export const accountAnalyticsSchema = z.object({
  social_account_id: accountId, period_days: periodDays.optional(), media_type: mediaType.optional(),
  cursor: z.string().min(1).max(16384).optional(),
}).strict();
export const analyticsSyncSchema = z.object({ social_account_id: accountId }).strict();
export const listCompetitorsSchema = z.object({ state: z.enum(["active", "removed"]).optional(), limit, cursor }).strict();
export function normalizeTrackedHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}
export const trackCompetitorSchema = z.object({
  username: z.string()
    .refine((raw) => { const handle = normalizeTrackedHandle(raw); return /^[a-z0-9._]{1,30}$/.test(handle) && !handle.includes(".."); }, "Use an Instagram handle of 1-30 letters, digits, underscores or periods; no consecutive periods"),
  label: z.string().max(120).optional(),
}).strict();
export const untrackCompetitorSchema = z.object({ watchlist_id: z.string().uuid() }).strict();
export const competitorReportSchema = z.object({
  watchlist_id: z.string().uuid(), period_days: z.union([z.literal(7), z.literal(30)]).optional(), limit, cursor,
}).strict();
export const analyzeBrandSchema = z.object({
  platform: z.enum(["facebook", "instagram"]), handle: z.string().trim().min(1).max(500),
  media_type: mediaType.optional(), period: z.enum(["30d", "3m", "6m", "1y", "all"]).optional(),
  sort: z.enum(["engagement", "likes", "comments", "views", "newest", "oldest", "shares", "saves"]).optional(),
  min_engagement: z.number().finite().nonnegative().optional(),
  offset: z.number().int().min(0).max(125).optional().describe("Instagram: 0-100; Facebook: 0-125 (up to 100 posts plus 25 reels)"),
}).strict();
