import { describe, expect, it } from "vitest";
import {
  agentAccounts,
  effectiveToolAccountIds,
  nextToolSharing,
  type SharingAccount,
  type ToolAccountLink,
} from "../accountSharing";

// The connector flavour of the sharing model knowledgeSharing.ts shipped: an
// owning account that is always on (spec §12.2). The owning account resolves
// through ai_agent_tools.social_account_id, so it must never appear in the ids
// sent to set_tool_accounts — a link row for it would be a second, silently
// divergent source of one fact. These tests pin that asymmetry; everything
// else behaves exactly like the knowledge strip, whose tests live next door in
// knowledgeSharing.test.ts and must keep passing unchanged.

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

// A connector owned by the WhatsApp account. Ownership is the always-on part.
const ownedByWa = { id: "t1", scope: "account", social_account_id: "wa-1" } as const;

const links = (...ids: string[]): ToolAccountLink[] =>
  ids.map((social_account_id) => ({ tool_id: "t1", social_account_id }));

describe("effectiveToolAccountIds", () => {
  it("includes the owning account with no link row at all", () => {
    // The owner resolves through social_account_id, not through the link
    // table, so a connector shared with nobody still reaches its own agent.
    expect(effectiveToolAccountIds(ownedByWa, AGENTS, [])).toEqual(["wa-1"]);
  });

  it("lists the owner alongside explicit shares, in account order", () => {
    expect(effectiveToolAccountIds(ownedByWa, AGENTS, links("fb-1"))).toEqual([
      "wa-1",
      "fb-1",
    ]);
  });

  it("materialises an all_accounts tool as every agent account", () => {
    // scope='all_accounts' is the connector twin of visibility='shared': the
    // strip must show it as reaching everyone, including the owner.
    expect(
      effectiveToolAccountIds(
        { id: "t1", scope: "all_accounts", social_account_id: null },
        AGENTS,
        [],
      ),
    ).toEqual(["wa-1", "fb-1", "fb-2", "ig-1"]);
  });

  it("ignores the strip's platform filter — sharing crosses platforms", () => {
    // A WhatsApp-owned connector shared with an Instagram page is the whole
    // point of §12; the effective set is not narrowed to the owner's platform.
    expect(agentAccounts(ALL).map((a) => a.id)).toEqual([
      "wa-1",
      "fb-1",
      "fb-2",
      "ig-1",
    ]);
  });
});

describe("nextToolSharing", () => {
  it("never writes the owner as a link, even when ticking a fresh account", () => {
    expect(
      nextToolSharing({
        tool: ownedByWa,
        accounts: AGENTS,
        links: [],
        accountId: "ig-1",
        checked: true,
      }),
    ).toEqual(["ig-1"]);
  });

  it("unticking another account never removes the owner", () => {
    // The write drops only the unticked account; recomputed from the new link
    // set, the owner is still effective — ownership is not a share to lose.
    const write = nextToolSharing({
      tool: ownedByWa,
      accounts: AGENTS,
      links: links("fb-1", "ig-1"),
      accountId: "ig-1",
      checked: false,
    });
    expect(write).toEqual(["fb-1"]);
    expect(effectiveToolAccountIds(ownedByWa, AGENTS, links(...write))).toEqual([
      "wa-1",
      "fb-1",
    ]);
  });

  it("unticking the last share leaves the owner reachable and writes an empty set", () => {
    // Unlike knowledge sources, a connector can never be stranded: the owner
    // always resolves, so an empty link list is a legal, meaningful write.
    const write = nextToolSharing({
      tool: ownedByWa,
      accounts: AGENTS,
      links: links("fb-1"),
      accountId: "fb-1",
      checked: false,
    });
    expect(write).toEqual([]);
    expect(effectiveToolAccountIds(ownedByWa, AGENTS, [])).toEqual(["wa-1"]);
  });

  it("sends the complete account list, not a delta", () => {
    // set_tool_accounts REPLACES the whole link set. Sending only the ticked
    // id would strip the connector from every other agent — the exact
    // regression AiKnowledgeManager.sharing.test.tsx exists for.
    expect(
      nextToolSharing({
        tool: ownedByWa,
        accounts: AGENTS,
        links: links("fb-1", "fb-2"),
        accountId: "ig-1",
        checked: true,
      }),
    ).toEqual(["fb-1", "fb-2", "ig-1"]);
  });

  it("never re-adds an account that cannot run an agent", () => {
    // A stale TikTok link has no checkbox to remove it with; letting it
    // survive the write would be an unremovable grant.
    expect(
      nextToolSharing({
        tool: ownedByWa,
        accounts: AGENTS,
        links: links("tt-1", "fb-1"),
        accountId: "ig-1",
        checked: true,
      }),
    ).toEqual(["fb-1", "ig-1"]);
  });

  it("orders the written ids by account, not by toggle history", () => {
    expect(
      nextToolSharing({
        tool: ownedByWa,
        accounts: AGENTS,
        links: links("ig-1"),
        accountId: "fb-1",
        checked: true,
      }),
    ).toEqual(["fb-1", "ig-1"]);
  });

  it("keeps the owner effective even if a caller tries to untick it", () => {
    // The strip renders the owner's box disabled, but the pure function must
    // not depend on that: an owner id in the toggle position changes nothing.
    const write = nextToolSharing({
      tool: ownedByWa,
      accounts: AGENTS,
      links: links("fb-1"),
      accountId: "wa-1",
      checked: false,
    });
    expect(write).toEqual(["fb-1"]);
    expect(effectiveToolAccountIds(ownedByWa, AGENTS, links("fb-1"))).toEqual([
      "wa-1",
      "fb-1",
    ]);
  });
});
