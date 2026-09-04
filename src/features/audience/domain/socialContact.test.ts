import { describe, it, expect } from "vitest";
import { buildContactsCsv, buildMetaAudienceCsv, contactLabel, type SocialContact } from "./socialContact";

const row = {
  id: "1", user_id: "u", workspace_id: null, social_account_id: null, platform: "instagram",
  platform_user_id: "178", identity_kind: "id", display_name: "Dana, KW", username: "dana.kw",
  profile_url: null, email: "Dana@Example.com", phone_number: "96550000000", company: null,
  notes: 'says "hi"', source: "organic_comment", tags: ["lead", "vip"], whatsapp_contact_id: null,
  total_comments_count: 3, first_interacted_at: "2026-09-01T00:00:00Z", last_interacted_at: "2026-09-04T00:00:00Z",
  last_comment_text: "price?", last_post_id: "p1", metadata: {}, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-04T00:00:00Z",
} as SocialContact;

describe("contactLabel", () => {
  it("prefers display name, then username, then id", () => {
    expect(contactLabel(row)).toBe("Dana, KW");
    expect(contactLabel({ ...row, display_name: "" })).toBe("dana.kw");
    expect(contactLabel({ ...row, display_name: "", username: null })).toBe("178");
  });
});

describe("buildContactsCsv", () => {
  it("quotes commas and quotes, joins tags with |, omits metadata", () => {
    const [header, line] = buildContactsCsv([row]).split("\r\n");
    expect(header).toBe("id,platform,platform_user_id,identity_kind,display_name,username,profile_url,email,phone_number,company,notes,source,tags,total_comments_count,first_interacted_at,last_interacted_at,last_comment_text,last_post_id,social_account_id,whatsapp_contact_id,workspace_id,user_id,created_at,updated_at");
    // Column-by-column rather than one long literal: the point is the escaping and
    // the tag join, and a 24-column string would be unreadable either way.
    const cells = line.split(",");
    expect(cells[0]).toBe("1");
    expect(cells[1]).toBe("instagram");
    expect(line).toContain('"Dana, KW"');
    expect(line).toContain("lead|vip");
    expect(line).toContain('"says ""hi"""');
  });
  it("returns only the header for no rows", () => {
    expect(buildContactsCsv([]).split("\r\n")).toHaveLength(1);
  });
});

describe("buildMetaAudienceCsv", () => {
  it("emits the five Meta columns with a lower-cased email, stored phone, split name and no pageuid off facebook", () => {
    const lines = buildMetaAudienceCsv([row]).split("\r\n");
    expect(lines[0]).toBe("email,phone,fn,ln,pageuid");
    // "Dana, KW" must not hash as fn="Dana," -- Meta matches the name itself.
    expect(lines[1]).toBe("dana@example.com,96550000000,Dana,KW,");
  });
  it("emits pageuid for facebook rows and skips rows with no email, phone or pageuid", () => {
    const fb = { ...row, platform: "facebook", platform_user_id: "102227720640048", display_name: "Sara Ahmed", email: null, phone_number: null } as SocialContact;
    const bare = { ...row, email: null, phone_number: null, display_name: "No Id" } as SocialContact;
    const lines = buildMetaAudienceCsv([fb, bare]).split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(",,Sara,Ahmed,102227720640048");
  });
});
