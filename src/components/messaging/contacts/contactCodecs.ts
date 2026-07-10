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
