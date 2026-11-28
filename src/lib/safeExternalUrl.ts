const PLATFORM_POST_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "tiktok.com",
  "www.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com",
  "fb.watch",
  "threads.net",
  "www.threads.net",
  "threads.com",
  "www.threads.com",
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
]);

const TIKTOK_EMBED_HOSTS = new Set(["tiktok.com", "www.tiktok.com"]);
const TIKTOK_EMBED_PATH = /^\/(embed|player)(\/|$)/i;

function parseHttpsUrl(raw: string | null | undefined): URL | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getSafeHttpsUrl(raw: string | null | undefined): string | null {
  const parsed = parseHttpsUrl(raw);
  return parsed ? parsed.href : null;
}

export function getSafePlatformPostUrl(raw: string | null | undefined): string | null {
  const parsed = parseHttpsUrl(raw);
  if (!parsed) return null;
  if (!PLATFORM_POST_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return parsed.href;
}

export function getSafeTikTokEmbedUrl(raw: string | null | undefined): string | null {
  const parsed = parseHttpsUrl(raw);
  if (!parsed) return null;
  if (!TIKTOK_EMBED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (!TIKTOK_EMBED_PATH.test(parsed.pathname)) return null;
  return parsed.href;
}

export function openSafePlatformPostUrl(raw: string | null | undefined): void {
  const safeUrl = getSafePlatformPostUrl(raw);
  if (!safeUrl) return;
  window.open(safeUrl, "_blank", "noopener,noreferrer");
}
