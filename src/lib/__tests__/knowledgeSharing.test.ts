import { describe, expect, it } from "vitest";
import {
  agentAccounts,
  effectiveAccountIds,
  nextSharing,
  type SharingAccount,
} from "../knowledgeSharing";

const account = (id: string, platform: string, name: string): SharingAccount => ({
  id,
  platform,
  platform_username: name,
  platform_user_id: null,
});

const WA = account("wa-1", "whatsapp", "Xsellpoint");
const FB_A = account("fb-1", "facebook", "Page A");
const FB_B = account("fb-2", "facebook", "Page B");
const IG = account("ig-1", "instagram", "xsellpoint_kw");
const TIKTOK = account("tt-1", "tiktok", "xsellpoint");

const ALL = [WA, FB_A, FB_B, IG, TIKTOK];
const AGENTS = [WA, FB_A, FB_B, IG];

describe("agentAccounts", () => {
  it("keeps only the platforms an agent can actually answer on", () => {
    // A TikTok account has no agent and no inbox, so offering to share
    // knowledge with it would promise retrieval that can never happen.
    expect(agentAccounts(ALL).map((a) => a.id)).toEqual(["wa-1", "fb-1", "fb-2", "ig-1"]);
  });
});

describe("effectiveAccountIds", () => {
  it("reads a shared source as every agent account", () => {
    // 'shared' means "every account of the owner", so the checkbox strip must
    // show it as such -- not as zero links, which is what the table holds.
    expect(effectiveAccountIds({ id: "s1", visibility: "shared" }, AGENTS, [])).toEqual([
      "wa-1",
      "fb-1",
      "fb-2",
      "ig-1",
    ]);
  });

  it("reads a restricted source as exactly its links", () => {
    expect(
      effectiveAccountIds({ id: "s1", visibility: "restricted" }, AGENTS, [
        { source_id: "s1", social_account_id: "fb-1" },
        { source_id: "s2", social_account_id: "ig-1" },
      ]),
    ).toEqual(["fb-1"]);
  });

  it("drops a link to an account that can no longer run an agent", () => {
    // Otherwise a disconnected or non-agent account would be counted towards
    // "all accounts are checked" while having no checkbox to uncheck.
    expect(
      effectiveAccountIds({ id: "s1", visibility: "restricted" }, AGENTS, [
        { source_id: "s1", social_account_id: "tt-1" },
      ]),
    ).toEqual([]);
  });
});

describe("nextSharing", () => {
  const shared = { id: "s1", visibility: "shared" } as const;
  const restricted = { id: "s1", visibility: "restricted" } as const;

  it("sharing a restricted source with another account adds that account", () => {
    // The whole point of the feature: the file was uploaded under Facebook and
    // is now readable by the Instagram agent, with no second upload.
    expect(
      nextSharing({
        source: restricted,
        accounts: AGENTS,
        links: [{ source_id: "s1", social_account_id: "fb-1" }],
        accountId: "ig-1",
        checked: true,
      }),
    ).toEqual({ visibility: "restricted", social_account_ids: ["fb-1", "ig-1"] });
  });

  it("unsharing removes only that account", () => {
    expect(
      nextSharing({
        source: restricted,
        accounts: AGENTS,
        links: [
          { source_id: "s1", social_account_id: "fb-1" },
          { source_id: "s1", social_account_id: "ig-1" },
        ],
        accountId: "ig-1",
        checked: false,
      }),
    ).toEqual({ visibility: "restricted", social_account_ids: ["fb-1"] });
  });

  it("unchecking one box on a shared source keeps every other account", () => {
    // A shared source holds NO links, so the write has to materialise the
    // implicit set first. Sending only the unchecked id -- or an empty list --
    // would silently strip the source from every other agent.
    expect(
      nextSharing({
        source: shared,
        accounts: AGENTS,
        links: [],
        accountId: "ig-1",
        checked: false,
      }),
    ).toEqual({
      visibility: "restricted",
      social_account_ids: ["wa-1", "fb-1", "fb-2"],
    });
  });

  it("re-checking every account stays restricted rather than promoting to shared", () => {
    // 'shared' also covers accounts connected LATER. Silently re-granting that
    // from a checkbox would hand a future brand a document nobody chose to give
    // it, so an explicit link set is kept even when it currently covers all.
    expect(
      nextSharing({
        source: restricted,
        accounts: AGENTS,
        links: [
          { source_id: "s1", social_account_id: "wa-1" },
          { source_id: "s1", social_account_id: "fb-1" },
          { source_id: "s1", social_account_id: "fb-2" },
        ],
        accountId: "ig-1",
        checked: true,
      }),
    ).toEqual({
      visibility: "restricted",
      social_account_ids: ["wa-1", "fb-1", "fb-2", "ig-1"],
    });
  });

  it("unchecking the last account is legal and leaves no links", () => {
    // Restricted with zero links is readable by nobody. The RPC accepts it
    // deliberately -- it is how a source is retired without deleting it -- so
    // the helper must produce it rather than refuse.
    expect(
      nextSharing({
        source: restricted,
        accounts: AGENTS,
        links: [{ source_id: "s1", social_account_id: "fb-1" }],
        accountId: "fb-1",
        checked: false,
      }),
    ).toEqual({ visibility: "restricted", social_account_ids: [] });
  });

  it("orders the written ids by account, not by toggle history", () => {
    // A stable order makes the request body comparable between renders, so a
    // repeated toggle cannot look like a different write.
    expect(
      nextSharing({
        source: restricted,
        accounts: AGENTS,
        links: [{ source_id: "s1", social_account_id: "ig-1" }],
        accountId: "wa-1",
        checked: true,
      }).social_account_ids,
    ).toEqual(["wa-1", "ig-1"]);
  });

  it("never re-adds an account that already lost its agent", () => {
    // The strip cannot show a TikTok checkbox, so a stale TikTok link must not
    // survive the next write either -- it would be an unremovable grant.
    expect(
      nextSharing({
        source: restricted,
        accounts: AGENTS,
        links: [
          { source_id: "s1", social_account_id: "tt-1" },
          { source_id: "s1", social_account_id: "fb-1" },
        ],
        accountId: "ig-1",
        checked: true,
      }).social_account_ids,
    ).toEqual(["fb-1", "ig-1"]);
  });
});
