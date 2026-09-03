import { describe, expect, it } from "vitest";
import {
  accountNoun,
  accountPlaceholder,
  connectedAccountsFor,
  connectedCountByPlatform,
  reconnectNeededCount,
  type SelectableAccount,
} from "../accountChoices";

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();
const NEXT_YEAR = new Date(Date.now() + 365 * 86_400_000).toISOString();

function account(overrides: Partial<SelectableAccount> & { id: string }): SelectableAccount {
  return {
    platform: "facebook",
    platform_username: overrides.id,
    avatar_url: null,
    is_active: true,
    needs_reauth: false,
    token_expires_at: NEXT_YEAR,
    ...overrides,
  };
}

// The shape the production picker was showing before this fix: everything in one list.
const ACCOUNTS: SelectableAccount[] = [
  account({ id: "fb-page" }),
  account({ id: "fb-stale", needs_reauth: true }),
  account({ id: "fb-off", is_active: false }),
  // Expired but not yet flagged: `needs_reauth` is written by the health cron, so this is what
  // an account looks like between its token dying and the cron next running.
  account({ id: "fb-expired", token_expires_at: YESTERDAY }),
  // Facebook page tokens do not expire, and a null column means exactly that -- not "unknown".
  account({ id: "ig-live", platform: "instagram", token_expires_at: null }),
  account({ id: "th-live", platform: "threads" }),
  account({ id: "th-stale", platform: "threads", needs_reauth: true }),
  account({ id: "tiktok", platform: "tiktok" }),
];

describe("connectedAccountsFor", () => {
  it("offers only the chosen platform's working accounts", () => {
    // The reported bug: picking Facebook listed Threads accounts, and listed ones whose token
    // had died -- a funnel bound to those matches comments and then fails every send.
    expect(connectedAccountsFor(ACCOUNTS, "facebook").map((row) => row.id)).toEqual(["fb-page"]);
    // A never-expiring token is offered; a null column is not treated as unknown.
    expect(connectedAccountsFor(ACCOUNTS, "instagram").map((row) => row.id)).toEqual(["ig-live"]);
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
  it("counts only working accounts, and only the comment platforms", () => {
    expect(connectedCountByPlatform(ACCOUNTS)).toEqual({ facebook: 1, instagram: 1, threads: 1, youtube: 0 });
  });
});

describe("reconnectNeededCount", () => {
  it("counts what was left out, excluding one still shown for editing", () => {
    expect(reconnectNeededCount(ACCOUNTS, "threads")).toBe(1);
    expect(reconnectNeededCount(ACCOUNTS, "threads", "th-stale")).toBe(0);
    // Deactivated, reauth-flagged and expired: all three are unusable, and all were listed before.
    expect(reconnectNeededCount(ACCOUNTS, "facebook")).toBe(3);
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

// Production 2026-09-04: every native YouTube row has token_expires_at in the past because
// YouTube refreshes just-in-time and is excluded from the refresh cron. Reading expiry as
// "disconnected" would hide every channel; the scope is what actually decides.
it("judges YouTube by the comments scope, not by token expiry", () => {
  const scope = "https://www.googleapis.com/auth/youtube.force-ssl";
  const rows = [
    account({ id: "yt-capable", platform: "youtube", token_expires_at: YESTERDAY, auth_provider: "native", account_metadata: { granted_scopes: [scope] } }),
    account({ id: "yt-old", platform: "youtube", token_expires_at: NEXT_YEAR, auth_provider: "native", account_metadata: {} }),
    account({ id: "yt-composio", platform: "youtube", token_expires_at: null, auth_provider: "composio", account_metadata: {} }),
  ];
  expect(connectedAccountsFor(rows, "youtube").map((r) => r.id)).toEqual(["yt-capable", "yt-composio"]);
  expect(reconnectNeededCount(rows, "youtube")).toBe(1);
  expect(connectedCountByPlatform(rows).youtube).toBe(2);
  expect(accountPlaceholder("youtube")).toBe("Choose a YouTube channel");
  expect(accountNoun("youtube", 2)).toBe("channels");
});
