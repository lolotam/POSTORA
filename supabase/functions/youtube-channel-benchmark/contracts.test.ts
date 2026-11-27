import { assertEquals } from "jsr:@std/assert@1";
import {
  classifyBenchmarkChannelInput,
  isYouTubeBenchmarkErrorCode,
  normalizeBenchmarkChannelInput,
} from "./contracts.ts";

Deno.test("classifyBenchmarkChannelInput accepts valid handles and normalizes case", () => {
  const cases = [
    {
      raw: "  @GoogleDevelopers  ",
      expected: {
        kind: "handle",
        normalized: "@googledevelopers",
        queryValue: "@GoogleDevelopers",
      },
    },
    {
      raw: "@a_b.c-1",
      expected: {
        kind: "handle",
        normalized: "@a_b.c-1",
        queryValue: "@a_b.c-1",
      },
    },
    {
      raw: "  UC_x5XG1OV2P6uZZ5FSM9Ttw ",
      expected: {
        kind: "channel_id",
        normalized: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
        queryValue: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      },
    },
  ];

  for (const { raw, expected } of cases) {
    assertEquals(classifyBenchmarkChannelInput(raw), expected);
  }
});

Deno.test("classifyBenchmarkChannelInput rejects malformed handles, URLs, and wrong-length IDs", () => {
  const invalid = [
    "",
    "   ",
    "@ab", // too short (2 chars after @, minimum 3)
    "@" + "a".repeat(31), // too long (31 chars after @, maximum 30)
    "@bad handle",
    "@bad/handle",
    "GoogleDevelopers", // missing @
    "https://youtube.com/@GoogleDevelopers",
    "UCshort",
    "XC_x5XG1OV2P6uZZ5FSM9Ttw", // wrong prefix (must be UC)
    "UC_x5XG1OV2P6uZZ5FSM9TtwX", // 25 chars instead of 24
    "UC_x5XG1OV2P6uZZ5FSM9Tt!", // invalid char
  ];

  for (const raw of invalid) {
    assertEquals(classifyBenchmarkChannelInput(raw), null, `expected null for ${raw}`);
  }
});

Deno.test("normalizeBenchmarkChannelInput lowercases handles and preserves channel ID case", () => {
  assertEquals(normalizeBenchmarkChannelInput("  @YouTube "), "@youtube");
  assertEquals(
    normalizeBenchmarkChannelInput("  UC_x5XG1OV2P6uZZ5FSM9Ttw "),
    "UC_x5XG1OV2P6uZZ5FSM9Ttw",
  );
});

Deno.test("isYouTubeBenchmarkErrorCode recognizes known codes and rejects others", () => {
  assertEquals(isYouTubeBenchmarkErrorCode("unauthenticated"), true);
  assertEquals(isYouTubeBenchmarkErrorCode("quota_exceeded"), true);
  assertEquals(isYouTubeBenchmarkErrorCode("toString"), false);
  assertEquals(isYouTubeBenchmarkErrorCode("unknown_code"), false);
  assertEquals(isYouTubeBenchmarkErrorCode(404), false);
});
