import { describe, expect, it } from "vitest";
import { displaySourceTitle } from "@/lib/knowledgeSourceDisplay";

// The three UUIDs below are the real file_name values in production on
// 2026-08-30, not invented ones.
const ACCOUNTS = [
  { id: "c5c42a4d-f8d6-401e-858c-a73cfdee0002", platform_username: "postora.cloud" },
  {
    id: "e65ab2cd-37dd-4c5c-9137-c2113be97f1c",
    platform_username: null,
    platform_user_id: "17841",
  },
];

describe("displaySourceTitle", () => {
  it("replaces the account id with its username", () => {
    expect(
      displaySourceTitle(
        "Business profile (threads · c5c42a4d-f8d6-401e-858c-a73cfdee0002)",
        ACCOUNTS,
      ),
    ).toBe("Business profile (threads · postora.cloud)");
  });

  it("falls back to the platform user id when there is no username", () => {
    expect(
      displaySourceTitle(
        "Business profile (instagram · e65ab2cd-37dd-4c5c-9137-c2113be97f1c)",
        ACCOUNTS,
      ),
    ).toBe("Business profile (instagram · 17841)");
  });

  it("leaves the id in place when the account is unknown", () => {
    // A disconnected account must not become an unlabelled source -- the id is
    // worse to read but still identifies the row.
    const title = "Business profile (facebook · 00000000-0000-0000-0000-000000000000)";
    expect(displaySourceTitle(title, ACCOUNTS)).toBe(title);
  });

  it("leaves uploaded document names and platform-wide titles untouched", () => {
    expect(displaySourceTitle("README.md", ACCOUNTS)).toBe("README.md");
    expect(displaySourceTitle("Business profile (threads)", ACCOUNTS)).toBe(
      "Business profile (threads)",
    );
  });
});
