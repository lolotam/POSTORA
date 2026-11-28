import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  scoreMobileLength,
  validatePackagingModelOutput,
} from "./youtubePackagingScore.ts";

Deno.test("scoreMobileLength scores boundaries deterministically", () => {
  assertEquals(scoreMobileLength(""), 0);
  assertEquals(scoreMobileLength("   "), 0);
  assertEquals(scoreMobileLength("Short title"), 100);
  assertEquals(scoreMobileLength("x".repeat(60)), 100);
  assertEquals(scoreMobileLength(`  ${"x".repeat(60)}  `), 100);
  assertEquals(scoreMobileLength("x".repeat(80)), 50);
  assertEquals(scoreMobileLength("x".repeat(95)), 13);
  assertEquals(scoreMobileLength("x".repeat(100)), 0);
  assertEquals(scoreMobileLength("x".repeat(120)), 0);
});

Deno.test("validatePackagingModelOutput computes overall_score with thumbnail_synergy when hasThumbnailText is true", () => {
  const result = validatePackagingModelOutput(
    {
      overall_score: 12, // model-supplied value must be ignored
      breakdown: {
        hook: 80,
        clarity: 90,
        mobile_length: 5, // model-supplied value must be ignored
        thumbnail_synergy: 70,
      },
      strengths: ["Clear promise\u0000", "Strong curiosity gap"],
      fixes: ["Move the keyword earlier"],
      better_titles: [
        "How We Cut Cloud Costs by 60% in One Week",
        "The 60% Cloud Bill Fix Most Teams Miss",
        "Stop Overpaying for Cloud: Our 7-Day Reset",
      ],
    },
    {
      title: "How We Reduced Our Cloud Bill",
      hasThumbnailText: true,
    },
  );

  assert(result.ok);
  // mobile_length = 100 (title is 29 chars <= 60)
  // overall = round((80*35 + 90*30 + 100*15 + 70*20) / 100) = round((2800 + 2700 + 1500 + 1400) / 100) = 84
  assertEquals(result.value, {
    overall_score: 84,
    breakdown: {
      hook: 80,
      clarity: 90,
      mobile_length: 100,
      thumbnail_synergy: 70,
    },
    strengths: ["Clear promise", "Strong curiosity gap"],
    fixes: ["Move the keyword earlier"],
    better_titles: [
      "How We Cut Cloud Costs by 60% in One Week",
      "The 60% Cloud Bill Fix Most Teams Miss",
      "Stop Overpaying for Cloud: Our 7-Day Reset",
    ],
  });
});

Deno.test("validatePackagingModelOutput forces thumbnail_synergy to null and rescales weights over 80 when hasThumbnailText is false", () => {
  const result = validatePackagingModelOutput(
    {
      breakdown: {
        hook: 80,
        clarity: 60,
        thumbnail_synergy: 99, // must be forced to null
      },
      strengths: [],
      fixes: [],
      better_titles: ["Alternative Title One", "Alternative Title Two", "Alternative Title Three"],
    },
    {
      title: "x".repeat(80), // mobile_length = 50
      hasThumbnailText: false,
    },
  );

  assert(result.ok);
  assertEquals(result.value.breakdown.thumbnail_synergy, null);
  assertEquals(result.value.breakdown.mobile_length, 50);
  // overall = round((80*35 + 60*30 + 50*15) / 80) = round((2800 + 1800 + 750) / 80) = round(5350 / 80) = round(66.875) = 67
  assertEquals(result.value.overall_score, 67);
});

Deno.test("validatePackagingModelOutput requires integer 0..100 thumbnail_synergy when hasThumbnailText is true (D-P7-7)", () => {
  const base = {
    strengths: ["Good"],
    fixes: ["Fix"],
    better_titles: ["Alt 1", "Alt 2", "Alt 3"],
  };

  for (const invalidSynergy of [undefined, null, 75.5, -1, 101, "80", NaN]) {
    const res = validatePackagingModelOutput(
      {
        ...base,
        breakdown: {
          hook: 80,
          clarity: 80,
          thumbnail_synergy: invalidSynergy,
        },
      },
      { title: "Original Title", hasThumbnailText: true },
    );
    assertEquals(res, { ok: false, reason: "bad_score" });
  }
});

Deno.test("validatePackagingModelOutput rejects non-integer or out-of-range hook and clarity scores", () => {
  const base = {
    strengths: ["Good"],
    fixes: ["Fix"],
    better_titles: ["Alt 1", "Alt 2", "Alt 3"],
  };

  for (const badScore of [-1, 101, 50.2, "80", null, undefined, NaN]) {
    assertEquals(
      validatePackagingModelOutput(
        { ...base, breakdown: { hook: badScore, clarity: 80, thumbnail_synergy: null } },
        { title: "Original Title", hasThumbnailText: false },
      ),
      { ok: false, reason: "bad_score" },
    );
    assertEquals(
      validatePackagingModelOutput(
        { ...base, breakdown: { hook: 80, clarity: badScore, thumbnail_synergy: null } },
        { title: "Original Title", hasThumbnailText: false },
      ),
      { ok: false, reason: "bad_score" },
    );
  }
});

Deno.test("validatePackagingModelOutput rejects invalid better_titles", () => {
  const validBase = {
    breakdown: { hook: 80, clarity: 80, thumbnail_synergy: null },
    strengths: ["Good"],
    fixes: ["Fix"],
  };

  // Fewer or more than 3 titles
  assertEquals(
    validatePackagingModelOutput(
      { ...validBase, better_titles: ["One", "Two"] },
      { title: "Original", hasThumbnailText: false },
    ),
    { ok: false, reason: "bad_title" },
  );
  assertEquals(
    validatePackagingModelOutput(
      { ...validBase, better_titles: ["One", "Two", "Three", "Four"] },
      { title: "Original", hasThumbnailText: false },
    ),
    { ok: false, reason: "bad_title" },
  );

  // Duplicate among better_titles (case-insensitive)
  assertEquals(
    validatePackagingModelOutput(
      { ...validBase, better_titles: ["Same Title", "same title", "Third Title"] },
      { title: "Original", hasThumbnailText: false },
    ),
    { ok: false, reason: "bad_title" },
  );

  // Same as input.title (case-insensitive)
  assertEquals(
    validatePackagingModelOutput(
      { ...validBase, better_titles: ["original title", "Second Title", "Third Title"] },
      { title: "  Original Title  ", hasThumbnailText: false },
    ),
    { ok: false, reason: "bad_title" },
  );

  // Over 100 chars, empty, multiline, or angle brackets
  for (const badTitle of ["x".repeat(101), "   ", "Line 1\nLine 2", "Line 1\rLine 2", "Bad <script> Title", "Title > 10"]) {
    assertEquals(
      validatePackagingModelOutput(
        { ...validBase, better_titles: [badTitle, "Second Title", "Third Title"] },
        { title: "Original", hasThumbnailText: false },
      ),
      { ok: false, reason: "bad_title" },
    );
  }
});

Deno.test("validatePackagingModelOutput rejects invalid strengths and fixes", () => {
  const validBase = {
    breakdown: { hook: 80, clarity: 80, thumbnail_synergy: null },
    better_titles: ["Alt 1", "Alt 2", "Alt 3"],
  };

  // More than 3 items
  assertEquals(
    validatePackagingModelOutput(
      { ...validBase, strengths: ["1", "2", "3", "4"], fixes: [] },
      { title: "Original", hasThumbnailText: false },
    ),
    { ok: false, reason: "bad_text" },
  );

  // Empty, > 140 chars, or angle brackets
  for (const badText of ["   ", "\u0000\u0007", "x".repeat(141), "Contains < tag", "Contains > tag"]) {
    assertEquals(
      validatePackagingModelOutput(
        { ...validBase, strengths: [badText], fixes: [] },
        { title: "Original", hasThumbnailText: false },
      ),
      { ok: false, reason: "bad_text" },
    );
    assertEquals(
      validatePackagingModelOutput(
        { ...validBase, strengths: [], fixes: [badText] },
        { title: "Original", hasThumbnailText: false },
      ),
      { ok: false, reason: "bad_text" },
    );
  }
});

Deno.test("validatePackagingModelOutput rejects malformed shapes", () => {
  for (const badRaw of [
    null,
    undefined,
    "not an object",
    [],
    { breakdown: "not-an-object", strengths: [], fixes: [], better_titles: ["1", "2", "3"] },
    { breakdown: { hook: 80, clarity: 80 }, strengths: "not-array", fixes: [], better_titles: ["1", "2", "3"] },
    { breakdown: { hook: 80, clarity: 80 }, strengths: [], fixes: null, better_titles: ["1", "2", "3"] },
    { breakdown: { hook: 80, clarity: 80 }, strengths: [], fixes: [] },
  ]) {
    assertEquals(
      validatePackagingModelOutput(badRaw, { title: "Original", hasThumbnailText: false }),
      { ok: false, reason: "bad_shape" },
    );
  }
});
