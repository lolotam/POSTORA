// Sealed references for Stage 4.
//
// A handle, a cursor and a ban confirmation are short-lived integrity-protected
// tokens. They hold the bound context and an HMAC signature, so a client
// cannot fabricate, extend, or cross-bind them. They are NEVER logged.
//
// Prefixes:
//   hdl  a comment handle (thread or reply)
//   cur  a list cursor
//   bnc  a server-issued ban confirmation

import { seal, unseal } from "../../_shared/commentOps.ts";

export const HANDLE_PREFIX = "hdl";
export const CURSOR_PREFIX = "cur";
export const BAN_CONFIRMATION_PREFIX = "bnc";

export interface HandlePayload {
  v: number;
  o: string; // owner id
  a: string; // account id
  g: number; // binding generation
  c: string; // resource channel
  vi: string; // video id
  th: string; // thread id
  co: string; // comment id (top-level comment id)
  k: "thread" | "reply";
  p: string; // canonical parent ("" for a top-level comment)
  au: string; // author channel id ("")
  s: string | null; // observed moderation status
  e: number; // expiry epoch ms
}

export interface CursorPayload {
  v: number;
  o: string;
  a: string;
  g: number;
  vi: string;
  l: "published" | "heldForReview";
  p: string | null; // parent comment id for a reply page
  a2: "video_page" | "thread_page" | "reply_page";
  e: number;
}

export interface BanConfirmationPayload {
  v: number;
  o: string;
  a: string;
  g: number;
  vi: string;
  co: string;
  au: string; // author channel id
  op: string; // operation id
  e: number;
}

export async function sealHandle(
  payload: Omit<HandlePayload, "v" | "e">,
  deps: { signingSecret: string; now: number; ttlMs: number },
): Promise<string> {
  const full: HandlePayload = {
    v: 1,
    ...payload,
    e: deps.now + deps.ttlMs,
  };
  return await seal(HANDLE_PREFIX, full, { signingSecret: deps.signingSecret });
}

export async function unsealHandle(
  token: string,
  deps: { signingSecret: string; now: number },
): Promise<HandlePayload | null> {
  const payload = await unseal<HandlePayload>(HANDLE_PREFIX, token, {
    signingSecret: deps.signingSecret,
  });
  if (!payload) return null;
  if (payload.v !== 1) return null;
  if (payload.e < deps.now) return null;
  if (!payload.o || !payload.a || !payload.co || !payload.th || !payload.vi) return null;
  return payload;
}

export async function sealCursor(
  payload: Omit<CursorPayload, "v" | "e">,
  deps: { signingSecret: string; now: number; ttlMs: number },
): Promise<string> {
  const full: CursorPayload = { v: 1, ...payload, e: deps.now + deps.ttlMs };
  return await seal(CURSOR_PREFIX, full, { signingSecret: deps.signingSecret });
}

export async function unsealCursor(
  token: string,
  deps: { signingSecret: string; now: number },
): Promise<CursorPayload | null> {
  const payload = await unseal<CursorPayload>(CURSOR_PREFIX, token, {
    signingSecret: deps.signingSecret,
  });
  if (!payload) return null;
  if (payload.v !== 1) return null;
  if (payload.e < deps.now) return null;
  return payload;
}

export async function sealBanConfirmation(
  payload: Omit<BanConfirmationPayload, "v" | "e">,
  deps: { signingSecret: string; now: number; ttlMs: number },
): Promise<string> {
  const full: BanConfirmationPayload = { v: 1, ...payload, e: deps.now + deps.ttlMs };
  return await seal(BAN_CONFIRMATION_PREFIX, full, { signingSecret: deps.signingSecret });
}

export async function unsealBanConfirmation(
  token: string,
  deps: { signingSecret: string; now: number },
): Promise<BanConfirmationPayload | null> {
  const payload = await unseal<BanConfirmationPayload>(BAN_CONFIRMATION_PREFIX, token, {
    signingSecret: deps.signingSecret,
  });
  if (!payload) return null;
  if (payload.v !== 1) return null;
  if (payload.e < deps.now) return null;
  return payload;
}

export const HANDLE_TTL_MS = 30 * 60 * 1000;
export const CURSOR_TTL_MS = 30 * 60 * 1000;
export const BAN_CONFIRMATION_TTL_MS = 120 * 1000;
