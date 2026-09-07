import { describe, expect, it } from "vitest";
import {
  INBOX_ACCOUNT_PARAM,
  INBOX_CHAT_PARAM,
  INBOX_WORKSPACE_PARAM,
  buildInboxRoute,
  buildInboxRouteParams,
  parseInboxRoute,
  withInboxRoute,
} from "../whatsappInboxRoute";

const WORKSPACE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ACCOUNT_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const CHAT_ID = "cccccccc-0000-4000-8000-000000000003";

describe("whatsappInboxRoute", () => {
  it("keeps the param names that saved deep links depend on", () => {
    // These are a URL contract — renaming one silently breaks existing links.
    expect([INBOX_WORKSPACE_PARAM, INBOX_ACCOUNT_PARAM, INBOX_CHAT_PARAM]).toEqual([
      "ws",
      "account",
      "chat",
    ]);
  });

  it("round-trips a full selection", () => {
    const selection = {
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      conversationCacheId: CHAT_ID,
    };
    expect(parseInboxRoute(buildInboxRouteParams(selection))).toEqual(selection);
  });

  it("round-trips a partial selection without inventing missing parts", () => {
    const selection = { workspaceId: WORKSPACE_ID };
    expect(parseInboxRoute(buildInboxRouteParams(selection))).toEqual(selection);
  });

  it("parses from a raw query string", () => {
    expect(parseInboxRoute(`?chat=${CHAT_ID}`)).toEqual({ conversationCacheId: CHAT_ID });
  });

  it("drops malformed ids rather than throwing", () => {
    expect(parseInboxRoute("?ws=not-a-uuid&account=123&chat=")).toEqual({});
  });

  it("keeps the valid parts when one id is malformed", () => {
    expect(parseInboxRoute(`?ws=${WORKSPACE_ID}&chat=nonsense`)).toEqual({
      workspaceId: WORKSPACE_ID,
    });
  });

  it("normalises case so links copied from logs still resolve", () => {
    expect(parseInboxRoute(`?chat=${CHAT_ID.toUpperCase()}`)).toEqual({
      conversationCacheId: CHAT_ID,
    });
  });

  it("omits invalid ids when building", () => {
    const params = buildInboxRouteParams({
      workspaceId: WORKSPACE_ID,
      conversationCacheId: "bogus",
    });
    expect(params.get(INBOX_WORKSPACE_PARAM)).toBe(WORKSPACE_ID);
    expect(params.get(INBOX_CHAT_PARAM)).toBeNull();
  });

  it("builds a path with no query when nothing is selected", () => {
    expect(buildInboxRoute({})).toBe("/messaging/whatsapp/conversations");
  });

  it("builds a deep link a deal card can navigate to", () => {
    expect(buildInboxRoute({ accountId: ACCOUNT_ID, conversationCacheId: CHAT_ID })).toBe(
      `/messaging/whatsapp/conversations?account=${ACCOUNT_ID}&chat=${CHAT_ID}`,
    );
  });

  it("preserves unrelated params when merging a selection", () => {
    const existing = new URLSearchParams("label=vip&tab=open");
    const merged = withInboxRoute(existing, { conversationCacheId: CHAT_ID });

    expect(merged.get("label")).toBe("vip");
    expect(merged.get("tab")).toBe("open");
    expect(merged.get(INBOX_CHAT_PARAM)).toBe(CHAT_ID);
  });

  it("clears a param when the selection no longer has it", () => {
    const existing = new URLSearchParams(`chat=${CHAT_ID}&label=vip`);
    const merged = withInboxRoute(existing, { conversationCacheId: undefined });

    expect(merged.get(INBOX_CHAT_PARAM)).toBeNull();
    expect(merged.get("label")).toBe("vip");
  });

  it("preserves an existing workspace param when the selection omits workspaceId", () => {
    const existing = new URLSearchParams(`ws=${WORKSPACE_ID}&chat=${CHAT_ID}`);
    const merged = withInboxRoute(existing, { conversationCacheId: CHAT_ID });

    expect(merged.get(INBOX_WORKSPACE_PARAM)).toBe(WORKSPACE_ID);
    expect(merged.get(INBOX_CHAT_PARAM)).toBe(CHAT_ID);
  });
});
