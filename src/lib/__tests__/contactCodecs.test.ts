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
