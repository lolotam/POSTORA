import { describe, expect, it } from "vitest";
import {
  grantedScopes,
  splitScopeString,
  YOUTUBE_COMMENT_SCOPE,
  youtubeCommentCapability,
} from "../youtubeCommentCapability";

// The production shape on 2026-09-04: four native rows with `{}` metadata (connected before
// scopes were recorded) and one Composio row. Both providers must be judged by what they can
// actually do, not by whether a token column is filled — Composio rows have none.
const cases: Array<[string, Parameters<typeof youtubeCommentCapability>[0], string]> = [
  ["composio row is capable regardless of metadata", { auth_provider: "composio", account_metadata: {} }, "capable"],
  ["native row with force-ssl granted", { auth_provider: "native", account_metadata: { granted_scopes: ["https://www.googleapis.com/auth/youtube.upload", YOUTUBE_COMMENT_SCOPE] } }, "capable"],
  ["native row connected before scopes were recorded", { auth_provider: "native", account_metadata: {} }, "reconnect_required"],
  ["native row with the old two scopes", { auth_provider: "native", account_metadata: { granted_scopes: ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"] } }, "reconnect_required"],
  ["auth_provider absent means native", { account_metadata: null }, "reconnect_required"],
];

describe("youtubeCommentCapability", () => {
  it.each(cases)("%s", (_name, account, expected) => {
    expect(youtubeCommentCapability(account)).toBe(expected);
  });

  it("grantedScopes ignores malformed metadata", () => {
    expect(grantedScopes(null)).toEqual([]);
    expect(grantedScopes({ granted_scopes: "not-an-array" })).toEqual([]);
    expect(grantedScopes({ granted_scopes: ["a", 1, "b"] })).toEqual(["a", "b"]);
  });

  it("splitScopeString splits Google's space-separated scope field", () => {
    expect(splitScopeString(" a  b ")).toEqual(["a", "b"]);
    expect(splitScopeString(undefined)).toEqual([]);
  });
});
