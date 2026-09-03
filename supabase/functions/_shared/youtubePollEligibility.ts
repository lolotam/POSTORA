import { resolveCommentAutomationHandler } from "./automationHandler.ts";
import { youtubeCommentCapability } from "./youtubeCommentCapability.ts";

export interface PollCandidate {
  id: string;
  user_id: string;
  platform_user_id: string | null;
  auth_provider?: string | null;
  account_metadata?: unknown;
}

export interface PollSelection<T> {
  eligible: T[];
  skipped: {
    handler_off: number;
    reconnect_required: number;
    duplicate_channel: number;
  };
}

// Handler-off rows would spend quota to reach a handler that discards the result;
// reconnect_required rows would 403 on every call; and a duplicate channel for one user must
// be read once through Composio, which costs Postora's Google project nothing.
export function selectPollableChannels<T extends PollCandidate>(
  rows: readonly T[],
): PollSelection<T> {
  const skipped = {
    handler_off: 0,
    reconnect_required: 0,
    duplicate_channel: 0,
  };
  const byChannel = new Map<string, T>();

  for (const row of rows) {
    if (!row.platform_user_id) continue;
    if (resolveCommentAutomationHandler(row.account_metadata) === "off") {
      skipped.handler_off += 1;
      continue;
    }
    if (youtubeCommentCapability(row) !== "capable") {
      skipped.reconnect_required += 1;
      continue;
    }

    const key = `${row.user_id}:${row.platform_user_id}`;
    const held = byChannel.get(key);
    if (!held) {
      byChannel.set(key, row);
      continue;
    }
    skipped.duplicate_channel += 1;
    if (row.auth_provider === "composio" && held.auth_provider !== "composio") {
      byChannel.set(key, row);
    }
  }

  return { eligible: [...byChannel.values()], skipped };
}
