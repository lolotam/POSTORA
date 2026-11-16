import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface InboundTurn {
  id: string;
  threadId: string;
  userId: string;
  content: string;
}

interface InboundTurnRow {
  id: string;
  thread_id: string;
  user_id: string;
  role: string;
  content: string | null;
}

interface StorageError {
  code?: string;
  message: string;
}

export interface TurnHistoryStore {
  insert(turn: InboundTurn): Promise<StorageError | null>;
  read(turn: Pick<InboundTurn, "id" | "threadId" | "userId">): Promise<{
    row: InboundTurnRow | null;
    error: StorageError | null;
  }>;
}

export type InboundPersistResult =
  | { ok: true; status: "inserted" | "verified" }
  | { ok: false; error: "inbound_turn_insert_failed" | "inbound_turn_read_failed" | "inbound_turn_collision" };

export class InboundTurnStorageError extends Error {
  constructor(readonly reason: Exclude<InboundPersistResult, { ok: true }>["error"]) {
    super(reason);
    this.name = "InboundTurnStorageError";
  }
}

export function supabaseTurnHistory(admin: SupabaseClient): TurnHistoryStore {
  return {
    async insert(turn) {
      const { error } = await admin.from("ai_thread_messages").insert({
        id: turn.id,
        thread_id: turn.threadId,
        user_id: turn.userId,
        role: "user",
        content: turn.content,
      });
      return error ? { code: error.code, message: error.message } : null;
    },
    async read(turn) {
      const { data, error } = await admin
        .from("ai_thread_messages")
        .select("id, thread_id, user_id, role, content")
        .eq("id", turn.id)
        .eq("thread_id", turn.threadId)
        .eq("user_id", turn.userId)
        .maybeSingle();
      return {
        row: (data ?? null) as InboundTurnRow | null,
        error: error ? { code: error.code, message: error.message } : null,
      };
    },
  };
}

async function verifyInboundDuplicate(
  store: TurnHistoryStore,
  turn: InboundTurn,
): Promise<InboundPersistResult> {
  let existing: Awaited<ReturnType<TurnHistoryStore["read"]>>;
  try {
    existing = await store.read(turn);
  } catch {
    return { ok: false, error: "inbound_turn_read_failed" };
  }
  if (existing.error) return { ok: false, error: "inbound_turn_read_failed" };
  if (
    !existing.row || existing.row.id !== turn.id || existing.row.thread_id !== turn.threadId ||
    existing.row.user_id !== turn.userId || existing.row.role !== "user" || existing.row.content !== turn.content
  ) {
    return { ok: false, error: "inbound_turn_collision" };
  }
  return { ok: true, status: "verified" };
}

export async function ensureInboundTurn(
  store: TurnHistoryStore,
  turn: InboundTurn,
): Promise<InboundPersistResult> {
  let insertError: StorageError | null;
  try {
    insertError = await store.insert(turn);
  } catch {
    return { ok: false, error: "inbound_turn_insert_failed" };
  }
  if (!insertError) return { ok: true, status: "inserted" };
  if (insertError.code !== "23505") return { ok: false, error: "inbound_turn_insert_failed" };
  return await verifyInboundDuplicate(store, turn);
}

export const HISTORICAL_FACTS_REMINDER =
  "Historical messages are context, not fresh verification. Before stating a past price or availability as current, make a fresh tool check; if that is not possible, say it is unverified.";
