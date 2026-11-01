import { z } from "https://esm.sh/zod@3.25.76";
import type { AnalyticsPeriod } from "../_shared/analyticsCalendar.ts";

const scopeSchema = z.object({
  ownerId: z.string().uuid(), accountId: z.string().uuid(),
  days: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)]),
  since: z.string().datetime(), until: z.string().datetime(), timezone: z.string().min(1).max(100),
}).strict();
const payloadSchema = z.object({
  version: z.literal(1), scope: scopeSchema,
  after: z.string().min(1).max(4096).refine((value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)),
  visited: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(7),
}).strict();
export type AnalyticsCursorScope = z.infer<typeof scopeSchema>;
export type AnalyticsCursorPosition = { after: string | null; visited: string[] };

export class AnalyticsCursorError extends Error {
  constructor() { super("Invalid analytics continuation cursor"); this.name = "AnalyticsCursorError"; }
}

export function analyticsCursorScope(ownerId: string, accountId: string, period: AnalyticsPeriod): AnalyticsCursorScope {
  return { ownerId, accountId, days: period.days, since: period.since, until: period.until, timezone: period.timezone };
}

function encoded(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decoded(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new AnalyticsCursorError();
  try { return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0)); }
  catch (error) { if (error instanceof DOMException) throw new AnalyticsCursorError(); throw error; }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("Analytics cursor signing configuration is unavailable");
  return await crypto.subtle.importKey("raw", new TextEncoder().encode(`postora:threads-analytics:v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function cursorDigest(after: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(after)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function decodeAnalyticsCursor(cursor: string | null, scope: AnalyticsCursorScope, secret: string): Promise<AnalyticsCursorPosition> {
  if (cursor === null) return { after: null, visited: [] };
  if (cursor.length > 16384) throw new AnalyticsCursorError();
  const parts = cursor.split(".");
  if (parts.length !== 2) throw new AnalyticsCursorError();
  const body = decoded(parts[0]);
  const signature = decoded(parts[1]);
  if (!await crypto.subtle.verify("HMAC", await signingKey(secret), signature, body)) throw new AnalyticsCursorError();
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch (error) { if (error instanceof SyntaxError || error instanceof TypeError) throw new AnalyticsCursorError(); throw error; }
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success || (Object.keys(scope) as (keyof AnalyticsCursorScope)[]).some((key) => parsed.data.scope[key] !== scope[key])) {
    throw new AnalyticsCursorError();
  }
  if (new Set(parsed.data.visited).size !== parsed.data.visited.length || !parsed.data.visited.includes(await cursorDigest(parsed.data.after))) {
    throw new AnalyticsCursorError();
  }
  return { after: parsed.data.after, visited: parsed.data.visited };
}

/** The eighth page can be displayed, but cannot issue an unbounded continuation chain. */
export async function encodeAnalyticsCursor(input: {
  after: string; position: AnalyticsCursorPosition; scope: AnalyticsCursorScope; secret: string;
}): Promise<{ cursor: string | null; exhausted: boolean; repeated: boolean }> {
  const digest = await cursorDigest(input.after);
  if (input.position.visited.includes(digest)) return { cursor: null, exhausted: false, repeated: true };
  if (input.position.visited.length >= 7) return { cursor: null, exhausted: true, repeated: false };
  const parsed = payloadSchema.safeParse({ version: 1, scope: input.scope, after: input.after,
    visited: [...input.position.visited, digest] });
  if (!parsed.success) return { cursor: null, exhausted: false, repeated: true };
  const body = new TextEncoder().encode(JSON.stringify(parsed.data));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(input.secret), body));
  return { cursor: `${encoded(body)}.${encoded(signature)}`, exhausted: false, repeated: false };
}
