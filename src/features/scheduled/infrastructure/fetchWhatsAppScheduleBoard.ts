import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { ScheduledWhatsAppSource } from "../domain/scheduledBoard";
import {
  ACTIVE_WHATSAPP_STATUSES,
  CALENDAR_WHATSAPP_STATUSES,
  WHATSAPP_RANGE_LIMIT,
} from "../domain/whatsAppSchedule";

type ScheduleRow = Database["public"]["Tables"]["whatsapp_scheduled_messages"]["Row"];

export type WhatsAppScheduleScope =
  | { kind: "active" }
  | { kind: "range"; rangeStart: string; rangeEnd: string };

export interface WhatsAppScheduleBoard {
  messages: ScheduledWhatsAppSource[];
  truncated: boolean;
}

interface AccountLabel {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
}

const ACCOUNT_ID_CHUNK = 50;

/** `media_filename` arrives with PR C. `select("*")` returns it once that column exists. */
function readMediaFilename(row: ScheduleRow): string | null {
  const filename = (row as ScheduleRow & { media_filename?: unknown }).media_filename;
  return typeof filename === "string" ? filename : null;
}

async function fetchActiveRows(userId: string): Promise<ScheduleRow[]> {
  const { data, error } = await supabase
    .from("whatsapp_scheduled_messages")
    .select("*")
    .eq("user_id", userId)
    .in("status", [...ACTIVE_WHATSAPP_STATUSES])
    .order("scheduled_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function fetchRangeRows(userId: string, rangeStart: string, rangeEnd: string): Promise<ScheduleRow[]> {
  const { data, error } = await supabase
    .from("whatsapp_scheduled_messages")
    .select("*")
    .eq("user_id", userId)
    .in("status", [...CALENDAR_WHATSAPP_STATUSES])
    .gte("scheduled_at", rangeStart)
    .lte("scheduled_at", rangeEnd)
    .order("scheduled_at", { ascending: true })
    .limit(WHATSAPP_RANGE_LIMIT);
  if (error) throw error;
  return data ?? [];
}

async function fetchAccountLabels(userId: string, accountIds: string[]): Promise<Map<string, AccountLabel>> {
  const labels = new Map<string, AccountLabel>();
  for (let index = 0; index < accountIds.length; index += ACCOUNT_ID_CHUNK) {
    const chunk = accountIds.slice(index, index + ACCOUNT_ID_CHUNK);
    const { data, error } = await supabase
      .from("social_accounts")
      .select("id, platform_username, avatar_url, connection_mode")
      .eq("user_id", userId)
      .in("id", chunk);
    if (error) throw error;
    for (const row of data ?? []) labels.set(row.id, row);
  }
  return labels;
}

function toSource(row: ScheduleRow, account: AccountLabel | undefined): ScheduledWhatsAppSource {
  return {
    id: row.id,
    recipient_phone: row.recipient_phone,
    recipient_name: row.recipient_name,
    message_text: row.message_text,
    media_url: row.media_url,
    media_type: row.media_type,
    media_filename: readMediaFilename(row),
    scheduled_at: row.scheduled_at,
    status: row.status,
    account_name: account?.platform_username ?? null,
    avatar_url: account?.avatar_url ?? null,
  };
}

export async function fetchWhatsAppScheduleBoard(
  userId: string,
  scope: WhatsAppScheduleScope,
): Promise<WhatsAppScheduleBoard> {
  const rows = scope.kind === "active"
    ? await fetchActiveRows(userId)
    : await fetchRangeRows(userId, scope.rangeStart, scope.rangeEnd);
  const accountIds = [...new Set(rows.map((row) => row.social_account_id))];
  const accounts = await fetchAccountLabels(userId, accountIds);
  return {
    messages: rows.map((row) => toSource(row, accounts.get(row.social_account_id))),
    truncated: scope.kind === "range" && rows.length >= WHATSAPP_RANGE_LIMIT,
  };
}
