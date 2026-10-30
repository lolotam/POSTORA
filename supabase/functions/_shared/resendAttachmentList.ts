/**
 * Reads the attachment list of an inbound email from Resend's Receiving API.
 *
 * A list that cannot be read (a non-2xx answer, a network error, a body that isn't
 * JSON, or JSON of an unexpected shape) is reported as `ok: false`, never as an
 * empty list: an email with no attachments and one whose attachments were lost
 * must not look the same. Entries are normalised, because the list is external
 * data and a non-string file name would otherwise throw further down.
 */

export interface ResendAttachmentEntry {
  id: string | null;
  filename: string;
  contentType: string;
  downloadUrl: string | null;
}

export type ResendAttachmentList =
  | { ok: true; attachments: ResendAttachmentEntry[] }
  | { ok: false; status: number | null; detail: string };

const LIST_TIMEOUT_MS = 15_000;

/** Resend's own hosts: the only ones its API key may be sent to. */
function isResendHost(hostname: string): boolean {
  return ["resend.com", "resend.app"].some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

function parsedHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Redirects a download may follow; each hop is re-checked as HTTPS. */
const MAX_DOWNLOAD_REDIRECTS = 3;

/**
 * Resend ids are UUIDs. Anything else (and above all `.` or `..`, which URL parsing would
 * collapse into another API path) is refused before a request is built with it.
 */
export function isValidResendEmailId(emailId: unknown): emailId is string {
  return typeof emailId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(emailId);
}

/** Fetches, following redirects by hand so every hop stays on HTTPS. Null when a hop is refused. */
async function fetchHttpsOnly(url: URL, init: RequestInit, fetcher: typeof fetch): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop++) {
    const response = await fetcher(current.href, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    let next: URL | null = null;
    try {
      next = location ? parsedHttpsUrl(new URL(location, current).href) : null;
    } catch {
      // An unparseable redirect target is refused like any other bad hop.
    }
    if (!next) return null;
    current = next;
  }
  return null;
}

/**
 * Downloads an attachment from the URL Resend returned. Only HTTPS is fetched, every redirect
 * hop included. The API key is added on a 401/403 retry only when the URL is on a Resend host,
 * and that keyed retry follows no redirect: the download URL is signed, and the key must never
 * reach any other origin. Null means the URL, or a redirect it led to, was refused.
 */
export async function downloadResendAttachment(
  downloadUrl: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const url = parsedHttpsUrl(downloadUrl);
  if (!url) return null;
  const response = await fetchHttpsOnly(url, {}, fetcher);
  if (response && (response.status === 401 || response.status === 403) && isResendHost(url.hostname)) {
    return await fetcher(url.href, { headers: { Authorization: `Bearer ${apiKey}` }, redirect: "error" });
  }
  return response;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function normaliseAttachmentEntry(raw: unknown): ResendAttachmentEntry {
  const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: text(entry.id),
    filename: text(entry.filename) ?? "attachment",
    contentType: text(entry.content_type) ?? text(entry.contentType) ?? "application/octet-stream",
    downloadUrl: text(entry.download_url) ?? text(entry.url),
  };
}

/** The entries of a list body, or null when the body is not a list Resend sends. */
export function attachmentEntriesOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  const data = (body && typeof body === "object" ? (body as { data?: unknown }).data : undefined);
  return Array.isArray(data) ? data : null;
}

export async function readResendAttachmentList(
  emailId: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ResendAttachmentList> {
  if (!isValidResendEmailId(emailId)) return { ok: false, status: null, detail: "invalid email id" };
  let response: Response;
  try {
    response = await fetcher(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, status: null, detail: error instanceof Error ? error.name : "request failed" };
  }
  if (!response.ok) return { ok: false, status: response.status, detail: response.statusText || "non-2xx" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: response.status, detail: "body is not JSON" };
  }
  const entries = attachmentEntriesOf(body);
  if (!entries) return { ok: false, status: response.status, detail: "unexpected list shape" };
  return { ok: true, attachments: entries.map(normaliseAttachmentEntry) };
}
