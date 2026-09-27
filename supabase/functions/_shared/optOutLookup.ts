// Shared opt-out read for business-initiated WhatsApp sends.
// A failed read throws: callers must not send when the opt-out set is unknown.
// Log metadata is stripped of phone, token, and secret keys before insert.

const CHUNK = 100;

const UNSAFE_METADATA_KEY = /phone|token|secret|authorization|api[_-]?key|password/i;

export function digitsOnly(phone: string): string {
  return String(phone ?? "").replace(/\D/g, "");
}

// `from` stays loose on purpose: a precise builder type makes `deno check` instantiate
// the Supabase client's generics until it gives up.
export interface OptOutLookupAdmin {
  from(table: string): any;
}

/** Digits-only phones present in messaging_opt_outs for this user. One bounded query per 100 phones. */
export async function optedOutPhones(
  admin: OptOutLookupAdmin,
  userId: string,
  phones: string[],
): Promise<Set<string>> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const phone of phones) {
    const digits = digitsOnly(phone);
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    unique.push(digits);
  }

  const optedOut = new Set<string>();
  for (let start = 0; start < unique.length; start += CHUNK) {
    const chunk = unique.slice(start, start + CHUNK);
    const { data, error } = await admin
      .from("messaging_opt_outs")
      .select("phone")
      .in("phone", chunk)
      .eq("user_id", userId);
    if (error) throw new Error("opt_out_lookup_failed");
    for (const row of data ?? []) {
      if (typeof row.phone === "string" && row.phone) optedOut.add(row.phone);
    }
  }
  return optedOut;
}

export type OptOutRefusalReason = "opted_out" | "opt_out_lookup_failed" | "opt_out_skip_failed";

const REFUSAL_MESSAGES: Record<OptOutRefusalReason, string> = {
  opted_out: "WhatsApp send refused: customer opted out",
  opt_out_lookup_failed: "WhatsApp send refused: opt-out lookup failed",
  opt_out_skip_failed: "WhatsApp send refused: opted-out status could not be saved",
};

export interface SendRefusedInput {
  source: string;
  userId: string;
  reason: OptOutRefusalReason;
  metadata: Record<string, unknown>;
}

function safeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (UNSAFE_METADATA_KEY.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

/** One system_logs row. A failed insert is reported with console.error and otherwise ignored. */
export async function logSendRefused(admin: OptOutLookupAdmin, input: SendRefusedInput): Promise<void> {
  const optedOut = input.reason === "opted_out";
  try {
    const { error } = await admin.from("system_logs").insert({
      level: optedOut ? "info" : "error",
      category: "system",
      source: input.source,
      message: REFUSAL_MESSAGES[input.reason],
      user_id: input.userId,
      metadata: { ...safeMetadata(input.metadata), reason: input.reason },
    });
    if (error) console.error("[opt-out] refusal log insert failed");
  } catch {
    console.error("[opt-out] refusal log insert failed");
  }
}
