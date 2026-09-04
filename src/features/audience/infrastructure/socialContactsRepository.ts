import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import type { ContactFilters, SocialContact } from "../domain/socialContact";

// Compile-time proof that the hand-declared domain row still matches the generated schema.
type AssertRowShape = Tables<"social_contacts"> extends SocialContact ? true : never;
const _rowShapeOk: AssertRowShape = true;
void _rowShapeOk;

export const CONTACTS_PAGE_SIZE = 50;
const EXPORT_PAGE = 200;
const EXPORT_CAP = 5000;

export interface ContactsPage { rows: SocialContact[]; total: number; }
export interface ContactStats { total: number; workflow_leads: number; enriched: number; top_platform: string | null; }
export type ContactPatch = Partial<Pick<SocialContact, "display_name" | "email" | "phone_number" | "company" | "notes" | "tags" | "whatsapp_contact_id">>;

// `contact` arrives as jsonb: the composite return form segfaults PostgreSQL 17.6.
interface SearchRow { row_count: number; contact: SocialContact; }

function searchArgs(filters: ContactFilters, limit: number, offset: number) {
  return {
    p_query: filters.search.trim() || null,
    p_platform: filters.platform === "all" ? null : filters.platform,
    p_source: filters.source === "all" ? null : filters.source,
    p_tags: filters.tags.length > 0 ? filters.tags : null,
    p_limit: limit,
    p_offset: offset,
  };
}

async function search(filters: ContactFilters, limit: number, offset: number): Promise<ContactsPage> {
  const { data, error } = await supabase.rpc("search_social_contacts", searchArgs(filters, limit, offset));
  if (error) throw error;
  // The generated rpc type widens the jsonb contact to Json; the double cast is the
  // one place the RPC's real shape is asserted rather than inferred.
  const rows = (data ?? []) as unknown as SearchRow[];
  return { rows: rows.map((r) => r.contact), total: rows[0]?.row_count ?? 0 };
}

export function listContacts(filters: ContactFilters, page: number): Promise<ContactsPage> {
  return search(filters, CONTACTS_PAGE_SIZE, page * CONTACTS_PAGE_SIZE);
}

export interface ContactExport {
  rows: SocialContact[];
  /** True when the filter matched more rows than EXPORT_CAP. The caller must say
   *  so: a silently short file looks exactly like a complete one. */
  truncated: boolean;
  cap: number;
}

export async function fetchAllContacts(filters: ContactFilters): Promise<ContactExport> {
  const all: SocialContact[] = [];
  let truncated = false;
  for (let offset = 0; offset < EXPORT_CAP; offset += EXPORT_PAGE) {
    const { rows, total } = await search(filters, EXPORT_PAGE, offset);
    all.push(...rows);
    if (rows.length < EXPORT_PAGE) break;
    if (all.length >= EXPORT_CAP) {
      truncated = total > all.length;
      break;
    }
  }
  return { rows: all, truncated, cap: EXPORT_CAP };
}

export async function fetchContactStats(): Promise<ContactStats> {
  const { data, error } = await supabase.rpc("get_social_contacts_stats");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;   // set-returning RPC arrives as an array
  return {
    total: Number(row?.total ?? 0),
    workflow_leads: Number(row?.workflow_leads ?? 0),
    enriched: Number(row?.enriched ?? 0),
    top_platform: row?.top_platform ?? null,
  };
}

const TAG_PAGE = 1000;

/** Every tag the caller has. The filter offers no free-text entry, so a tag missed
 *  here cannot be selected at all -- which is why this pages to exhaustion rather
 *  than stopping at a round number.
 *
 *  Scoped to `userId` explicitly: unlike the search and stats RPCs, which filter on
 *  auth.uid() inside the function, this is a direct table read, and the table's
 *  admin SELECT policy admits every tenant's rows. Without the predicate an admin
 *  would see other people's tag labels and get chips that match nothing. */
export async function fetchDistinctTags(userId: string): Promise<string[]> {
  const set = new Set<string>();
  for (let from = 0; ; from += TAG_PAGE) {
    const { data, error } = await supabase
      .from("social_contacts")
      .select("tags")
      .eq("user_id", userId)
      .not("tags", "eq", "{}")
      .range(from, from + TAG_PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) for (const tag of row.tags ?? []) set.add(tag);
    if (rows.length < TAG_PAGE) break;
  }
  return [...set].sort();
}

export async function updateContact(id: string, patch: ContactPatch): Promise<void> {
  const { error } = await supabase.from("social_contacts").update(patch).eq("id", id);
  if (error) throw error;
}

export interface WhatsAppContactMatch { id: string; display_name: string | null; }

/** Finds the caller's WhatsApp contact with the same digits-only phone
 *  (whatsapp_contacts.phone_number is stored digits-only, the same
 *  normalisation the drawer applies to social_contacts.phone_number).
 *
 *  Scoped to `userId` explicitly: whatsapp_contacts has an admin SELECT
 *  policy, so a direct table read is not caller-scoped on its own -- same
 *  reason as fetchDistinctTags. */
export async function findWhatsAppContactByPhone(
  userId: string,
  phone: string,
): Promise<WhatsAppContactMatch | null> {
  const { data, error } = await supabase
    .from("whatsapp_contacts")
    .select("id, display_name")
    .eq("user_id", userId)
    .eq("phone_number", phone)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as WhatsAppContactMatch | null;
}

export async function deleteContact(id: string): Promise<void> {
  const { error } = await supabase.from("social_contacts").delete().eq("id", id);
  if (error) throw error;
}

export interface GoogleSheetsConnection { id: string; external_account_label: string | null; }

/** The caller's active google_sheets connections across every workspace they
 *  belong to; RLS on connector_connections already scopes the rows. */
export async function listGoogleSheetsConnections(): Promise<GoogleSheetsConnection[]> {
  const { data, error } = await supabase
    .from("connector_connections")
    .select("id, external_account_label")
    .eq("connector_type", "google_sheets")
    .eq("status", "active");
  if (error) throw error;
  return (data ?? []) as GoogleSheetsConnection[];
}

export interface SheetsSyncInput {
  connection_id: string;
  spreadsheet_id: string;
  sheet_name: string;
  contact_ids: string[];
}

/** Appends the given contacts through the audience-sheets-sync edge function
 *  under the caller's own JWT, and answers how many rows were appended. */
export async function syncContactsToSheet(input: SheetsSyncInput): Promise<number> {
  const { data, error } = await supabase.functions.invoke<{ ok: boolean; appended?: number; error?: string }>(
    "audience-sheets-sync",
    { body: input },
  );
  if (error) throw error;
  if (!data || data.ok !== true) throw new Error(data?.error ?? "sheets_sync_failed");
  return data.appended ?? 0;
}

export interface SpreadsheetInfoInput {
  connection_id: string;
  spreadsheet_id: string;
}

export interface SpreadsheetInfo {
  spreadsheet_title: string | null;
  sheets: string[];
}

/** Validates a pasted spreadsheet id and returns its real tabs, so the dialog
 *  can offer titles that actually exist. A failed lookup throws (the error
 *  code from the edge function) and must never render as "no tabs". */
export async function fetchSpreadsheetInfo(input: SpreadsheetInfoInput): Promise<SpreadsheetInfo> {
  const { data, error } = await supabase.functions.invoke<
    { ok: boolean; spreadsheet_title?: string | null; sheets?: string[]; error?: string }
  >("audience-sheets-sync", {
    body: { operation: "get_spreadsheet_info", connection_id: input.connection_id, spreadsheet_id: input.spreadsheet_id },
  });
  if (error) throw error;
  if (!data || data.ok !== true) throw new Error(data?.error ?? "sheets_lookup_failed");
  return { spreadsheet_title: data.spreadsheet_title ?? null, sheets: data.sheets ?? [] };
}
