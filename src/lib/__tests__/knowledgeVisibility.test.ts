import { describe, expect, it } from "vitest";
import { visibleToAccount } from "@/lib/knowledgeVisibility";

const shared = { id: "s1", visibility: "shared" as const };
const restricted = { id: "s2", visibility: "restricted" as const };

describe("visibleToAccount", () => {
  it("shows a shared source to an account with no links", () => {
    expect(visibleToAccount(shared, "a1", [])).toBe(true);
  });

  it("hides a restricted source from an unlinked account", () => {
    expect(visibleToAccount(restricted, "a1", [])).toBe(false);
  });

  it("shows a restricted source to a linked account", () => {
    expect(
      visibleToAccount(restricted, "a1", [{ source_id: "s2", social_account_id: "a1" }]),
    ).toBe(true);
  });

  it("does not let another account's link grant visibility", () => {
    expect(
      visibleToAccount(restricted, "a1", [{ source_id: "s2", social_account_id: "a2" }]),
    ).toBe(false);
  });

  it("does not let a link to a different source grant visibility", () => {
    expect(
      visibleToAccount(restricted, "a1", [{ source_id: "s9", social_account_id: "a1" }]),
    ).toBe(false);
  });

  it("is monotonic: adding a link never removes access", () => {
    // The rule this replaced was keyed on the account having ZERO links, so
    // adding the first link SHRANK it from the whole corpus to one document, and
    // removing the last link GRANTED it everything. Permission-shaped state must
    // never behave that way.
    expect(visibleToAccount(shared, "a1", [])).toBe(true);
    expect(
      visibleToAccount(shared, "a1", [{ source_id: "s9", social_account_id: "a1" }]),
    ).toBe(true);
  });

  it("shows everything when no account is selected", () => {
    // The library view with no account chosen is a management surface, not a
    // retrieval surface, and must not hide rows the user owns. This is the one
    // deliberate divergence from the retrieval RPCs, which return nothing for a
    // null account.
    expect(visibleToAccount(restricted, null, [])).toBe(true);
  });
});
