import { describe, expect, it } from "vitest";
import { getKnowledgeSourceType } from "@/lib/aiKnowledge";
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
