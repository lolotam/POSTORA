import { describe, expect, it } from "vitest";
import {
  buildAiKnowledgeStoragePath,
  getKnowledgeSourceType,
} from "@/lib/aiKnowledge";

describe("AI knowledge file helpers", () => {
  it.each([
    ["catalog.csv", "csv"],
    ["catalog.xlsx", "excel"],
    ["catalog.xls", "excel"],
  ] as const)("maps %s", (name, type) =>
    expect(getKnowledgeSourceType(name)).toBe(type),
  );
  it("rejects unsupported extensions", () =>
    expect(getKnowledgeSourceType("catalog.pdf")).toBeNull());
  it("scopes paths to the user and preserves the file name", () =>
    expect(buildAiKnowledgeStoragePath("user-1", "uuid", "Catalog.xlsx")).toBe(
      "user-1/uuid-Catalog.xlsx",
    ));
});
