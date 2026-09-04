// ARCHITECTURE.md §4 forbids `domain -> Supabase`, and no other feature's domain imports the
// generated types. The row shape is declared here; infrastructure asserts it against
// Tables<"social_contacts"> so a schema change still breaks the build.
export interface SocialContact {
  id: string;
  user_id: string;
  workspace_id: string | null;
  social_account_id: string | null;
  platform: string;
  platform_user_id: string;
  identity_kind: string;
  display_name: string;
  username: string | null;
  profile_url: string | null;
  email: string | null;
  phone_number: string | null;
  company: string | null;
  notes: string | null;
  source: string;
  tags: string[];
  whatsapp_contact_id: string | null;
  total_comments_count: number;
  first_interacted_at: string;
  last_interacted_at: string;
  last_comment_text: string | null;
  last_post_id: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

export type ContactPlatform = "facebook" | "instagram" | "threads" | "youtube";
export type ContactSource = "organic_comment" | "workflow_lead";

export interface ContactFilters {
  search: string;
  platform: ContactPlatform | "all";
  source: ContactSource | "all";
  tags: string[];
}

export const EMPTY_FILTERS: ContactFilters = { search: "", platform: "all", source: "all", tags: [] };

export function contactLabel(row: Pick<SocialContact, "display_name" | "username" | "platform_user_id">): string {
  return row.display_name || row.username || row.platform_user_id;
}

// Every column except metadata, which the spec excludes as an internal blob.
const CSV_COLUMNS = [
  "id", "platform", "platform_user_id", "identity_kind", "display_name", "username", "profile_url",
  "email", "phone_number", "company", "notes", "source", "tags", "total_comments_count",
  "first_interacted_at", "last_interacted_at", "last_comment_text", "last_post_id",
  "social_account_id", "whatsapp_contact_id", "workspace_id", "user_id", "created_at", "updated_at",
] as const;

// A display name or comment is whatever a stranger typed on a social platform, and a cell that
// starts with one of these is a formula to Excel, Numbers and Sheets alike. Quoting stops the
// value breaking the CSV grammar; it does nothing to stop the spreadsheet evaluating it. The
// leading apostrophe is the standard neutraliser and is not shown as part of the value.
function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function csvCell(value: unknown, guardFormulas = false): string {
  if (value === null || value === undefined) return "";
  const raw = Array.isArray(value) ? value.join("|") : String(value);
  const text = guardFormulas ? neutralizeFormula(raw) : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildContactsCsv(rows: SocialContact[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c], true)).join(","));
  return lines.join("\r\n");
}

// Header names Meta accepts for a customer list, recorded from its customer-list formatting guidance
// (https://www.facebook.com/business/help/2082575038703844): a row must carry at least one of
// email, phone, madid, appuid or pageuid. `pageuid` is a page-scoped user id — meaningful only to
// the Facebook page that issued it — so it is emitted for platform === "facebook" rows only.
const META_AUDIENCE_COLUMNS = ["email", "phone", "fn", "ln", "pageuid"] as const;

function stripNamePunctuation(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function buildMetaAudienceCsv(rows: SocialContact[]): string {
  const lines = [META_AUDIENCE_COLUMNS.join(",")];
  for (const row of rows) {
    const email = row.email?.trim().toLowerCase() ?? "";
    const phone = row.phone_number ?? "";
    const pageuid = row.platform === "facebook" ? row.platform_user_id : "";
    // No identifier Meta can match: nothing to hash on their side, so the row is dropped.
    if (!email && !phone && !pageuid) continue;
    // Meta matches on the name itself, so trailing punctuation from a display
    // name like "Dana, KW" would be hashed into the identifier and never match.
    const [first = "", ...rest] = row.display_name.trim().split(/\s+/).map(stripNamePunctuation);
    // Deliberately NOT formula-guarded: this file is uploaded to Meta for hashing and matching,
    // never opened in a spreadsheet, and a prepended apostrophe would change the hash.
    lines.push([email, phone, first, rest.filter(Boolean).join(" "), pageuid].map((v) => csvCell(v)).join(","));
  }
  return lines.join("\r\n");
}
