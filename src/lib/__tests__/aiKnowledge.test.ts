import { describe, expect, it } from "vitest";
import {
  aiKnowledgeContentType,
  aiKnowledgeObjectPath,
  aiKnowledgeStorageRef,
  getKnowledgeSourceType,
} from "@/lib/aiKnowledge";
import { validateAiToolName, validateAiToolUrl } from "@/lib/aiTools";

describe("AI knowledge file helpers", () => {
  it.each([
    ["catalog.csv", "csv"],
    ["catalog.xlsx", "excel"],
    ["catalog.xls", "excel"],
    ["pricelist.pdf", "pdf"],
    ["policies.txt", "doc"],
    ["faq.md", "doc"],
    ["menu.png", "image"],
    ["menu.JPG", "image"],
    ["banner.webp", "image"],
  ] as const)("maps %s", (name, type) =>
    expect(getKnowledgeSourceType(name)).toBe(type),
  );
  it("rejects unsupported extensions", () => {
    expect(getKnowledgeSourceType("archive.zip")).toBeNull();
    expect(getKnowledgeSourceType("presentation.docx")).toBeNull();
  });
});

describe("AI connector tool validation", () => {
  it("accepts a well-formed snake_case name and https URL", () => {
    expect(validateAiToolName("book_appointment")).toBeNull();
    expect(validateAiToolUrl("https://n8n.example.com/webhook/x")).toBeNull();
  });

  it.each(["Book_Appointment", "1tool", "ab", "has space", "has-dash"])(
    "rejects malformed name %s",
    (name) => expect(validateAiToolName(name)).not.toBeNull(),
  );

  it("rejects names that shadow builtin tools", () => {
    expect(validateAiToolName("escalate_to_human")).not.toBeNull();
    expect(validateAiToolName("create_scheduled_post")).not.toBeNull();
  });

  it("rejects non-https URLs", () => {
    expect(validateAiToolUrl("http://insecure.example.com/hook")).not.toBeNull();
    expect(validateAiToolUrl("not-a-url")).not.toBeNull();
  });
});

describe("AI knowledge upload locations", () => {
  const USER_ID = "11111111-1111-4111-8111-111111111111";

  it("puts the owner id first and keeps the extension", () => {
    // The leading user id is the ai-knowledge bucket's INSERT/SELECT policy
    // predicate (storage.foldername(name)[1] = auth.uid()) and the server's
    // owner-scope check. Reorder this and every upload starts failing RLS.
    expect(aiKnowledgeObjectPath(USER_ID, "Q3 Price List.XLSX", "obj-1")).toBe(
      `${USER_ID}/sources/obj-1.xlsx`,
    );
  });

  it("never carries the uploader's email address", () => {
    // The Cloudinary layout this replaced spelled the owner's email into the
    // public URL, which is half of what made those links worth leaking.
    const path = aiKnowledgeObjectPath(USER_ID, "profile.md", "obj-2");
    expect(path).not.toContain("@");
    expect(path).not.toContain("_at_");
  });

  it("builds the reference shape the ingestion functions parse", () => {
    expect(aiKnowledgeStorageRef(`${USER_ID}/sources/obj-3.csv`)).toBe(
      `supabase://ai-knowledge/${USER_ID}/sources/obj-3.csv`,
    );
  });
});

describe("AI knowledge upload content types", () => {
  // Regression: the first migration run rejected 11 of 15 files with
  // "mime type application/octet-stream is not supported". Cloudinary labels raw
  // .md that way and browsers report File.type as "" for it, so neither source
  // survives the bucket's allow-list. Every extension the picker accepts must
  // map to a type the bucket accepts.
  it.each([
    ["catalog.csv", "text/csv"],
    ["profile.md", "text/markdown"],
    ["notes.TXT", "text/plain"],
    ["prices.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["legacy.xls", "application/vnd.ms-excel"],
    ["terms.pdf", "application/pdf"],
    ["menu.JPG", "image/jpeg"],
    ["logo.png", "image/png"],
    ["banner.webp", "image/webp"],
  ] as const)("maps %s", (name, mime) => expect(aiKnowledgeContentType(name)).toBe(mime));

  it("falls back to a permitted type for a name with no extension", () => {
    expect(aiKnowledgeContentType("README")).toBe("text/plain");
  });
});
