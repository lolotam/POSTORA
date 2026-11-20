// system_logs.category is constrained by the `system_logs_category_check`
// CHECK constraint in the database to exactly these values. Refusal log rows
// for OAuth functions use "auth": "oauth" is not an allowed category and any
// insert carrying it is rejected by the constraint.
export const ALLOWED_SYSTEM_LOG_CATEGORIES = [
  "auth",
  "edge",
  "database",
  "token",
  "post",
  "system",
  "ai",
  "scheduler",
  "webhook",
  "payment",
  "media",
] as const;

export type SystemLogCategory = (typeof ALLOWED_SYSTEM_LOG_CATEGORIES)[number];

export function buildRefusalLogRow({ action, reason, userId }: {
  action: string;
  reason: string;
  userId: string | null;
}): {
  level: "warn";
  category: SystemLogCategory;
  source: "youtube-oauth";
  message: string;
  user_id: string | null;
  metadata: { action: string; reason: string };
} {
  return {
    level: "warn",
    category: "auth",
    source: "youtube-oauth",
    message: "YouTube OAuth request refused",
    user_id: userId,
    metadata: { action, reason },
  };
}
