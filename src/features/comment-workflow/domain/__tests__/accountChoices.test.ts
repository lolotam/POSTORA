import { describe, expect, it } from "vitest";
import {
  accountNoun,
  accountPlaceholder,
  connectedAccountsFor,
  connectedCountByPlatform,
  reconnectNeededCount,
  type SelectableAccount,
} from "../accountChoices";

function account(overrides: Partial<SelectableAccount> & { id: string }): SelectableAccount {
  return {
    platform: "facebook",
    platform_username: overrides.id,
    avatar_url: null,
    is_active: true,
    needs_reauth: false,
    ...overrides,
  };
}

// The shape the production picker was showing before this fix: everything in one list.
const ACCOUNTS: SelectableAccount[] = [
  account({ id: "fb-page" }),
  account({ id: "fb-stale", needs_reauth: true }),
  account({ id: "fb-off", is_active: false }),
  account({ id: "ig-live", platform: "instagram" }),
  account({ id: "th-live", platform: "threads" }),
  account({ id: "th-stale", platform: "threads", needs_reauth: true }),
  account({ id: "tiktok", platform: "tiktok" }),
];

describe("connectedAccountsFor", () => {
  it("offers only the chosen platform's working accounts", () => {
    // The reported bug: picking Facebook listed Threads accounts, and listed ones whose token
    // had died -- a funnel bound to those matches comments and then fails every send.
    expect(connectedAccountsFor(ACCOUNTS, "facebook").map((row) => row.id)).toEqual(["fb-page"]);
    expect(connectedAccountsFor(ACCOUNTS, "threads").map((row) => row.id)).toEqual(["th-live"]);
  });

  it("keeps the account a saved workflow is already bound to, even once it goes stale", () => {
    // Radix renders a blank trigger when the value matches no item, which would read as the
    // rule having lost its account rather than the account having gone stale.
    expect(connectedAccountsFor(ACCOUNTS, "threads", "th-stale").map((row) => row.id)).toEqual([
      "th-live",
      "th-stale",
    ]);
  });

  it("offers nothing until a platform is chosen", () => {
    expect(connectedAccountsFor(ACCOUNTS, "")).toEqual([]);
  });
});

describe("connectedCountByPlatform", () => {
  it("counts only working accounts, and only the three comment platforms", () => {
    expect(connectedCountByPlatform(ACCOUNTS)).toEqual({ facebook: 1, instagram: 1, threads: 1 });
  });
});

describe("reconnectNeededCount", () => {
  it("counts what was left out, excluding one still shown for editing", () => {
    expect(reconnectNeededCount(ACCOUNTS, "threads")).toBe(1);
    expect(reconnectNeededCount(ACCOUNTS, "threads", "th-stale")).toBe(0);
    // Deactivated as well as reauth-flagged: both are unusable, and both were listed before.
    expect(reconnectNeededCount(ACCOUNTS, "facebook")).toBe(2);
    expect(reconnectNeededCount(ACCOUNTS, "")).toBe(0);
  });
});

describe("copy", () => {
  it("calls a Facebook account a page and pluralises it", () => {
    expect(accountPlaceholder("facebook")).toBe("Choose a Facebook page");
    expect(accountPlaceholder("instagram")).toBe("Choose an Instagram account");
    expect(accountNoun("facebook", 2)).toBe("pages");
    expect(accountNoun("threads", 1)).toBe("account");
  });
});
