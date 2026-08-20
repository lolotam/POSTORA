export async function checkByoGenerationLimits(db: { from: (table: string) => any }, userId: string): Promise<{ allowed: true } | { allowed: false; error: string }> {
  const hour = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const [{ count: recent }, { count: running }] = await Promise.all([
    db.from("ai_generation_jobs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("credential_source", "byo").gte("created_at", hour),
    db.from("ai_generation_jobs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("credential_source", "byo").in("status", ["queued", "running"]),
  ]);
  if ((recent ?? 0) >= 10) return { allowed: false, error: "BYO generation hourly limit reached" };
  if ((running ?? 0) >= 2) return { allowed: false, error: "Too many concurrent generations" };
  return { allowed: true };
}
