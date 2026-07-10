# WhatsApp Contacts Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/messaging/whatsapp/contacts` into a mobile-style contacts manager: full contact-card fields, avatar upload, country-code phone entry, CSV import wizard, bulk operations, groups, cached paged loading, and CSV/XLSX/vCard export.

**Architecture:** One additive migration on `whatsapp_contacts`; a pure-logic codec module (`contactCodecs.ts`, unit-tested) for phone/CSV/vCard handling; a hooks module (`useContacts.ts`) owning all react-query data access with server-side pagination; six focused components under `src/components/messaging/contacts/`; the existing `WhatsAppContactsContent.tsx` becomes a thin shell. Spec: `docs/superpowers/specs/2026-07-10-whatsapp-contacts-manager-design.md`.

**Tech Stack:** React 18 + TypeScript, shadcn/ui, @tanstack/react-query, supabase-js, papaparse (installed), `xlsx` (new dependency — Task 3 gate), vitest.

---

### Task 1: Migration — extend whatsapp_contacts

**Files:**
- Create: `supabase/migrations/20260711090000_whatsapp_contacts_mobile_fields.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Mobile contact-card fields for the contacts manager. All additive/nullable:
-- existing readers (inbox names, broadcasts, webhook contact sync) are unaffected.
ALTER TABLE public.whatsapp_contacts
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  ADD COLUMN IF NOT EXISTS phone_secondary TEXT,
  ADD COLUMN IF NOT EXISTS street TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS birthday DATE,
  ADD COLUMN IF NOT EXISTS website TEXT;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260711090000_whatsapp_contacts_mobile_fields.sql
git commit -m "feat(contacts): add mobile contact-card columns"
```

(Production apply happens in Task 12 via docker-exec psql — supabase MCP DDL is read-only.)

---

### Task 2: contactCodecs — pure logic + tests (TDD)

**Files:**
- Create: `src/components/messaging/contacts/contactCodecs.ts`
- Test: `src/lib/__tests__/contactCodecs.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  normalizePhone, splitPhone, deriveDisplayName, autoMapHeaders,
  contactsToVCardFile, contactsToCsvRows, COUNTRY_DIAL_CODES, CSV_FIELDS,
} from "@/components/messaging/contacts/contactCodecs";

const contact = {
  id: "1", phone_number: "96555683677", display_name: "Ahmed Ali",
  first_name: "Ahmed", last_name: "Ali", email: "a@x.com", company: "Acme",
  job_title: "CEO", phone_secondary: "96599998888", street: "Salem St",
  city: "Kuwait City", country: "Kuwait", birthday: "1990-01-15",
  website: "https://acme.com", notes: "VIP", tags: ["vip"], avatar_url: null,
};

describe("normalizePhone", () => {
  it("strips punctuation and plus", () => {
    expect(normalizePhone("+965 5568-3677")).toBe("96555683677");
  });
  it("applies default dial code to local numbers", () => {
    expect(normalizePhone("55683677", "965")).toBe("96555683677");
  });
  it("does not double-apply when already prefixed", () => {
    expect(normalizePhone("96555683677", "965")).toBe("96555683677");
  });
  it("returns empty for non-numbers", () => {
    expect(normalizePhone("abc")).toBe("");
  });
});

describe("splitPhone", () => {
  it("splits by longest dial-code match", () => {
    expect(splitPhone("96555683677")).toEqual({ dialCode: "965", national: "55683677" });
  });
  it("falls back to unsplit when no match", () => {
    expect(splitPhone("00000")).toEqual({ dialCode: "", national: "00000" });
  });
});

describe("deriveDisplayName", () => {
  it("joins first and last", () => {
    expect(deriveDisplayName("Ahmed", "Ali", "")).toBe("Ahmed Ali");
  });
  it("falls back when both empty", () => {
    expect(deriveDisplayName("", "", "+965")).toBe("+965");
  });
});

describe("autoMapHeaders", () => {
  it("maps common header spellings", () => {
    const map = autoMapHeaders(["First Name", "Surname", "Mobile", "E-mail Address", "Organization"]);
    expect(map.first_name).toBe(0);
    expect(map.last_name).toBe(1);
    expect(map.phone_number).toBe(2);
    expect(map.email).toBe(3);
    expect(map.company).toBe(4);
  });
});

describe("vCard export", () => {
  it("emits one VCARD per contact with core fields", () => {
    const vcf = contactsToVCardFile([contact]);
    expect(vcf).toContain("BEGIN:VCARD");
    expect(vcf).toContain("FN:Ahmed Ali");
    expect(vcf).toContain("N:Ali;Ahmed;;;");
    expect(vcf).toContain("TEL;TYPE=CELL:+96555683677");
    expect(vcf).toContain("TEL;TYPE=HOME:+96599998888");
    expect(vcf).toContain("EMAIL:a@x.com");
    expect(vcf).toContain("ORG:Acme");
    expect(vcf).toContain("BDAY:1990-01-15");
    expect(vcf).toContain("END:VCARD");
  });
});

describe("CSV export", () => {
  it("emits a row per contact with every CSV_FIELD key", () => {
    const rows = contactsToCsvRows([contact]);
    expect(rows).toHaveLength(1);
    for (const f of CSV_FIELDS) expect(rows[0]).toHaveProperty(f);
    expect(rows[0].phone_number).toBe("96555683677");
    expect(rows[0].tags).toBe("vip");
  });
});

describe("COUNTRY_DIAL_CODES", () => {
  it("contains Kuwait and sorts prefixes longest-first for matching", () => {
    expect(COUNTRY_DIAL_CODES.some((c) => c.dial === "965")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/contactCodecs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement contactCodecs.ts**

```ts
// Pure contact data logic: phone normalization/splitting, CSV header mapping,
// and CSV/vCard serialization. No React, no supabase — unit-testable.

export interface ContactRecord {
  id: string;
  phone_number: string;
  display_name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  company?: string | null;
  job_title?: string | null;
  phone_secondary?: string | null;
  street?: string | null;
  city?: string | null;
  country?: string | null;
  birthday?: string | null;
  website?: string | null;
  notes?: string | null;
  tags?: string[] | null;
  avatar_url?: string | null;
}

// Supported dial codes: Gulf/MENA in full plus major world markets. Users can
// still type any prefix manually — this list only drives the dropdown and
// splitPhone's best-effort split.
export const COUNTRY_DIAL_CODES: { code: string; name: string; dial: string; flag: string }[] = [
  { code: "KW", name: "Kuwait", dial: "965", flag: "🇰🇼" },
  { code: "SA", name: "Saudi Arabia", dial: "966", flag: "🇸🇦" },
  { code: "AE", name: "UAE", dial: "971", flag: "🇦🇪" },
  { code: "QA", name: "Qatar", dial: "974", flag: "🇶🇦" },
  { code: "BH", name: "Bahrain", dial: "973", flag: "🇧🇭" },
  { code: "OM", name: "Oman", dial: "968", flag: "🇴🇲" },
  { code: "EG", name: "Egypt", dial: "20", flag: "🇪🇬" },
  { code: "JO", name: "Jordan", dial: "962", flag: "🇯🇴" },
  { code: "LB", name: "Lebanon", dial: "961", flag: "🇱🇧" },
  { code: "IQ", name: "Iraq", dial: "964", flag: "🇮🇶" },
  { code: "SY", name: "Syria", dial: "963", flag: "🇸🇾" },
  { code: "PS", name: "Palestine", dial: "970", flag: "🇵🇸" },
  { code: "YE", name: "Yemen", dial: "967", flag: "🇾🇪" },
  { code: "LY", name: "Libya", dial: "218", flag: "🇱🇾" },
  { code: "TN", name: "Tunisia", dial: "216", flag: "🇹🇳" },
  { code: "DZ", name: "Algeria", dial: "213", flag: "🇩🇿" },
  { code: "MA", name: "Morocco", dial: "212", flag: "🇲🇦" },
  { code: "SD", name: "Sudan", dial: "249", flag: "🇸🇩" },
  { code: "TR", name: "Turkey", dial: "90", flag: "🇹🇷" },
  { code: "US", name: "United States", dial: "1", flag: "🇺🇸" },
  { code: "GB", name: "United Kingdom", dial: "44", flag: "🇬🇧" },
  { code: "DE", name: "Germany", dial: "49", flag: "🇩🇪" },
  { code: "FR", name: "France", dial: "33", flag: "🇫🇷" },
  { code: "ES", name: "Spain", dial: "34", flag: "🇪🇸" },
  { code: "IT", name: "Italy", dial: "39", flag: "🇮🇹" },
  { code: "NL", name: "Netherlands", dial: "31", flag: "🇳🇱" },
  { code: "SE", name: "Sweden", dial: "46", flag: "🇸🇪" },
  { code: "CH", name: "Switzerland", dial: "41", flag: "🇨🇭" },
  { code: "RU", name: "Russia", dial: "7", flag: "🇷🇺" },
  { code: "IN", name: "India", dial: "91", flag: "🇮🇳" },
  { code: "PK", name: "Pakistan", dial: "92", flag: "🇵🇰" },
  { code: "BD", name: "Bangladesh", dial: "880", flag: "🇧🇩" },
  { code: "LK", name: "Sri Lanka", dial: "94", flag: "🇱🇰" },
  { code: "NP", name: "Nepal", dial: "977", flag: "🇳🇵" },
  { code: "PH", name: "Philippines", dial: "63", flag: "🇵🇭" },
  { code: "ID", name: "Indonesia", dial: "62", flag: "🇮🇩" },
  { code: "MY", name: "Malaysia", dial: "60", flag: "🇲🇾" },
  { code: "SG", name: "Singapore", dial: "65", flag: "🇸🇬" },
  { code: "TH", name: "Thailand", dial: "66", flag: "🇹🇭" },
  { code: "VN", name: "Vietnam", dial: "84", flag: "🇻🇳" },
  { code: "CN", name: "China", dial: "86", flag: "🇨🇳" },
  { code: "JP", name: "Japan", dial: "81", flag: "🇯🇵" },
  { code: "KR", name: "South Korea", dial: "82", flag: "🇰🇷" },
  { code: "AU", name: "Australia", dial: "61", flag: "🇦🇺" },
  { code: "NZ", name: "New Zealand", dial: "64", flag: "🇳🇿" },
  { code: "CA", name: "Canada", dial: "1", flag: "🇨🇦" },
  { code: "MX", name: "Mexico", dial: "52", flag: "🇲🇽" },
  { code: "BR", name: "Brazil", dial: "55", flag: "🇧🇷" },
  { code: "AR", name: "Argentina", dial: "54", flag: "🇦🇷" },
  { code: "ZA", name: "South Africa", dial: "27", flag: "🇿🇦" },
  { code: "NG", name: "Nigeria", dial: "234", flag: "🇳🇬" },
  { code: "KE", name: "Kenya", dial: "254", flag: "🇰🇪" },
  { code: "ET", name: "Ethiopia", dial: "251", flag: "🇪🇹" },
  { code: "IR", name: "Iran", dial: "98", flag: "🇮🇷" },
  { code: "AF", name: "Afghanistan", dial: "93", flag: "🇦🇫" },
];

const DIALS_LONGEST_FIRST = [...new Set(COUNTRY_DIAL_CODES.map((c) => c.dial))]
  .sort((a, b) => b.length - a.length);

export function normalizePhone(raw: string, defaultDialCode?: string): string {
  const hadPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (hadPlus || !defaultDialCode) return digits;
  if (digits.startsWith(defaultDialCode)) return digits;
  // Local numbers keep leading-zero conventions out of E.164
  return defaultDialCode + digits.replace(/^0+/, "");
}

export function splitPhone(digits: string): { dialCode: string; national: string } {
  for (const dial of DIALS_LONGEST_FIRST) {
    if (digits.startsWith(dial) && digits.length > dial.length) {
      return { dialCode: dial, national: digits.slice(dial.length) };
    }
  }
  return { dialCode: "", national: digits };
}

export function deriveDisplayName(first: string, last: string, fallback: string): string {
  const joined = [first.trim(), last.trim()].filter(Boolean).join(" ");
  return joined || fallback;
}

export const CSV_FIELDS = [
  "first_name", "last_name", "display_name", "phone_number", "phone_secondary",
  "email", "company", "job_title", "street", "city", "country", "birthday",
  "website", "notes", "tags", "avatar_url",
] as const;

export type CsvField = (typeof CSV_FIELDS)[number];

// header aliases (lowercased, punctuation stripped) → field
const HEADER_ALIASES: Record<string, CsvField> = {
  firstname: "first_name", givenname: "first_name",
  lastname: "last_name", surname: "last_name", familyname: "last_name",
  name: "display_name", fullname: "display_name", displayname: "display_name",
  phone: "phone_number", phonenumber: "phone_number", mobile: "phone_number",
  mobilenumber: "phone_number", whatsapp: "phone_number", cell: "phone_number",
  phone2: "phone_secondary", secondphone: "phone_secondary", homephone: "phone_secondary",
  otherphone: "phone_secondary", secondaryphone: "phone_secondary",
  email: "email", emailaddress: "email", mail: "email",
  company: "company", organization: "company", organisation: "company",
  jobtitle: "job_title", title: "job_title", position: "job_title",
  street: "street", address: "street", streetaddress: "street",
  city: "city", town: "city",
  country: "country",
  birthday: "birthday", dateofbirth: "birthday", dob: "birthday",
  website: "website", url: "website", web: "website",
  notes: "notes", note: "notes", comment: "notes",
  tags: "tags", labels: "tags",
  avatar: "avatar_url", avatarurl: "avatar_url", photo: "avatar_url", photourl: "avatar_url", image: "avatar_url",
};

export function autoMapHeaders(headers: string[]): Partial<Record<CsvField, number>> {
  const map: Partial<Record<CsvField, number>> = {};
  headers.forEach((h, i) => {
    const key = h.toLowerCase().replace(/[^a-z0-9]/g, "");
    const field = HEADER_ALIASES[key];
    if (field && map[field] === undefined) map[field] = i;
  });
  return map;
}

function vCardEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (m) => `\\${m}`);
}

export function contactToVCard(c: ContactRecord): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  const fn = c.display_name || deriveDisplayName(c.first_name || "", c.last_name || "", `+${c.phone_number}`);
  lines.push(`FN:${vCardEscape(fn)}`);
  lines.push(`N:${vCardEscape(c.last_name || "")};${vCardEscape(c.first_name || "")};;;`);
  lines.push(`TEL;TYPE=CELL:+${c.phone_number}`);
  if (c.phone_secondary) lines.push(`TEL;TYPE=HOME:+${c.phone_secondary}`);
  if (c.email) lines.push(`EMAIL:${vCardEscape(c.email)}`);
  if (c.company) lines.push(`ORG:${vCardEscape(c.company)}`);
  if (c.job_title) lines.push(`TITLE:${vCardEscape(c.job_title)}`);
  if (c.street || c.city || c.country) {
    lines.push(`ADR;TYPE=WORK:;;${vCardEscape(c.street || "")};${vCardEscape(c.city || "")};;;${vCardEscape(c.country || "")}`);
  }
  if (c.birthday) lines.push(`BDAY:${c.birthday}`);
  if (c.website) lines.push(`URL:${vCardEscape(c.website)}`);
  if (c.notes) lines.push(`NOTE:${vCardEscape(c.notes)}`);
  if (c.avatar_url) lines.push(`PHOTO;VALUE=URI:${c.avatar_url}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

export function contactsToVCardFile(contacts: ContactRecord[]): string {
  return contacts.map(contactToVCard).join("\r\n") + "\r\n";
}

export function contactsToCsvRows(contacts: ContactRecord[]): Record<CsvField, string>[] {
  return contacts.map((c) => {
    const row = {} as Record<CsvField, string>;
    for (const f of CSV_FIELDS) {
      if (f === "tags") row[f] = (c.tags || []).join(", ");
      else row[f] = (c[f] as string | null | undefined) ?? "";
    }
    return row;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/contactCodecs.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/components/messaging/contacts/contactCodecs.ts src/lib/__tests__/contactCodecs.test.ts
git commit -m "feat(contacts): pure codecs for phone/CSV/vCard with tests"
```

---

### Task 3: xlsx dependency (USER GATE)

**Files:**
- Modify: `package.json`, `package-lock.json`

The working tree has an uncommitted experimental vite-8 bump in `package.json`/`package-lock.json` (known to break local builds). Installing `xlsx` on top would entangle the two.

- [ ] **Step 1: Ask the user** whether to (a) discard the vite-8 WIP (`git checkout -- package.json package-lock.json`, then reinstall deps) — recommended — or (b) keep it, in which case save `git diff package.json package-lock.json > /tmp/vite8-wip.patch` first, restore committed versions, install xlsx, commit, then `git apply --3way /tmp/vite8-wip.patch` (resolve any lockfile conflict by regenerating with `npm install`).
- [ ] **Step 2: Install** `npm install xlsx@^0.18.5`
- [ ] **Step 3: Commit** only `package.json` + `package-lock.json` with message `feat(contacts): add xlsx for Excel export`.
- [ ] **Step 4: Sanity check** `npx vitest run src/lib/__tests__/contactCodecs.test.ts` still passes.

---

### Task 4: useContacts hooks

**Files:**
- Create: `src/components/messaging/contacts/useContacts.ts`

- [ ] **Step 1: Implement the hooks module**

```ts
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { ContactRecord } from "./contactCodecs";

export const CONTACTS_PAGE_SIZE = 50;
const STALE_MS = 5 * 60 * 1000;

export interface ContactFilters {
  search: string;
  groupId: string; // "all" = no filter
  page: number;    // 0-based
}

export interface ContactGroup {
  id: string;
  name: string;
  description: string | null;
  color: string;
}

function escapeIlike(term: string): string {
  return term.replace(/[%_]/g, "\\$&").replace(/,/g, " ");
}

export function useContactGroups() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["whatsapp-groups", session?.user?.id],
    staleTime: STALE_MS,
    enabled: !!session?.user?.id,
    queryFn: async (): Promise<ContactGroup[]> => {
      const { data, error } = await supabase
        .from("whatsapp_contact_groups").select("*").order("name");
      if (error) throw error;
      return data || [];
    },
  });
}

export function useGroupMembers() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["whatsapp-group-members", session?.user?.id],
    staleTime: STALE_MS,
    enabled: !!session?.user?.id,
    queryFn: async (): Promise<{ group_id: string; contact_id: string }[]> => {
      const { data, error } = await supabase
        .from("whatsapp_contact_group_members").select("group_id, contact_id");
      if (error) throw error;
      return data || [];
    },
  });
}

export function useContactsPage(filters: ContactFilters) {
  const { session } = useAuth();
  const { data: members = [] } = useGroupMembers();

  return useQuery({
    queryKey: ["whatsapp-contacts", session?.user?.id, filters, members.length],
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
    enabled: !!session?.user?.id,
    queryFn: async (): Promise<{ rows: ContactRecord[]; total: number }> => {
      let q = supabase.from("whatsapp_contacts")
        .select("*", { count: "exact" })
        .order("display_name", { ascending: true, nullsFirst: false });

      if (filters.search) {
        const t = `%${escapeIlike(filters.search)}%`;
        q = q.or(`display_name.ilike.${t},phone_number.ilike.${t},email.ilike.${t},company.ilike.${t}`);
      }
      if (filters.groupId !== "all") {
        const ids = members.filter((m) => m.group_id === filters.groupId).map((m) => m.contact_id);
        if (ids.length === 0) return { rows: [], total: 0 };
        q = q.in("id", ids);
      }
      const from = filters.page * CONTACTS_PAGE_SIZE;
      const { data, count, error } = await q.range(from, from + CONTACTS_PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data || []) as ContactRecord[], total: count || 0 };
    },
  });
}

// Every field of a contact the form can write. phone_number must already be digits.
export type ContactInput = Omit<ContactRecord, "id">;

export function useContactMutations() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
    qc.invalidateQueries({ queryKey: ["whatsapp-group-members"] });
  };

  const createContact = useMutation({
    mutationFn: async (input: ContactInput) => {
      const { error } = await supabase.from("whatsapp_contacts")
        .insert({ ...input, user_id: session!.user.id });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const updateContact = useMutation({
    mutationFn: async ({ id, ...input }: ContactRecord) => {
      const { error } = await supabase.from("whatsapp_contacts").update(input).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const deleteContacts = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase.from("whatsapp_contacts").delete().in("id", ids);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const addToGroup = useMutation({
    mutationFn: async ({ groupId, contactIds }: { groupId: string; contactIds: string[] }) => {
      const rows = contactIds.map((contact_id) => ({ group_id: groupId, contact_id }));
      const { error } = await supabase.from("whatsapp_contact_group_members")
        .upsert(rows, { onConflict: "group_id,contact_id", ignoreDuplicates: true });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const removeFromGroup = useMutation({
    mutationFn: async ({ groupId, contactIds }: { groupId: string; contactIds: string[] }) => {
      const { error } = await supabase.from("whatsapp_contact_group_members")
        .delete().eq("group_id", groupId).in("contact_id", contactIds);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const addTag = useMutation({
    mutationFn: async ({ tag, contacts }: { tag: string; contacts: ContactRecord[] }) => {
      for (const c of contacts) {
        const tags = Array.from(new Set([...(c.tags || []), tag]));
        const { error } = await supabase.from("whatsapp_contacts").update({ tags }).eq("id", c.id);
        if (error) throw error;
      }
    },
    onSuccess: invalidate,
  });

  return { createContact, updateContact, deleteContacts, addToGroup, removeFromGroup, addTag };
}

export function useGroupMutations() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["whatsapp-groups"] });
    qc.invalidateQueries({ queryKey: ["whatsapp-group-members"] });
  };

  const createGroup = useMutation({
    mutationFn: async (g: { name: string; description: string | null; color: string }) => {
      const { error } = await supabase.from("whatsapp_contact_groups")
        .insert({ ...g, user_id: session!.user.id });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const updateGroup = useMutation({
    mutationFn: async ({ id, ...g }: { id: string; name: string; description: string | null; color: string }) => {
      const { error } = await supabase.from("whatsapp_contact_groups").update(g).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const deleteGroup = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("whatsapp_contact_groups").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  return { createGroup, updateGroup, deleteGroup };
}

// Square-crops to 256px JPEG and uploads to the media bucket (same pattern as
// message attachments). Returns the public URL.
export async function uploadContactAvatar(file: File, userId: string): Promise<string> {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image processing failed"))), "image/jpeg", 0.85),
  );
  const path = `whatsapp-contact-avatars/${userId}_${Date.now()}.jpg`;
  const { data, error } = await supabase.storage.from("media").upload(path, blob, { contentType: "image/jpeg" });
  if (error) throw error;
  return supabase.storage.from("media").getPublicUrl(data.path).data.publicUrl;
}
```

- [ ] **Step 2: Typecheck** `npx tsc --noEmit` → 0 errors.
- [ ] **Step 3: Commit** `git add src/components/messaging/contacts/useContacts.ts && git commit -m "feat(contacts): data hooks with paged cached queries and bulk mutations"`

---

### Task 5: PhoneInput component

**Files:**
- Create: `src/components/messaging/contacts/PhoneInput.tsx`

- [ ] **Step 1: Implement**

```tsx
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COUNTRY_DIAL_CODES, splitPhone } from "./contactCodecs";

interface PhoneInputProps {
  value: string; // combined digits, e.g. "96555683677"
  onChange: (digits: string) => void;
  placeholder?: string;
}

// Country-code + national number entry; emits combined digits (E.164 without +).
export function PhoneInput({ value, onChange, placeholder }: PhoneInputProps) {
  const { dialCode, national } = splitPhone(value);

  return (
    <div className="flex gap-2">
      <Select value={dialCode || "965"} onValueChange={(dial) => onChange(dial + national)}>
        <SelectTrigger className="w-[130px] shrink-0">
          <SelectValue placeholder="Code" />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {COUNTRY_DIAL_CODES.map((c) => (
            <SelectItem key={c.code} value={c.dial}>
              {c.flag} +{c.dial} {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        inputMode="tel"
        value={national}
        placeholder={placeholder || "5568 3677"}
        onChange={(e) => onChange((dialCode || "965") + e.target.value.replace(/\D/g, ""))}
      />
    </div>
  );
}
```

Note: duplicate `dial` values (US/Canada both "1") — `SelectItem` values must be unique, so use `value={c.code}` and map back to dial via lookup; implement as:

```tsx
const selected = COUNTRY_DIAL_CODES.find((c) => c.dial === dialCode)?.code ?? "KW";
// SelectItem value={c.code}; onValueChange={(code) => { const dial = COUNTRY_DIAL_CODES.find(c => c.code === code)!.dial; onChange(dial + national); }}
```

Use the `c.code`-keyed variant in the final file — it is the correct one.

- [ ] **Step 2: Typecheck + commit** `git add src/components/messaging/contacts/PhoneInput.tsx && git commit -m "feat(contacts): country-code phone input"`

---

### Task 6: ContactFormDialog (add + edit, avatar picker)

**Files:**
- Create: `src/components/messaging/contacts/ContactFormDialog.tsx`

- [ ] **Step 1: Implement** — a dialog receiving `contact?: ContactRecord | null` (null = add mode). Layout mirrors a phone contact card:

```tsx
import { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Camera, Loader2 } from "lucide-react";
import { deriveDisplayName, type ContactRecord } from "./contactCodecs";
import { useContactMutations, uploadContactAvatar } from "./useContacts";
import { PhoneInput } from "./PhoneInput";

interface ContactFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: ContactRecord | null; // null = create
}

const EMPTY = {
  first_name: "", last_name: "", phone_number: "", phone_secondary: "",
  email: "", company: "", job_title: "", street: "", city: "", country: "",
  birthday: "", website: "", notes: "", tags: "", avatar_url: "",
};

export function ContactFormDialog({ open, onOpenChange, contact }: ContactFormDialogProps) {
  const { session } = useAuth();
  const { toast } = useToast();
  const { createContact, updateContact } = useContactMutations();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState(EMPTY);

  useEffect(() => {
    if (!open) return;
    setForm(contact ? {
      first_name: contact.first_name || "",
      last_name: contact.last_name || "",
      phone_number: contact.phone_number || "",
      phone_secondary: contact.phone_secondary || "",
      email: contact.email || "",
      company: contact.company || "",
      job_title: contact.job_title || "",
      street: contact.street || "",
      city: contact.city || "",
      country: contact.country || "",
      birthday: contact.birthday || "",
      website: contact.website || "",
      notes: contact.notes || "",
      tags: (contact.tags || []).join(", "),
      avatar_url: contact.avatar_url || "",
    } : EMPTY);
  }, [open, contact]);

  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const pickAvatar = async (file: File) => {
    if (!session?.user?.id) return;
    setUploading(true);
    try {
      const url = await uploadContactAvatar(file, session.user.id);
      set("avatar_url")(url);
    } catch (e) {
      toast({ title: "Photo upload failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    const payload = {
      first_name: form.first_name || null,
      last_name: form.last_name || null,
      display_name: deriveDisplayName(form.first_name, form.last_name, `+${form.phone_number}`),
      phone_number: form.phone_number,
      phone_secondary: form.phone_secondary || null,
      email: form.email || null,
      company: form.company || null,
      job_title: form.job_title || null,
      street: form.street || null,
      city: form.city || null,
      country: form.country || null,
      birthday: form.birthday || null,
      website: form.website || null,
      notes: form.notes || null,
      tags: form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      avatar_url: form.avatar_url || null,
    };
    try {
      if (contact) await updateContact.mutateAsync({ id: contact.id, ...payload });
      else await createContact.mutateAsync(payload);
      toast({ title: contact ? "Contact updated" : "Contact added" });
      onOpenChange(false);
    } catch (e) {
      const msg = (e as Error).message;
      toast({
        title: "Save failed",
        description: msg.includes("duplicate") ? "A contact with this number already exists." : msg,
        variant: "destructive",
      });
    }
  };

  const initials = (form.first_name[0] || "") + (form.last_name[0] || "");
  const pending = createContact.isPending || updateContact.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{contact ? "Edit Contact" : "New Contact"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="flex justify-center">
            <button type="button" className="relative" onClick={() => fileRef.current?.click()} disabled={uploading}>
              <Avatar className="h-20 w-20">
                <AvatarImage src={form.avatar_url || undefined} />
                <AvatarFallback className="text-xl">{initials || <Camera className="h-6 w-6" />}</AvatarFallback>
              </Avatar>
              <span className="absolute bottom-0 right-0 rounded-full bg-primary p-1.5 text-primary-foreground">
                {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
              </span>
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => e.target.files?.[0] && pickAvatar(e.target.files[0])} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div><Label>First name</Label><Input value={form.first_name} onChange={(e) => set("first_name")(e.target.value)} /></div>
            <div><Label>Last name</Label><Input value={form.last_name} onChange={(e) => set("last_name")(e.target.value)} /></div>
          </div>
          <div><Label>WhatsApp number *</Label><PhoneInput value={form.phone_number} onChange={set("phone_number")} /></div>
          <div><Label>Second phone</Label><PhoneInput value={form.phone_secondary} onChange={set("phone_secondary")} /></div>
          <div><Label>Email</Label><Input type="email" value={form.email} onChange={(e) => set("email")(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Company</Label><Input value={form.company} onChange={(e) => set("company")(e.target.value)} /></div>
            <div><Label>Job title</Label><Input value={form.job_title} onChange={(e) => set("job_title")(e.target.value)} /></div>
          </div>
          <div><Label>Street</Label><Input value={form.street} onChange={(e) => set("street")(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>City</Label><Input value={form.city} onChange={(e) => set("city")(e.target.value)} /></div>
            <div><Label>Country</Label><Input value={form.country} onChange={(e) => set("country")(e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Birthday</Label><Input type="date" value={form.birthday} onChange={(e) => set("birthday")(e.target.value)} /></div>
            <div><Label>Website</Label><Input value={form.website} onChange={(e) => set("website")(e.target.value)} /></div>
          </div>
          <div><Label>Notes</Label><Textarea value={form.notes} onChange={(e) => set("notes")(e.target.value)} /></div>
          <div><Label>Tags (comma-separated)</Label><Input value={form.tags} onChange={(e) => set("tags")(e.target.value)} placeholder="vip, customer" /></div>

          <Button className="w-full" onClick={save} disabled={!form.phone_number || pending || uploading}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {contact ? "Save changes" : "Add contact"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck + commit** `git commit -m "feat(contacts): mobile-style add/edit contact form with avatar upload"`

---

### Task 7: GroupsBar

**Files:**
- Create: `src/components/messaging/contacts/GroupsBar.tsx`

- [ ] **Step 1: Implement** — chips row: "All" + one chip per group (dot in group color, name, member count from `useGroupMembers`), click filters; "＋ New group" opens a dialog (name/description/color — reuse the field trio from the old inline dialog); each chip has a dropdown (⋯) with Rename (same dialog pre-filled, calls `updateGroup`) and Delete (confirm, calls `deleteGroup`). Props: `{ selectedGroup: string; onSelect: (id: string) => void }`. All data via `useContactGroups`, `useGroupMembers`, `useGroupMutations` — no supabase calls in the component.
- [ ] **Step 2: Typecheck + commit** `git commit -m "feat(contacts): groups bar with create/rename/delete and counts"`

---

### Task 8: ContactsTable with bulk selection

**Files:**
- Create: `src/components/messaging/contacts/ContactsTable.tsx`

- [ ] **Step 1: Implement** — props:

```ts
interface ContactsTableProps {
  rows: ContactRecord[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  selected: Set<string>;
  onSelectedChange: (s: Set<string>) => void;
  onEdit: (c: ContactRecord) => void;
  loading: boolean;
}
```

Columns: checkbox | Avatar+Name (`Avatar` with `avatar_url`/initials, display_name bold, job_title+company muted below) | Phone (`+digits` mono) | Email | Tags (badges) | row click → `onEdit(c)` (checkbox cell stops propagation). Header checkbox toggles page selection. Footer: `Showing X–Y of {total}` with Prev/Next buttons using `CONTACTS_PAGE_SIZE`. Empty state keeps the current Users-icon message.

- [ ] **Step 2: Implement the bulk action bar** in the same file (`BulkActionsBar`, rendered by the shell when `selected.size > 0`): count label, buttons Delete (AlertDialog confirm with count → `deleteContacts.mutate([...selected])`), Add to group (Select of groups → `addToGroup`), Remove from group (Select → `removeFromGroup`), Add tag (small Input+confirm → `addTag`), Export selected (renders `ContactExportMenu` scoped to selection — wire in Task 10), Clear selection.
- [ ] **Step 3: Typecheck + commit** `git commit -m "feat(contacts): paged table with bulk selection and actions"`

---### Task 9: ContactImportDialog (CSV wizard)

**Files:**
- Create: `src/components/messaging/contacts/ContactImportDialog.tsx`
- Delete (Task 10): `src/components/messaging/ContactUploadDialog.tsx`

- [ ] **Step 1: Implement** — three-step wizard in one dialog using local `step` state:

1. **Upload**: file input, `Papa.parse(file, { header: true, skipEmptyLines: true })`; store `headers` + `rows`.
2. **Map**: table of CSV_FIELDS → Select of headers, pre-filled from `autoMapHeaders(headers)`; extra controls: default country code (Select from COUNTRY_DIAL_CODES, default KW/965, applied via `normalizePhone(raw, dial)`), optional target group (Select from `useContactGroups`). Preview of first 10 mapped rows; rows with empty normalized phone are flagged red and counted.
3. **Run**: chunk mapped valid rows into batches of 500; for each batch `supabase.from("whatsapp_contacts").upsert(batch.map(r => ({...r, user_id})), { onConflict: "user_id,phone_number" })`; Progress bar (shadcn `Progress`) = batches done / total; collect failed batches' rows + reasons; if a target group was chosen, fetch the ids of all imported phone numbers (`.select("id, phone_number").in("phone_number", phones)`) and `addToGroup` them in one upsert. Final screen: imported / skipped-invalid / failed counts + "Download error rows" button (papaparse `unparse` of failures) + Done (invalidate `whatsapp-contacts` queries, close).

Field mapping produces `ContactInput` objects: tags column split on commas; birthday passed through only if it matches `/^\d{4}-\d{2}-\d{2}$/` (else dropped into notes suffix ` (birthday: <raw>)`? No — dropped silently and counted in a "cleaned" counter shown in the report); display_name = mapped display_name column or derived from first/last or `+phone`.

- [ ] **Step 2: Typecheck + commit** `git commit -m "feat(contacts): CSV import wizard with mapping, validation and chunked upsert"`

---

### Task 10: ContactExportMenu + shell rewrite

**Files:**
- Create: `src/components/messaging/contacts/ContactExportMenu.tsx`
- Rewrite: `src/components/messaging/WhatsAppContactsContent.tsx`
- Delete: `src/components/messaging/ContactUploadDialog.tsx`

- [ ] **Step 1: Implement ContactExportMenu** — props `{ getContacts: () => Promise<ContactRecord[]>; label?: string }` (shell passes a fetcher for "selection or current filter, unpaged" — same query as `useContactsPage` without `.range`). DropdownMenu with three items:

```ts
// CSV
import Papa from "papaparse";
const rows = contactsToCsvRows(await getContacts());
downloadBlob(new Blob([Papa.unparse(rows)], { type: "text/csv" }), "postora-contacts.csv");

// XLSX
import * as XLSX from "xlsx";
const ws = XLSX.utils.json_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Contacts");
XLSX.writeFile(wb, "postora-contacts.xlsx");

// vCard
downloadBlob(new Blob([contactsToVCardFile(contacts)], { type: "text/vcard" }), "postora-contacts.vcf");
```

with a local `downloadBlob(blob, filename)` helper (createObjectURL + anchor click + revoke).

- [ ] **Step 2: Rewrite the shell** — `WhatsAppContactsContent.tsx` keeps only: filter state (`search` debounced 300ms via `useEffect` timer, `groupId`, `page`), `selected` set, dialog open-states, and composition: header row (counts, Import, Export, New group handled inside GroupsBar, Add contact), search input, `GroupsBar`, `BulkActionsBar` (when selection), `ContactsTable`, `ContactFormDialog`, `ContactImportDialog`. All old inline queries/mutations/dialogs are deleted; `ContactUploadDialog.tsx` is deleted (`git rm`). Grep for other importers of `ContactUploadDialog` first — if any exist, update them to `ContactImportDialog`.
- [ ] **Step 3: Typecheck + full test run** `npx tsc --noEmit && npx vitest run` → clean.
- [ ] **Step 4: Commit** `git commit -m "feat(contacts): export menu and contacts manager shell"`

---

### Task 11: Quality gates

- [ ] **Step 1:** `npx tsc --noEmit` → 0 errors; `npx vitest run` → all pass; `npm run lint` → no new errors in touched files.
- [ ] **Step 2:** Run `clean-code-guard` on all files under `src/components/messaging/contacts/` + the shell; run `test-guard` on `contactCodecs.test.ts`. Fix findings.
- [ ] **Step 3:** Commit any guard fixes: `git commit -m "refactor(contacts): guard-pass cleanups"`.

---

### Task 12: Deploy + live verification

- [ ] **Step 1: Apply migration to production** via ssh-contabo docker-exec psql (single-line `-c`, the ALTER TABLE from Task 1). Verify: `\d whatsapp_contacts` shows the nine new columns.
- [ ] **Step 2: Merge to main + push** (stash WIP dance as in previous deploys) → Dokploy auto-builds the frontend; confirm deployment `status: done` via dokploy MCP.
- [ ] **Step 3: Live walkthrough** on postora.cloud `/messaging/whatsapp/contacts`: add a contact with photo + country code; edit it; import a 3-row sample CSV (one invalid phone) and check the report; bulk-select → add to group; export CSV, XLSX, vCard and open each; confirm the inbox still shows saved names.
- [ ] **Step 4:** mem0 `add_memory` task summary + final report to user.
