import { z } from "https://esm.sh/zod@3.25.76";
import { analyticsWindowForPeriod, closedAnalyticsPeriods, type AnalyticsPeriod, type AnalyticsPeriodDays } from "../_shared/analyticsCalendar.ts";
import { ANALYTICS_PLATFORM_CONFIGURATION } from "../_shared/analyticsRegistry.ts";
import { PersistedReportRefused } from "./store.ts";

export type StoredReportScope = { platform: "facebook" | "threads"; ownerId: string; accountId: string; days: AnalyticsPeriodDays };
const payloadSchema = z.object({ version: z.literal(1), platform: z.enum(["facebook", "threads"]), ownerId: z.string().uuid(), accountId: z.string().uuid(),
  period: z.object({ days: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)]), since: z.string().datetime(), until: z.string().datetime(), timezone: z.string() }).strict(),
  revision: z.number().int().positive().safe(), publishedAt: z.string().datetime({ offset: true }), postId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/) }).strict();
type StoredPosition = z.infer<typeof payloadSchema>;

function encoded(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function decoded(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new PersistedReportRefused("invalid_cursor", 400);
  try { return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0)); }
  catch { throw new PersistedReportRefused("invalid_cursor", 400); }
}
async function signingKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new PersistedReportRefused("storage_unavailable", 503);
  return await crypto.subtle.importKey("raw", new TextEncoder().encode(`postora:owned-analytics-history:v1:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function storedReportPosition(input: { cursor: string | null; scope: StoredReportScope; secret: string; now: string }): Promise<{
  windows: ReturnType<typeof closedAnalyticsPeriods>; after: StoredPosition | null;
}> {
  const timezone = ANALYTICS_PLATFORM_CONFIGURATION[input.scope.platform].providerBucketTimezone!;
  if (input.cursor === null) return { windows: closedAnalyticsPeriods({ now: input.now, days: input.scope.days, timezone }), after: null };
  if (input.cursor.length > 16384) throw new PersistedReportRefused("invalid_cursor", 400);
  const parts = input.cursor.split(".");
  if (parts.length !== 2) throw new PersistedReportRefused("invalid_cursor", 400);
  const body = decoded(parts[0]);
  if (!await crypto.subtle.verify("HMAC", await signingKey(input.secret), decoded(parts[1]), body)) throw new PersistedReportRefused("invalid_cursor", 400);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { throw new PersistedReportRefused("invalid_cursor", 400); }
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.platform !== input.scope.platform || parsed.data.ownerId !== input.scope.ownerId.toLowerCase()
    || parsed.data.accountId !== input.scope.accountId.toLowerCase() || parsed.data.period.days !== input.scope.days
    || parsed.data.period.timezone !== timezone || Date.parse(parsed.data.period.until) > Date.parse(input.now)) throw new PersistedReportRefused("invalid_cursor", 400);
  try { analyticsWindowForPeriod(parsed.data.period); } catch { throw new PersistedReportRefused("invalid_cursor", 400); }
  const windows = closedAnalyticsPeriods({ now: parsed.data.period.until, days: input.scope.days, timezone });
  if (windows.current.period.since !== parsed.data.period.since) throw new PersistedReportRefused("invalid_cursor", 400);
  return { windows, after: parsed.data };
}

export async function storedReportCursor(input: { scope: StoredReportScope; period: AnalyticsPeriod; revision: number; publishedAt: string; postId: string; secret: string }): Promise<string> {
  const payload = payloadSchema.parse({ version: 1, platform: input.scope.platform, ownerId: input.scope.ownerId.toLowerCase(), accountId: input.scope.accountId.toLowerCase(),
    period: input.period, revision: input.revision, publishedAt: input.publishedAt, postId: input.postId });
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(input.secret), body));
  return `${encoded(body)}.${encoded(signature)}`;
}
