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

export async function fetchAllContacts(filters: ContactFilters): Promise<SocialContact[]> {
  const all: SocialContact[] = [];
  for (let offset = 0; offset < EXPORT_CAP; offset += EXPORT_PAGE) {
    const { rows } = await search(filters, EXPORT_PAGE, offset);
    all.push(...rows);
    if (rows.length < EXPORT_PAGE) break;
  }
  return all;
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

export async function fetchDistinctTags(): Promise<string[]> {
  const { data, error } = await supabase.from("social_contacts").select("tags").not("tags", "eq", "{}").limit(1000);
  if (error) throw error;
  const set = new Set<string>();
  for (const row of data ?? []) for (const t of row.tags ?? []) set.add(t);
  return [...set].sort();
}

export async function updateContact(id: string, patch: ContactPatch): Promise<void> {
  const { error } = await supabase.from("social_contacts").update(patch).eq("id", id);
  if (error) throw error;
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
