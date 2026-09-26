// The WhatsApp intent-label policy and writer. Which intent earns which label
// is this function's own policy, so it lives beside ai-agent-reply rather than
// in _shared (ARCHITECTURE §§5/40). Labels are advisory: a failure here must
// never delay or change what the customer receives.
import { TRIAGE_CONFIDENCE, type Intent, type TriageAnswers } from "../_shared/agentTriage.ts";

/** "other" is deliberately absent: it never earns a label. */
export const INTENT_LABELS: Record<Exclude<Intent, "other">, { name: string; color: string }> = {
  pricing: { name: "Pricing", color: "#3b82f6" },
  order_status: { name: "Order status", color: "#8b5cf6" },
  complaint: { name: "Complaint", color: "#ef4444" },
  lead: { name: "Lead", color: "#22c55e" },
  booking: { name: "Booking", color: "#f59e0b" },
  greeting: { name: "Greeting", color: "#94a3b8" },
};

/** The label a confident, non-"other" intent earns; null means label nothing. */
export function intentLabelFor(answers: TriageAnswers | null): { name: string; color: string } | null {
  const intent = answers?.intent;
  if (!intent || intent.confidence < TRIAGE_CONFIDENCE) return null;
  return INTENT_LABELS[intent.choice as Exclude<Intent, "other">] ?? null;
}

/**
 * Labels apply only to a real WhatsApp send that THIS invocation delivered.
 * A redelivered reply is not labelled: its intent belonged to the invocation
 * that crashed, and losing the label is accepted (labels are advisory).
 */
export function shouldLabel(input: { platform: string; dryRun: boolean; freshDelivery: boolean }): boolean {
  return input.platform === "whatsapp" && !input.dryRun && input.freshDelivery;
}

type DbError = { message: string } | null;
type DbResult = { data: unknown; error: DbError };
interface LabelQuery extends PromiseLike<DbResult> {
  eq(column: string, value: string): LabelQuery;
  order(column: string, options: { ascending: boolean }): LabelQuery;
  limit(count: number): LabelQuery;
  select(columns: string): LabelQuery;
  single(): PromiseLike<DbResult>;
  maybeSingle(): PromiseLike<DbResult>;
}
/** The slice of a service-role Supabase client the writer needs. */
export interface LabelDb {
  from(table: string): {
    select(columns: string): LabelQuery;
    insert(values: unknown): LabelQuery;
    upsert(
      values: unknown,
      options: { onConflict: string; ignoreDuplicates: boolean },
    ): PromiseLike<{ error: DbError }>;
  };
}

/**
 * Creates the named label for this user when absent (oldest row wins when
 * duplicates exist, so they converge), then assigns it to the conversation.
 * Throws on a database error; the message names only the failed step, never
 * row data, so it is safe to log at the call site.
 */
export async function applyIntentLabel(
  db: LabelDb,
  userId: string,
  conversationId: string,
  label: { name: string; color: string },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      writeIntentLabel(db, userId, conversationId, label),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Intent label write timed out");
          error.name = "TimeoutError";
          reject(error);
        }, 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeIntentLabel(
  db: LabelDb,
  userId: string,
  conversationId: string,
  label: { name: string; color: string },
): Promise<void> {
  const { data: existing, error: selectError } = await db
    .from("whatsapp_conversation_labels")
    .select("id")
    .eq("user_id", userId)
    .eq("name", label.name)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (selectError) throw new Error("whatsapp_conversation_labels read failed");

  let labelId = (existing as { id?: unknown } | null)?.id;
  if (typeof labelId !== "string") {
    const { data: created, error: insertError } = await db
      .from("whatsapp_conversation_labels")
      .insert({ user_id: userId, name: label.name, color: label.color })
      .select("id")
      .single();
    if (insertError) throw new Error("whatsapp_conversation_labels insert failed");
    labelId = (created as { id?: unknown } | null)?.id;
    if (typeof labelId !== "string") throw new Error("whatsapp_conversation_labels insert returned no id");
  }

  const { error: assignmentError } = await db
    .from("whatsapp_conversation_label_assignments")
    .upsert(
      { user_id: userId, conversation_id: conversationId, label_id: labelId },
      { onConflict: "conversation_id,label_id", ignoreDuplicates: true },
    );
  if (assignmentError) throw new Error("whatsapp_conversation_label_assignments upsert failed");
}
