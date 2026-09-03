import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  grantedScopes,
  splitScopeString,
  YOUTUBE_COMMENT_SCOPE,
  youtubeCommentCapability,
} from "./youtubeCommentCapability.ts";

// The production shape on 2026-09-04: four native rows with `{}` metadata (connected before
// scopes were recorded) and one Composio row. Both providers must be judged by what they can
// actually do, not by whether a token column is filled — Composio rows have none.
const cases: Array<
  [string, Parameters<typeof youtubeCommentCapability>[0], string]
> = [
  [
    "composio row is capable regardless of metadata",
    { auth_provider: "composio", account_metadata: {} },
    "capable",
  ],
  [
    "native row with force-ssl granted",
    {
      auth_provider: "native",
      account_metadata: {
        granted_scopes: [
          "https://www.googleapis.com/auth/youtube.upload",
          YOUTUBE_COMMENT_SCOPE,
        ],
      },
    },
    "capable",
  ],
  [
    "native row connected before scopes were recorded",
    { auth_provider: "native", account_metadata: {} },
    "reconnect_required",
  ],
  [
    "native row with the old two scopes",
    {
      auth_provider: "native",
      account_metadata: {
        granted_scopes: [
          "https://www.googleapis.com/auth/youtube.readonly",
          "https://www.googleapis.com/auth/youtube.upload",
        ],
      },
    },
    "reconnect_required",
  ],
  [
    "auth_provider absent means native",
    { account_metadata: null },
    "reconnect_required",
  ],
];

for (const [name, account, expected] of cases) {
  Deno.test(`youtubeCommentCapability: ${name}`, () =>
    assertEquals(youtubeCommentCapability(account), expected));
}

Deno.test("grantedScopes ignores malformed metadata", () => {
  assertEquals(grantedScopes(null), []);
  assertEquals(grantedScopes({ granted_scopes: "not-an-array" }), []);
  assertEquals(grantedScopes({ granted_scopes: ["a", 1, "b"] }), ["a", "b"]);
});

Deno.test("splitScopeString splits Google's space-separated scope field", () => {
  assertEquals(splitScopeString(" a  b "), ["a", "b"]);
  assertEquals(splitScopeString(undefined), []);
});
