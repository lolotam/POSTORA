// Single source of truth for self-hosted Supabase Edge Function URLs.
// Builds: `${VITE_SUPABASE_URL}/functions/v1/<name>`.
//
// Do NOT use VITE_SUPABASE_PROJECT_ID to construct URLs — it's cosmetic only
// on the self-hosted instance.

export function functionsUrl(name: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!base) {
    throw new Error(
      "VITE_SUPABASE_URL is not configured. Set it to your self-hosted Supabase URL (e.g. https://api.postora.cloud)."
    );
  }
  const trimmed = base.replace(/\/+$/, "");
  const clean = name.replace(/^\/+/, "");
  return `${trimmed}/functions/v1/${clean}`;
}

export function functionsBaseUrl(): string {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!base) {
    throw new Error("VITE_SUPABASE_URL is not configured.");
  }
  return `${base.replace(/\/+$/, "")}/functions/v1`;
}
